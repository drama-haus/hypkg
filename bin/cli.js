#!/usr/bin/env node

const DEBUG = false;

const utils = require("../utils");

const { program, Command } = require("commander");
const execa = require("execa");
const inquirer = require("inquirer");
const ora = require("ora"); // For spinner animations
const chalk = require("chalk"); // For colored output
const path = require("path");
const fs = require("fs").promises;

const packageJson = require("../package.json");
const config = {
  patchesRepo: packageJson.config.patchesRepo,
  patchesRemote: packageJson.config.patchesRemoteName,
  targetRepo: packageJson.config.targetRepo,
  packageName: packageJson.name,
};

const PATCHES_REPO = packageJson.config.patchesRepo;
const PATCHES_REMOTE = packageJson.config.patchesRemoteName;
const TARGET_REPO = packageJson.config.targetRepo;
const PACKAGE_NAME = packageJson.name;
let BRANCH_NAME = PACKAGE_NAME;

// Utility function for consistent logging
function log(message, type = "info") {
  const prefix = {
    info: chalk.blue("ℹ"),
    success: chalk.green("✓"),
    warning: chalk.yellow("⚠"),
    error: chalk.red("✖"),
    step: chalk.cyan("→"),
  }[type];

  console.log(`${prefix} ${message}`);
}

