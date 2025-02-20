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

const dotenv = require("dotenv");

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
  const spinner = ora(`Applying mod: ${patchName}`).start();
  const appliedPatches = await utils.getAppliedPatches();

  if (appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is already applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    spinner.text = "Finding mod commit...";
    const commit = await utils.execGit(
      ["rev-list", "-n", "1", `${PATCHES_REMOTE}/${patchName}`, "^HEAD"],
      `Failed to find commit for mod ${patchName}`
    );

    if (!commit) {
      spinner.fail(`No unique commits found in ${patchName}`);
      throw new Error(`No unique commits found in ${patchName}`);
    }

    try {
      spinner.text = "Applying mod changes...";
      await utils.execGit(
        ["cherry-pick", commit],
        "Failed to cherry-pick commit"
      );

      // Update commit message to track mod
      await utils.execGit(
        ["commit", "--amend", "-m", `${patchName}`],
        "Failed to update commit message"
      );

      spinner.succeed(`Successfully applied mod: ${patchName}`);
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
    spinner.fail(`Failed to apply mod: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await utils.restoreGitState(initialState);
    throw error;
  }
}

async function removePatch(patchName) {
  const spinner = ora(`Removing mod: ${patchName}`).start();
  const appliedPatches = await utils.getAppliedPatches();
  if (!appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is not applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    const baseBranch = await utils.getBaseBranch();

    // Find the commit that applied this mod
    const patchCommit = await utils.execGit(
      ["log", "--grep", `^cow_${patchName}$`, "--format=%H"],
      "Failed to find mod commit"
    );

    if (!patchCommit) {
      throw new Error(`Could not find commit for mod ${patchName}`);
    }

    // Create temporary branch
    const tempBranch = `temp-${Date.now()}`;
    await utils.execGit(["branch", tempBranch], "Failed to create temp branch");

    // Reset to base branch
    await utils.execGit(
      ["reset", "--hard", baseBranch],
      "Failed to reset to base branch"
    );

    // Get all commits except the mod to remove
    const commits = await utils.execGit(
      ["log", `${baseBranch}..${tempBranch}`, "--format=%H %s"],
      "Failed to get commit list"
    );

    // Apply all commits except the mod commit
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

    spinner.succeed(`Successfully removed mod: ${patchName}`);
  } catch (error) {
    spinner.fail(`Failed to remove mod: ${error.message}`);
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

async function promptForEnvVariables(emptyVars) {
  const questions = emptyVars.map((varName) => ({
    type: "input",
    name: varName,
    message: `Enter value for ${varName}:`,
    validate: (input) => {
      if (input.trim().length === 0) {
        return `${varName} cannot be empty`;
      }
      return true;
    },
  }));

  const values = await inquirer.prompt(questions);
  return values;
}

async function findEmptyEnvVariables(envFile) {
  const content = await fs.readFile(envFile, "utf-8");
  const vars = dotenv.parse(content);

  return Object.entries(vars)
    .filter(([_, value]) => value === "")
    .map(([key]) => key);
}

async function writeEnvFile(envFile, variables) {
  const content = await fs.readFile(envFile, "utf-8");
  let newContent = content;

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`${key}=.*`);
    newContent = newContent.replace(regex, `${key}=${value}`);
  }

  await fs.writeFile(".env", newContent);
}

async function setupEnvironment(spinner) {
  spinner.start("Setting up environment...");

  try {
    // Copy environment file
    await execa("cp", [".env.example", ".env"]);

    // Find empty variables in .env.example
    const emptyVars = await findEmptyEnvVariables(".env.example");

    if (emptyVars.length > 0) {
      spinner.info("Some environment variables need to be configured");
      const values = await promptForEnvVariables(emptyVars);

      // Write the new values to .env
      await writeEnvFile(".env", values);
      spinner.succeed("Environment configured with user input");
    } else {
      spinner.succeed("Environment configured");
    }
  } catch (e) {
    spinner.info("No .env.example file found, skipping environment setup");
    console.error(e);
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

// First, let's add the utility function to get currently applied patches
async function getAppliedPatches() {
  const baseBranch = await utils.getBaseBranch();
  const currentBranch = await utils.getCurrentBranch();

  // Get all commits between base branch and current branch
  const output = await utils.execGit(
    ["log", `${baseBranch}..${currentBranch}`, "--pretty=format:%s"],
    "Failed to get commit history"
  );

  // Extract mod names from commit messages
  return output
    .split("\n")
    .filter(
      (msg) =>
        msg.startsWith("Installed cow_") || msg.startsWith("Applied cow_")
    )
    .map((msg) => {
      const match = msg.match(
        /(?:Installed|Applied) (cow_[^\s]+)(?: v(\d+\.\d+\.\d+))?/
      );
      if (match) {
        return {
          name: match[1],
          version: match[2] || null,
        };
      }
      return null;
    })
    .filter(Boolean)
    .reverse(); // Reverse to get them in application order
}

async function syncPatches() {
  const spinner = ora("Starting mod synchronization...").start();

  try {
    // Store current patches before reset
    spinner.text = "Getting currently applied patches...";
    const appliedPatches = await getAppliedPatches();

    // Reset to base branch
    spinner.text = "Resetting to base branch...";
    await resetPatches();

    // Reapply each mod
    for (const patch of appliedPatches) {
      spinner.text = `Reapplying mod ${patch.name}${
        patch.version ? ` v${patch.version}` : ""
      }...`;

      try {
        if (patch.version) {
          // Version-specific installation
          await utils.execGit(
            ["fetch", "--all", "--tags"],
            "Failed to fetch updates"
          );

          try {
            await utils.execGit(
              ["cherry-pick", `${patch.name}-v${patch.version}`],
              "Failed to apply mod version"
            );
          } catch (e) {
            spinner.warn(
              `Conflicts detected in ${patch.name}, attempting resolution...`
            );
            await utils.execGit(
              ["cherry-pick", "--abort"],
              "Failed to abort cherry-pick"
            );
            await utils.execGit(
              ["cherry-pick", "-n", `${patch.name}-v${patch.version}`],
              "Failed to apply mod version"
            );

            await utils.handlePackageChanges();
            await utils.execGit(["add", "."], "Failed to stage changes");
            await utils.execGit(
              ["commit", "-m", `Installed ${patch.name} v${patch.version}`],
              "Failed to commit changes"
            );
          }
        } else {
          // Regular mod application
          const cleanPatchName = patch.name.startsWith("cow_")
            ? patch.name
            : `cow_${patch.name}`;
          await applyPatch(cleanPatchName);
        }
      } catch (e) {
        spinner.fail(`Failed to reapply ${patch.name}: ${e.message}`);
        throw e;
      }
    }

    spinner.succeed("Successfully synchronized all patches");

    // Show final patch list
    await listPatches();
  } catch (e) {
    spinner.fail(`Sync failed: ${e.message}`);
    throw e;
  }
}

async function interactiveInstall(options = {}) {
  try {
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
    spinner.start("Setting up mod management...");
    await utils.ensurePatchBranch(
      BRANCH_NAME,
      selectedBranch,
      config.patchesRemote
    );
    spinner.succeed("Patch management configured");

    // Stop spinner for mod selection
    spinner.stop();
    const selectedPatches = await promptForPatches();

    if (selectedPatches.length > 0) {
      for (const patch of selectedPatches) {
        await applyPatch(`cow_${patch}`);
      }
    }

    await setupEnvironment(spinner);

    if (options.install) {
      spinner.start("Installing dependencies...");
      const npmInstall = await execa("npm", ["install"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      log(npmInstall.stdout, "info");
      spinner.succeed("Dependencies installed");
    }

    // Display final information
    log("\n🎮 Your game engine project is ready!", "success");
    log("Here's what you need to know:", "info");
    console.log(
      chalk.cyan(`
    Commands available:
    → npm run dev         - Start the development server
    → ${PACKAGE_NAME} list    - See your applied mods
    → ${PACKAGE_NAME} search  - Browse available mods
    `)
    );

    await listPatches();

    if (options.install) {
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
    }
  } catch (e) {
    console.error(chalk.red(`Setup failed: ${e.message}`));
    process.exit(1);
  }
}

async function batchUpdateDevPatches(options = {}) {
  const spinner = ora("Starting batch update of dev patches...").start();
  const failedPatches = [];

  try {
    // Get all local branches
    const branches = (
      await utils.execGit(["branch"], "Failed to list branches")
    )
      .split("\n")
      .map((b) => b.trim().replace("* ", ""))
      .filter((b) => b.startsWith("dev_cow_"));

    if (branches.length === 0) {
      spinner.info("No dev patches found to update");
      return;
    }

    spinner.info(`Found ${branches.length} dev patches to process`);

    // Store current branch to return to it later
    const originalBranch = await utils.getCurrentBranch();

    for (const branch of branches) {
      const patchName = branch.replace("dev_cow_", "");
      spinner.text = `Processing ${patchName}...`;

      try {
        // Checkout the dev branch
        await utils.execGit(
          ["checkout", branch],
          "Failed to checkout dev branch"
        );

        // Try to update the branch
        try {
          const baseBranch = await utils.getBaseBranch();
          await utils.execGit(["fetch", "origin"], "Failed to fetch updates");

          try {
            await utils.execGit(
              ["rebase", `origin/${baseBranch}`],
              "Failed to rebase on base branch"
            );
          } catch (e) {
            // Handle rebase conflicts
            spinner.warn(
              `Conflicts detected in ${patchName}, attempting resolution...`
            );
            const hasLockConflict = await utils.handlePackageChanges();

            if (!hasLockConflict) {
              const hasOtherConflicts = await utils.execGit(
                ["diff", "--name-only", "--diff-filter=U"],
                "Failed to check conflicts"
              );

              if (hasOtherConflicts) {
                throw new Error("Unresolvable conflicts detected");
              }
            }

            await utils.execGit(
              ["rebase", "--continue"],
              "Failed to continue rebase"
            );
          }

          // If update successful, try to release
          if (options.autoRelease) {
            const version = await getNextPatchVersion(patchName);
            const releaseBranch = `cow_${patchName}`;

            // Create or checkout release branch from main
            const branches = (
              await utils.execGit(["branch"], "Failed to list branches")
            )
              .split("\n")
              .map((b) => b.trim().replace("* ", ""))
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
                ["merge", "--squash", branch],
                "Failed to merge dev changes"
              );
              await utils.execGit(
                ["commit", "-m", `${patchName} v${version}`],
                "Failed to commit release"
              );
            } catch (e) {
              // Handle conflicts
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

            spinner.succeed(
              `Successfully updated and released ${patchName} v${version}`
            );
          } else {
            spinner.succeed(`Successfully updated ${patchName}`);
          }
        } catch (error) {
          failedPatches.push({
            name: patchName,
            error: error.message,
          });

          spinner.warn(`Failed to process ${patchName}: ${error.message}`);

          // Abort any pending rebase
          try {
            await utils.execGit(
              ["rebase", "--abort"],
              "Failed to abort rebase"
            );
          } catch (e) {
            // Ignore error if no rebase in progress
          }
        }
      } catch (error) {
        failedPatches.push({
          name: patchName,
          error: error.message,
        });
        spinner.warn(`Failed to checkout ${patchName}: ${error.message}`);
      }
    }

    // Return to original branch
    await utils.execGit(
      ["checkout", originalBranch],
      "Failed to return to original branch"
    );

    // Final status report
    if (failedPatches.length > 0) {
      spinner.warn("\nSome patches failed to process:");
      failedPatches.forEach((patch) => {
        console.log(chalk.yellow(`\n${patch.name}:`));
        console.log(chalk.gray(`  Error: ${patch.error}`));
      });
    } else {
      spinner.succeed("All patches processed successfully!");
    }
  } catch (error) {
    spinner.fail(`Batch update failed: ${error.message}`);
    throw error;
  }
}

// Helper function to determine next version number for a patch
async function getNextPatchVersion(patchName) {
  try {
    await utils.execGit(
      ["fetch", "--all", "--tags"],
      "Failed to fetch updates"
    );

    // Get all version tags for this patch
    const tags = await utils.execGit(
      ["tag", "-l", `${patchName}-v*`],
      "Failed to list versions"
    );

    if (!tags) {
      return "1.0.0";
    }

    // Find highest version
    const versions = tags
      .split("\n")
      .map((tag) => tag.replace(`${patchName}-v`, ""))
      .filter(Boolean)
      .map((version) => {
        const [major, minor, patch] = version.split(".").map(Number);
        return { major, minor, patch, original: version };
      })
      .sort((a, b) => {
        if (a.major !== b.major) return b.major - a.major;
        if (a.minor !== b.minor) return b.minor - a.minor;
        return b.patch - a.patch;
      });

    if (versions.length === 0) {
      return "1.0.0";
    }

    const latest = versions[0];
    return `${latest.major}.${latest.minor}.${latest.patch + 1}`;
  } catch (error) {
    console.warn(
      `Error determining version for ${patchName}, using 1.0.0:`,
      error.message
    );
    return "1.0.0";
  }
}

// Define command groups and their descriptions
const commandGroups = {
  mod: {
    description: "Mod Management:",
    commands: ["apply", "remove", "list", "reset", "search", "sync"],
  },
  dev: {
    description: "Development Tools:",
    commands: ["init", "release", "update", "batch-update"],
  },
  app: {
    description: ".hyp App Tools:",
    commands: ["extract", "bundle"],
  },
};

program
  .name(PACKAGE_NAME)
  .description("Hyperfy Mod Manager")
  .version(packageJson.version)
  .configureHelp({
    sortSubcommands: false,
    subcommandTerm: (cmd) => {
      // Find which group this command belongs to
      for (const [groupPrefix, group] of Object.entries(commandGroups)) {
        if (group.commands.some((c) => cmd.name() === c)) {
          // Add group header before first command, but keep consistent spacing
          if (group.commands[0] === cmd.name()) {
            return `\n${group.description}\n  ${cmd.name()}`;
          }
          return `  ${cmd.name()}`;
        }
      }
      // For commands not in any group
      return `  ${cmd.name()}`;
    },
    subcommandDescription: (cmd) => {
      // Add padding to align all descriptions
      for (const [groupPrefix, group] of Object.entries(commandGroups)) {
        if (group.commands.some((c) => cmd.name() === c)) {
          if (group.commands[0] === cmd.name()) {
            const commandLength = cmd.name().length;
            // Calculate padding based on observed rules
            let effectivePadding;
            if (commandLength === 4) effectivePadding = 2; // 4 -> 6
            else if (commandLength === 5) effectivePadding = 4; // 5 -> 9
            else if (commandLength === 7) effectivePadding = 2; // 7 -> 9
            else effectivePadding = 2; // default fallback

            const targetWidth = 26;
            return `${" ".repeat(
              targetWidth - commandLength - effectivePadding
            )}${cmd.description()}`;
          }
        }
      }
      return cmd.description();
    },
  });

program
  .command("install")
  .description("Interactive setup of a hyperfy world")
  .option("--no-install", "Skip npm install and server startup")
  .action((options) => interactiveInstall(options));

program
  .command("extract <file>")
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
  });

program
  .command("init <patchName>")
  .description("Initialize a new mod development environment")
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

        spinner.succeed(`Development environment initialized for ${patchName}`);
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
  });

program
  .command("update <patchName>")
  .description("Update mod development branch with latest base changes")
  .action(async (patchName) => {
    try {
      const devBranch = `dev_cow_${patchName}`;
      const spinner = ora(`Updating ${patchName} development branch`).start();

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

        spinner.succeed(`Successfully updated ${patchName} development branch`);
      } catch (error) {
        spinner.fail(`Update failed: ${error.message}`);
        try {
          await utils.execGit(["rebase", "--abort"], "Failed to abort rebase");
        } catch (e) {
          // Ignore error if no rebase in progress
        }
        throw error;
      }
    } catch (e) {
      console.error(`Failed to update development branch: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("update-all")
  .description("Update all dev patches with latest base changes")
  .option(
    "-r, --auto-release",
    "Automatically create new releases for successfully updated patches"
  )
  .action(async (options) => {
    try {
      await batchUpdateDevPatches(options);
    } catch (e) {
      console.error(`Batch update failed: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("release <patchName>")
  .description("Create a new release from development branch")
  .action(async (patchName) => {
    try {
      const spinner = ora(`Preparing release for ${patchName}\n`).start();

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

        // Get the next version number
        spinner.text = "Determining next version number...";
        await utils.execGit(
          ["fetch", "--all", "--tags"],
          "Failed to fetch updates"
        );

        // Get all version tags for this mod
        const tags = await utils.execGit(
          ["tag", "-l", `${patchName}-v*`],
          "Failed to list versions"
        );

        let version = "1.0.0";
        if (tags) {
          const versions = tags
            .split("\n")
            .map((tag) => tag.replace(`${patchName}-v`, ""))
            .filter(Boolean)
            .map((version) => {
              const [major, minor, patch] = version.split(".").map(Number);
              return { major, minor, patch, original: version };
            })
            .sort((a, b) => {
              if (a.major !== b.major) return b.major - a.major;
              if (a.minor !== b.minor) return b.minor - a.minor;
              return b.patch - a.patch;
            });

          if (versions.length > 0) {
            const latest = versions[0];
            version = `${latest.major}.${latest.minor}.${latest.patch + 1}`;
          }
        }

        spinner.text = `Preparing release v${version}...`;

        // Create or checkout release branch from main
        const baseBranch = await utils.getBaseBranch();
        const branches = (
          await utils.execGit(["branch"], "Failed to list branches")
        )
          .split("\n")
          .map((branch) => branch.trim().replace("* ", ""))
          .filter(Boolean);

        // If release branch exists, create a backup branch
        if (branches.includes(releaseBranch)) {
          const backupBranch = `${releaseBranch}_backup_v${version}`;
          spinner.text = `Creating backup branch ${backupBranch}...`;
          await utils.execGit(
            ["branch", backupBranch, releaseBranch],
            "Failed to create backup branch"
          );

          // Checkout and reset release branch
          await utils.execGit(
            ["checkout", releaseBranch],
            "Failed to checkout release branch"
          );
          await utils.execGit(
            ["reset", "--hard", baseBranch],
            "Failed to reset release branch"
          );
        } else {
          await utils.execGit(
            ["checkout", "-b", releaseBranch, baseBranch],
            "Failed to create release branch"
          );
        }

        // Squash merge all changes from dev branch
        spinner.text = "Merging changes...";
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
        spinner.text = "Creating version tag...";
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
        spinner.text = "Pushing changes...";
        await utils.execGit(
          ["push", "-f", PATCHES_REMOTE, releaseBranch],
          "Failed to push release branch"
        );
        await utils.execGit(
          ["push", PATCHES_REMOTE, `${patchName}-v${version}`],
          "Failed to push tag"
        );

        // Push backup branch if it exists
        const backupBranch = `${releaseBranch}_backup_v${version}`;
        if (branches.includes(releaseBranch)) {
          spinner.text = "Pushing backup branch...";
          await utils.execGit(
            ["push", "-f", PATCHES_REMOTE, backupBranch],
            "Failed to push backup branch"
          );
        }

        // Return to original branch
        await utils.execGit(
          ["checkout", currentBranch],
          "Failed to return to original branch"
        );

        spinner.succeed(
          `Successfully created release ${patchName} v${version}` +
            (branches.includes(releaseBranch)
              ? `\nBackup saved in ${backupBranch}`
              : "")
        );
      } catch (error) {
        spinner.fail(`Failed to create release: ${error.message}`);
        throw error;
      }
    } catch (e) {
      console.error(`Failed to prepare release: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("apply <patchName>")
  .description("Apply a specific mod")
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
              "Failed to apply mod version"
            );
          } catch (e) {
            spinner.warn("Conflicts detected, attempting resolution...");
            await utils.execGit(
              ["cherry-pick", "--abort"],
              "Failed to abort cherry-pick"
            );
            await utils.execGit(
              ["cherry-pick", "-n", `${patchName}-v${options.version}`],
              "Failed to apply mod version"
            );

            await utils.handlePackageChanges();
            await utils.execGit(["add", "."], "Failed to stage changes");
            await utils.execGit(
              ["commit", "-m", `Installed ${patchName} v${options.version}`],
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
        // Regular mod apply logic
        const cleanPatchName = patchName.startsWith(`cow_`)
          ? patchName
          : `cow_${patchName}`;
        await applyPatch(cleanPatchName);
      }
      await listPatches();
    } catch (e) {
      console.error(`Failed to apply mod: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("remove <patchName>")
  .description("Remove a specific mod")
  .action(async (patchName) => {
    try {
      const cleanPatchName = patchName.replace(/^cow_/, "");
      await removePatch(cleanPatchName);
      await listPatches();
    } catch (e) {
      console.error(`Failed to remove mod: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all applied patches")
  .action(async () => {
    try {
      await listPatches();
    } catch (e) {
      console.error(`Failed to list patches: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("reset")
  .description(
    "Remove all patches and upgrade CURRENT BRANCH to latest base version"
  )
  .action(async () => {
    try {
      await resetPatches();
    } catch (e) {
      console.error(`Reset failed: ${e.message}`);
      process.exit(1);
    }
  });

program
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

      // If a specific mod is searched, show its versions too
      if (patchName) {
        await utils.execGit(
          ["fetch", "--all", "--tags"],
          "Failed to fetch updates"
        );

        // Get tag list
        const tagsOutput = await utils.execGit(
          [
            "tag",
            "-l",
            `${patchName}-v*`,
            "--format=%(tag)|%(taggername)|%(taggerdate:relative)|%(subject)",
          ],
          "Failed to list versions"
        );

        const versions = tagsOutput
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [tag, tagger, date, subject] = line.split("|");
            return {
              version: tag.replace(`${patchName}-v`, ""),
              tagger: tagger.trim(),
              date: date.trim(),
              description: subject.trim(),
            };
          });

        // First show the mod info
        for (const patch of patches) {
          const { author, relativeTime } = await getPatchInfo(patch);
          console.log(chalk.cyan(`  ${patch}`));
          console.log(`    Author: ${author}`);
          console.log(`    Created: ${relativeTime}`);
        }

        // Then show version info if available
        if (versions.length > 0) {
          console.log(`\nVersions available:`);
          for (const version of versions) {
            console.log(chalk.green(`  v${version.version}`));
            console.log(`    Author: ${version.tagger}`);
            console.log(`    Released: ${version.date}`);
            if (version.description) {
              console.log(`    Description: ${version.description}`);
            }
            console.log(); // Add a blank line between versions
          }
        } else {
          console.log("\nNo versions available");
        }
      } else {
        // Show all patches without versions
        for (const patch of patches) {
          const { author, relativeTime } = await getPatchInfo(patch);
          console.log(`  - ${patch} (by ${author}, ${relativeTime})`);
        }
      }
    } catch (e) {
      console.error(chalk.red(`Failed to search patches: ${e.message}`));
      process.exit(1);
    }
  });

program
  .command("sync")
  .description("Reset and reapply all patches to ensure clean state")
  .action(async () => {
    try {
      await syncPatches();
    } catch (e) {
      console.error(`Sync failed: ${e.message}`);
      process.exit(1);
    }
  });

// Make the root command (no arguments) run install
program.action((options, command) => {
  // Only run install if no other command was specified
  if (command.args.length === 0) {
    interactiveInstall(options);
  } else {
    console.log("ERROR: unrecognized command\n\n");
    program.help();
  }
});

program.parse();