async function applyPatch(patchName) {
  const spinner = ora(`Applying patch: ${patchName}`).start();
  const appliedPatches = await utils.getAppliedPatches();

  if (appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is already applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    spinner.text = "Finding patch commit...";
    const commit = await utils.execGit(
      ["rev-list", "-n", "1", `${PATCHES_REMOTE}/${patchName}`, "^HEAD"],
      `Failed to find commit for patch ${patchName}`
    );

    if (!commit) {
      spinner.fail(`No unique commits found in ${patchName}`);
      throw new Error(`No unique commits found in ${patchName}`);
    }

    try {
      spinner.text = "Applying patch changes...";
      await utils.execGit(
        ["cherry-pick", commit],
        "Failed to cherry-pick commit"
      );

      // Update commit message to track patch
      await utils.execGit(
        ["commit", "--amend", "-m", `${patchName}`],
        "Failed to update commit message"
      );

      spinner.succeed(`Successfully applied patch: ${patchName}`);
    } catch (cherryPickError) {
      spinner.warn("Cherry-pick failed, attempting alternative approach...");

      await utils.execGit(
        ["cherry-pick", "--abort"],
        "Failed to abort cherry-pick"
      );
      await utils.execGit(
        ["cherry-pick", "-n", commit],
        "Failed to cherry-pick commit"
      );

      spinner.text = "Handling package dependencies...";
      const handledLockConflict = await utils.handlePackageChanges();

      if (!handledLockConflict) {
        const hasOtherConflicts = await utils.execGit(
          ["diff", "--name-only", "--diff-filter=U"],
          "Failed to check conflicts"
        );

        if (hasOtherConflicts) {
          spinner.fail("Merge conflicts detected");
          throw new Error(
            "Merge conflicts detected in files other than package-lock.json"
          );
        }
      }

      spinner.text = "Committing changes...";
      await utils.execGit(["add", "."], "Failed to stage changes");
      await utils.execGit(
        ["commit", "-m", `cow_${patchName}`],
        "Failed to commit changes"
      );
    }
  } catch (error) {
    spinner.fail(`Failed to apply patch: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await utils.restoreGitState(initialState);
    throw error;
  }
}

async function removePatch(patchName) {
  const spinner = ora(`Removing patch: ${patchName}`).start();
  const appliedPatches = await utils.getAppliedPatches();
  if (!appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is not applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    const baseBranch = await utils.getBaseBranch();

    // Find the commit that applied this patch
    const patchCommit = await utils.execGit(
      ["log", "--grep", `^cow_${patchName}$`, "--format=%H"],
      "Failed to find patch commit"
    );

    if (!patchCommit) {
      throw new Error(`Could not find commit for patch ${patchName}`);
    }

    // Create temporary branch
    const tempBranch = `temp-${Date.now()}`;
    await utils.execGit(["branch", tempBranch], "Failed to create temp branch");

    // Reset to base branch
    await utils.execGit(
      ["reset", "--hard", baseBranch],
      "Failed to reset to base branch"
    );

    // Get all commits except the patch to remove
    const commits = await utils.execGit(
      ["log", `${baseBranch}..${tempBranch}`, "--format=%H %s"],
      "Failed to get commit list"
    );

    // Apply all commits except the patch commit
    for (const commitLine of commits.split("\n").reverse()) {
      if (!commitLine) continue;
      const [hash, ...messageParts] = commitLine.split(" ");
      const message = messageParts.join(" ");

      if (hash !== patchCommit) {
        try {
          await utils.execGit(
            ["cherry-pick", hash],
            "Failed to cherry-pick commit"
          );
        } catch (e) {
          await utils.execGit(
            ["cherry-pick", "--abort"],
            "Failed to abort cherry-pick"
          );
          await utils.execGit(
            ["cherry-pick", "-n", hash],
            "Failed to cherry-pick commit"
          );
          await utils.handlePackageChanges();
          await utils.execGit(["add", "."], "Failed to stage changes");
          await utils.execGit(
            ["commit", "-m", message],
            "Failed to commit changes"
          );
        }
      }
    }

    // Clean up temporary branch
    await utils.execGit(
      ["branch", "-D", tempBranch],
      "Failed to delete temp branch"
    );

    // Update dependencies
    await utils.handlePackageChanges();

    spinner.succeed(`Successfully removed patch: ${patchName}`);
  } catch (error) {
    spinner.fail(`Failed to remove patch: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await utils.restoreGitState(initialState);
    throw error;
  }
}

async function listPatches() {
  const appliedPatches = await utils.getAppliedPatches();

  console.log("\nCurrently applied patches:");
  if (appliedPatches.length === 0) {
    console.log("  No patches applied");
  } else {
    for (const patch of appliedPatches) {
      const displayName = patch.replace(`cow_`, "");
      const { author, relativeTime } = await getPatchInfo(displayName);
      console.log(`  - ${displayName} (by ${author}, ${relativeTime})`);
    }
  }
}

async function resetPatches() {
  const spinner = ora("Starting reset process...").start();
  try {
    const baseBranch = await utils.getBaseBranch();
    spinner.text =
      "Removing all patches and upgrading to latest base version...";

    // Get current branch name before proceeding
    const currentBranch = await utils.getCurrentBranch();

    // Get base branch upstream configuration
    let originalBaseBranch;
    try {
      const upstream = await utils.execGit(
        ["rev-parse", "--abbrev-ref", `${baseBranch}@{upstream}`],
        "Failed to get base branch upstream"
      );
      originalBaseBranch = upstream.replace("origin/", "");
      spinner.text = `Found base branch upstream: ${originalBaseBranch}`;
    } catch (e) {
      // No upstream set for base branch, use the base branch itself
      originalBaseBranch = baseBranch;
      spinner.text = `Using default base branch: ${baseBranch}`;
    }

    // Checkout and clean base branch
    await utils.execGit(
      ["checkout", baseBranch],
      "Failed to checkout base branch"
    );

    // Try to delete the current branch if it exists
    try {
      await utils.execGit(
        ["branch", "-D", currentBranch],
        "Failed to delete branch"
      );
      spinner.text = `Deleted branch ${currentBranch}`;
    } catch (e) {
      spinner.text = `Branch ${currentBranch} does not exist`;
    }

    // Sync with remote
    spinner.text = "Syncing with remote repository...";
    await utils.syncBranches();

    // Create new branch with the same name as before
    spinner.text = "Recreating branch...";
    await utils.execGit(
      ["checkout", "-b", currentBranch, baseBranch],
      "Failed to create new branch"
    );

    // Set up upstream tracking
    try {
      await utils.execGit(
        ["branch", `--set-upstream-to=${PATCHES_REMOTE}/${originalBaseBranch}`],
        "Failed to set upstream"
      );
    } catch (e) {
      spinner.text = "No remote branch found, creating new local branch";
    }

    await utils.setupPatchesRemote(config.patchesRepo, config.patchesRemote);

    spinner.succeed("Reset completed successfully!");
    await listPatches();
  } catch (error) {
    spinner.fail(`Reset failed: ${error.message}`);
    throw error;
  }
}

let PROJECT_PATH;
// Interactive setup functions
async function promptForNewProject() {
  const { projectName } = await inquirer.prompt([
    {
      type: "input",
      name: "projectName",
      message: "What is your project name?",
      default: path.basename(process.cwd()),
      validate: (input) => input.trim().length > 0,
    },
  ]);
  const projectPath = path.join(process.cwd(), projectName);

  // Create project directory
  await fs.mkdir(projectPath, { recursive: true });
  process.chdir(projectPath);
  PROJECT_PATH = projectPath;
  // Initialize git repo
  await utils.execGit(["init"], "Failed to initialize git repository");
  await utils.execGit(
    ["remote", "add", "origin", TARGET_REPO],
    "Failed to add origin remote"
  );
  return projectPath;
}

async function promptForBranch() {
  const currentBranch = await utils.getCurrentBranch();
  const branches = await utils.execGit(
    ["branch", "-a"],
    "Failed to list branches"
  );
  const availableBranches = branches
    .split("\n")
    .map((b) => b.trim().replace("* ", ""))
    .filter((b) => !b.startsWith("remotes/"));

  const { branch } = await inquirer.prompt([
    {
      type: "list",
      name: "branch",
      message: "Which branch would you like to use?",
      default: currentBranch,
      choices: availableBranches,
    },
  ]);

  return branch;
}

async function promptForPatches() {
  const patches = await searchPatches();
  if (patches.length === 0) {
    console.log("No patches available to apply.");
    return [];
  }

  const patchChoices = await Promise.all(
    patches.map(async (patch) => {
      const { author, relativeTime } = await getPatchInfo(patch);
      return {
        name: `${patch} (by ${author}, ${relativeTime})`,
        value: patch,
      };
    })
  );

  const { selectedPatches } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedPatches",
      message: "Select patches to apply:",
      choices: patchChoices,
      pageSize: 10,
    },
  ]);

  return selectedPatches;
}

// Modified install function with interactive setup
async function interactiveInstall() {
  try {
    // Check if we're in a git repository - no spinner needed for this quick check
    const isGitRepo = await fs
      .access(".git")
      .then(() => true)
      .catch(() => false);

    if (isGitRepo) {
      const spinner = ora("Checking repository...").start();
      try {
        await utils.verifyRepo();
        spinner.succeed("Found existing repository");
        // If we're in the correct repo, just run list command
        await listPatches();
        return;
      } catch (e) {
        spinner.fail("Not in the correct repository");
        console.log(
          "Please run this command in a new directory to set up a new project."
        );
        process.exit(1);
      }
    }

    // Stop any existing spinner before user input
    log("Setting up a new project...", "info");

    // Get project name and set up new repository - no spinner during user input
    const projectPath = await promptForNewProject();

    const projectName = path.basename(projectPath);
    BRANCH_NAME = projectName; // Use project name for the branch instead of package name

    // Now we can start using spinners again for operations
    let spinner = ora("Setting up repository...").start();

    // try {
    //   await utils.verifyRepo();
    //   spinner.succeed("Repository configured");
    // } catch (e) {
    //   // Configuration failed, but we'll set it up
    //   spinner.text = "Configuring repository...";
    //   await utils.execGit(
    //     ["remote", "add", "origin", TARGET_REPO],
    //     "Failed to add origin remote"
    //   );
    //   spinner.succeed("Repository configured");
    // }

    // Sync branches
    spinner.text = "Syncing branches...";
    await utils.syncBranches();
    spinner.succeed("Branches synced");

    // Stop spinner for branch selection
    spinner.stop();
    const selectedBranch = await promptForBranch();

    // Resume spinner for next operations
    spinner.start("Checking out selected branch...");
    await utils.execGit(
      ["checkout", selectedBranch],
      "Failed to checkout selected branch"
    );
    spinner.succeed("Branch checked out");

    await utils.setupPatchesRemote(config.patchesRepo, config.patchesRemote);

    // Setup patch management with selected branch
    spinner.start("Setting up patch management...");
    await utils.ensurePatchBranch(
      BRANCH_NAME, // The branch name you want to use (like projectName or PACKAGE_NAME)
      selectedBranch, // The branch selected by the user or default branch
      config.patchesRemote // The patches remote from your config
    );
    spinner.succeed("Patch management configured");

    spinner.start("Installing dependencies...");
    const npmInstall = await execa("npm", ["install"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(npmInstall.stdout, "info");
    spinner.succeed("Dependencies installed");

    // Stop spinner for patch selection
    spinner.stop();
    const selectedPatches = await promptForPatches();

    if (selectedPatches.length > 0) {
      for (const patch of selectedPatches) {
        await applyPatch(`cow_${patch}`);
      }
    }

    // Copy environment file
    spinner.start("Setting up environment...");
    try {
      await execa("cp", [".env.example", ".env"]);
      spinner.succeed("Environment configured");
    } catch (e) {
      spinner.info("No .env.example file found, skipping environment setup");
    }

    // Display final information
    log("\n🎮 Your game engine project is ready!", "success");
    log("Here's what you need to know:", "info");
    console.log(
      chalk.cyan(`
    Commands available:
    → npm run dev         - Start the development server
    → ${PACKAGE_NAME} list    - See your applied patches
    → ${PACKAGE_NAME} search  - Browse available patches
    → ${PACKAGE_NAME} patch   - Apply a new patch
    `)
    );

    await listPatches();

    log("\nStarting development server...", "step");

    // Start the development server
    try {
      await execa("npm", ["run", "dev"], {
        stdio: "inherit",
      });
    } catch (e) {
      if (e.exitCode === 130) {
        process.exit(0);
      }
      throw new Error(`Failed to start development server: ${e.message}`);
    }
  } catch (e) {
    console.error(chalk.red(`Setup failed: ${e.message}`));
    process.exit(1);
  }
}

async function searchPatches(searchTerm = "") {
  await utils.execGit(["remote", "update", PATCHES_REMOTE, "--prune"]);

  const branches = await utils.execGit(
    ["branch", "-a"],
    "Failed to list all branches"
  );

  const remoteBranches = branches
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`remotes/${PATCHES_REMOTE}/cow_`))
    .map((b) => b.replace(`remotes/${PATCHES_REMOTE}/`, ""))
    .map((b) => b.replace(`cow_`, "")); // Remove package prefix

  if (searchTerm) {
    return remoteBranches.filter((b) => b.includes(searchTerm));
  }
  return remoteBranches;
}

function getRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years}y ago`;
  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

async function getPatchInfo(branchName) {
  const fullBranchName = `${PATCHES_REMOTE}/cow_${branchName}`;
  const commitInfo = await utils.execGit(
    ["log", "-1", "--format=%an|%at", fullBranchName],
    `Failed to get commit info for ${branchName}`
  );

  const [author, timestamp] = commitInfo.split("|");
  const relativeTime = getRelativeTime(parseInt(timestamp) * 1000);

  return {
    author,
    relativeTime,
  };
}

// Convert Uint8Array to string
function ab2str(buf) {
  return String.fromCharCode.apply(null, buf);
}

async function extractHypFile(filePath) {
  try {
    // Read the .hyp file
    const buffer = await fs.readFile(filePath);
    const view = new DataView(buffer.buffer);

    // Read header size (first 4 bytes)
    const headerSize = view.getUint32(0, true);

    // Read and parse header
    const headerBytes = new Uint8Array(buffer.buffer.slice(4, 4 + headerSize));
    const header = JSON.parse(ab2str(headerBytes));

    // Create output directory based on input filename
    const baseDir = path.basename(filePath, ".hyp");
    await fs.mkdir(baseDir, { recursive: true });

    // Extract files
    let position = 4 + headerSize;

    console.log(`Extracting files from ${filePath}...`);
    console.log(`Found ${header.assets.length} assets:`);

    for (const assetInfo of header.assets) {
      const data = buffer.slice(position, position + assetInfo.size);
      const fileName = assetInfo.url.split("/").pop();
      const outputPath = path.join(baseDir, fileName);

      await fs.writeFile(outputPath, data);
      console.log(`- ${fileName} (${assetInfo.type}): ${assetInfo.size} bytes`);

      position += assetInfo.size;
    }

    // Save blueprint data
    const blueprintPath = path.join(baseDir, "blueprint.json");
    await fs.writeFile(
      blueprintPath,
      JSON.stringify(header.blueprint, null, 2)
    );
    console.log(`- blueprint.json: Blueprint data`);

    console.log(`\nFiles extracted to ./${baseDir}/`);
  } catch (error) {
    console.error("Error extracting .hyp file:", error.message);
    process.exit(1);
  }
}

program
  .name(PACKAGE_NAME)
  .description("Patch management system for game engine")
  .version(packageJson.version)
  .command("install")
  .description("Interactive installation of the game engine")
  .action(interactiveInstall);

program
  .command("app")
  .description("Hyperfy Apps Tools")
  .addCommand(
    new Command("pack")
      .description("packs arguments into a .hyp file")
      .action(async (args) => {
        console.log(args);
      })
  )
  .addCommand(
    new Command("extract <file>")
      .description("Extract contents of a .hyp file")
      .action(async (file) => {
        try {
          if (!file.endsWith(".hyp")) {
            throw new Error("Input file must have .hyp extension");
          }
          await extractHypFile(file);
        } catch (e) {
          console.error(`Failed to extract .hyp file: ${e.message}`);
          process.exit(1);
        }
      })
  );

// Developer commands subgroup
program
  .command("dev")
  .description("Developer commands for managing patches")
  .addCommand(
    new Command("init")
      .description("Initialize a new patch development environment")
      .argument("<patchName>", "name of the patch to develop")
      .action(async (patchName) => {
        try {
          const devBranch = `dev_cow_${patchName}`;
          const spinner = ora(
            `Initializing development environment for ${patchName}`
          ).start();

          try {
            const baseBranch = await utils.getBaseBranch();

            // Fetch latest changes
            await utils.execGit(["fetch", "origin"], "Failed to fetch updates");

            // Create dev branch if it doesn't exist
            const branches = await utils.execGit(
              ["branch"],
              "Failed to list branches"
            );
            if (!branches.includes(devBranch)) {
              await utils.execGit(
                ["checkout", "-b", devBranch, baseBranch],
                "Failed to create dev branch"
              );
            } else {
              await utils.execGit(
                ["checkout", devBranch],
                "Failed to checkout dev branch"
              );
            }

            spinner.succeed(
              `Development environment initialized for ${patchName}`
            );
          } catch (error) {
            spinner.fail(
              `Failed to initialize development environment: ${error.message}`
            );
            throw error;
          }
        } catch (e) {
          console.error(
            `Failed to initialize development environment: ${e.message}`
          );
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("update")
      .description("Update patch development branch with latest base changes")
      .argument("<patchName>", "name of the patch to update")
      .action(async (patchName) => {
        try {
          const devBranch = `dev_cow_${patchName}`;
          const spinner = ora(
            `Updating ${patchName} development branch`
          ).start();

          try {
            const baseBranch = await utils.getBaseBranch();
            const currentBranch = await utils.getCurrentBranch();

            // Verify we're on dev branch
            if (currentBranch !== devBranch) {
              throw new Error(
                `Not on development branch. Please checkout ${devBranch} first.`
              );
            }

            // Fetch and rebase
            await utils.execGit(["fetch", "origin"], "Failed to fetch updates");

            try {
              await utils.execGit(
                ["rebase", `origin/${baseBranch}`],
                "Failed to rebase on base branch"
              );
            } catch (e) {
              // Handle rebase conflicts
              spinner.warn(
                "Conflicts detected during rebase, attempting resolution..."
              );
              const hasLockConflict = await utils.handlePackageChanges();

              if (!hasLockConflict) {
                const hasOtherConflicts = await utils.execGit(
                  ["diff", "--name-only", "--diff-filter=U"],
                  "Failed to check conflicts"
                );

                if (hasOtherConflicts) {
                  spinner.fail("Unresolved conflicts detected");
                  throw new Error(
                    "Please resolve conflicts manually and continue rebase"
                  );
                }
              }

              await utils.execGit(
                ["rebase", "--continue"],
                "Failed to continue rebase"
              );
            }

            spinner.succeed(
              `Successfully updated ${patchName} development branch`
            );
          } catch (error) {
            spinner.fail(`Update failed: ${error.message}`);
            try {
              await utils.execGit(
                ["rebase", "--abort"],
                "Failed to abort rebase"
              );
            } catch (e) {
              // Ignore error if no rebase in progress
            }
            throw error;
          }
        } catch (e) {
          console.error(`Failed to update development branch: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("release")
      .description("Create a new release from development branch")
      .argument("<patchName>", "name of the patch to release")
      .option("-v, --version <version>", "version number for the release")
      .action(async (patchName, options) => {
        try {
          const version = options.version || "1.0.0";
          const spinner = ora(
            `Preparing release ${version} for ${patchName}\n`
          ).start();

          try {
            const devBranch = `dev_cow_${patchName}`;
            const releaseBranch = `cow_${patchName}`;
            const currentBranch = await utils.getCurrentBranch();

            // Verify we're on dev branch
            if (currentBranch !== devBranch) {
              throw new Error(
                `Not on development branch. Please checkout ${devBranch} first.`
              );
            }

            // Create or checkout release branch from main
            const baseBranch = await utils.getBaseBranch();
            const branches = (
              await utils.execGit(["branch"], "Failed to list branches")
            )
              .split("\n")
              .map((branch) => branch.trim().replace("* ", ""))
              .filter(Boolean);

            if (!branches.includes(releaseBranch)) {
              await utils.execGit(
                ["checkout", "-b", releaseBranch, baseBranch],
                "Failed to create release branch"
              );
            } else {
              await utils.execGit(
                ["checkout", releaseBranch],
                "Failed to checkout release branch"
              );
              await utils.execGit(
                ["reset", "--hard", baseBranch],
                "Failed to reset release branch"
              );
            }

            // Squash merge all changes from dev branch
            try {
              await utils.execGit(
                ["merge", "--squash", devBranch],
                "Failed to merge dev changes"
              );
              await utils.execGit(
                ["commit", "-m", `${patchName} v${version}`],
                "Failed to commit release"
              );
            } catch (e) {
              // Handle conflicts
              spinner.warn("Conflicts detected, attempting resolution...");
              await utils.handlePackageChanges();
              await utils.execGit(["add", "."], "Failed to stage changes");
              await utils.execGit(
                ["commit", "-m", `${patchName} v${version}`],
                "Failed to commit release"
              );
            }

            // Create version tag
            await utils.execGit(
              [
                "tag",
                "-a",
                `${patchName}-v${version}`,
                "-m",
                `${patchName} version ${version}`,
              ],
              "Failed to create version tag"
            );

            // Push changes and tags
            await utils.execGit(
              ["push", "-f", PATCHES_REMOTE, releaseBranch],
              "Failed to push release branch"
            );
            await utils.execGit(
              ["push", PATCHES_REMOTE, `${patchName}-v${version}`],
              "Failed to push tag"
            );

            // Return to original branch
            await utils.execGit(
              ["checkout", currentBranch],
              "Failed to return to original branch"
            );

            spinner.succeed(
              `Successfully created release ${patchName} v${version}`
            );
          } catch (error) {
            spinner.fail(`Failed to create release: ${error.message}`);
            throw error;
          }
        } catch (e) {
          console.error(`Failed to prepare release: ${e.message}`);
          process.exit(1);
        }
      })
  );

// Create patches subcommand group
program
  .command("patch")
  .description("Commands for managing patches")
  .addCommand(
    new Command("apply")
      .description("Apply a specific patch")
      .argument("<patchName>", "name of the patch to release")
      .option("-v, --version <version>", "specific version to install")
      .action(async (patchName, options) => {
        try {
          if (options.version) {
            // If version is specified, use install-version logic
            const spinner = ora(
              `Installing ${patchName} v${options.version}`
            ).start();
            try {
              await utils.execGit(
                ["fetch", "--all", "--tags"],
                "Failed to fetch updates"
              );
              const baseBranch = await utils.getBaseBranch();
              const currentBranch = await utils.getCurrentBranch();

              if (currentBranch !== baseBranch) {
                await utils.execGit(
                  ["checkout", baseBranch],
                  "Failed to checkout base branch"
                );
              }

              try {
                await utils.execGit(
                  ["cherry-pick", `${patchName}-v${options.version}`],
                  "Failed to apply patch version"
                );
              } catch (e) {
                spinner.warn("Conflicts detected, attempting resolution...");
                await utils.execGit(
                  ["cherry-pick", "--abort"],
                  "Failed to abort cherry-pick"
                );
                await utils.execGit(
                  ["cherry-pick", "-n", `${patchName}-v${options.version}`],
                  "Failed to apply patch version"
                );

                await utils.handlePackageChanges();
                await utils.execGit(["add", "."], "Failed to stage changes");
                await utils.execGit(
                  [
                    "commit",
                    "-m",
                    `Installed ${patchName} v${options.version}`,
                  ],
                  "Failed to commit changes"
                );
              }

              spinner.succeed(
                `Successfully installed ${patchName} v${options.version}`
              );
            } catch (error) {
              spinner.fail(`Failed to install version: ${error.message}`);
              throw error;
            }
          } else {
            // Regular patch apply logic
            const cleanPatchName = patchName.startsWith(`cow_`)
              ? patchName
              : `cow_${patchName}`;
            await applyPatch(cleanPatchName);
          }
          await listPatches();
        } catch (e) {
          console.error(`Failed to apply patch: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("remove")
      .description("Remove a specific patch")
      .argument("<patchName>", "name of the patch to release")
      .action(async (patchName) => {
        try {
          const cleanPatchName = patchName.replace(/^cow_/, "");
          await removePatch(cleanPatchName);
          await listPatches();
        } catch (e) {
          console.error(`Failed to remove patch: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("list")
      .description("List all applied patches")
      .action(async () => {
        try {
          await listPatches();
        } catch (e) {
          console.error(`Failed to list patches: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("reset")
      .description("Remove all patches and upgrade to latest base version")
      .action(async () => {
        try {
          await resetPatches();
        } catch (e) {
          console.error(`Reset failed: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("search")
      .command("search [patchName]")
      .description("Search for patches (lists all if no name provided)")
      .action(async (patchName) => {
        try {
          const patches = await searchPatches(patchName);
          console.log("\nAvailable patches:");

          if (patches.length === 0) {
            console.log("  No patches found");
            return;
          }

          // If a specific patch is searched, show its versions too
          if (patchName) {
            await utils.execGit(
              ["fetch", "--all", "--tags"],
              "Failed to fetch updates"
            );
            const tags = await utils.execGit(
              ["tag", "-l", `${patchName}-v*`],
              "Failed to list versions"
            );

            const versions = tags
              .split("\n")
              .filter((tag) => tag.trim())
              .map((tag) => ({
                tag,
                version: tag.replace(`${patchName}-v`, ""),
              }));

            // First show the patch info
            for (const patch of patches) {
              const { author, relativeTime } = await getPatchInfo(patch);
              console.log(`  - ${patch} (by ${author}, ${relativeTime})`);
            }

            // Then show version info if available
            if (versions.length > 0) {
              console.log(`\nAvailable versions:`);
              for (const { tag, version } of versions) {
                const info = await utils.execGit(
                  ["show", "-s", "--format=%an|%at", tag],
                  "Failed to get info for ${tag}"
                );
                const [author, timestamp] = info.split("|");
                const relativeTime = getRelativeTime(
                  parseInt(timestamp) * 1000
                );

                console.log(`  - v${version} (by ${author}, ${relativeTime})`);
              }
            }
          } else {
            // Show all patches without versions
            for (const patch of patches) {
              const { author, relativeTime } = await getPatchInfo(patch);
              console.log(`  - ${patch} (by ${author}, ${relativeTime})`);
            }
          }
        } catch (e) {
          console.error(`Failed to search patches: ${e.message}`);
          process.exit(1);
        }
      })
  );

// World management commands
program
  .command("world")
  .description("Commands for managing the world folder")
  .addCommand(
    new Command("backup")
      .description("Create a compressed backup of the world folder")
      .action(async () => {
        try {
          const spinner = ora("Creating world backup...").start();

          // Check if world folder exists
          const worldPath = path.join(process.cwd(), "world");
          try {
            await fs.access(worldPath);
          } catch (e) {
            spinner.fail("World folder not found!");
            process.exit(1);
          }

          // Create backups directory if it doesn't exist
          const backupsDir = path.join(process.cwd(), "backups");
          await fs.mkdir(backupsDir, { recursive: true });

          // Create backup filename with timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const backupFile = path.join(
            backupsDir,
            `world-backup-${timestamp}.zip`
          );

          // Create zip archive
          const output = require("fs").createWriteStream(backupFile);
          const archive = archiver("zip", {
            zlib: { level: 9 }, // Maximum compression
          });

          // Set up archive event handlers
          const archivePromise = new Promise((resolve, reject) => {
            output.on("close", () => {
              const size = (archive.pointer() / 1024 / 1024).toFixed(2);
              resolve(size);
            });

            archive.on("error", (err) => {
              reject(err);
            });
          });

          // Add world directory to archive
          archive.pipe(output);
          archive.directory(worldPath, false);
          await archive.finalize();

          // Wait for archive to complete
          const size = await archivePromise;
          spinner.succeed(`World backup created: ${backupFile}`);
          log(`Backup size: ${size} MB`, "info");
        } catch (e) {
          console.error(`Failed to create world backup: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("reset")
      .description("Delete the world folder")
      .action(async () => {
        try {
          const spinner = ora("Resetting world...").start();

          const worldPath = path.join(process.cwd(), "world");

          // Check if world folder exists
          try {
            await fs.access(worldPath);
          } catch (e) {
            spinner.info("World folder already deleted");
            return;
          }

          // Delete world folder
          await new Promise((resolve, reject) => {
            rimraf(worldPath, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });

          spinner.succeed("World folder deleted");
        } catch (e) {
          console.error(`Failed to reset world: ${e.message}`);
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("restore")
      .description("Restore world from a backup file")
      .argument(
        "[backupFile]",
        "backup file to restore from (optional - uses latest if not specified)"
      )
      .action(async (backupFile) => {
        try {
          const spinner = ora("Restoring world backup...").start();

          // If no backup file specified, use the latest one
          if (!backupFile) {
            const backupsDir = path.join(process.cwd(), "backups");
            try {
              const files = await fs.readdir(backupsDir);
              const backups = files
                .filter(
                  (f) => f.startsWith("world-backup-") && f.endsWith(".zip")
                )
                .sort()
                .reverse();

              if (backups.length === 0) {
                spinner.fail("No backup files found in backups directory");
                process.exit(1);
              }

              backupFile = path.join(backupsDir, backups[0]);
              spinner.info(`Using latest backup: ${backups[0]}`);
            } catch (e) {
              spinner.fail("No backups directory found");
              process.exit(1);
            }
          }

          // Verify backup file exists and is accessible
          try {
            await fs.access(backupFile);
          } catch (e) {
            spinner.fail(`Backup file not found: ${backupFile}`);
            process.exit(1);
          }

          // Delete existing world folder if it exists
          const worldPath = path.join(process.cwd(), "world");
          await new Promise((resolve, reject) => {
            rimraf(worldPath, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });

          // Extract backup to world directory
          await extract(backupFile, { dir: worldPath });

          spinner.succeed("World restored successfully");
        } catch (e) {
          console.error(`Failed to restore world: ${e.message}`);
          process.exit(1);
        }
      })
  );

// Make the root command (no arguments) run install
program.action((options, command) => {
  // Only run install if no other command was specified
  if (command.args.length === 0) {
    interactiveInstall();
  } else {
    console.log("ERROR: unrecognized command\n\n");
    program.help();
  }
});

program.parse();
