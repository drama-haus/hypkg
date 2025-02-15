#!/usr/bin/env node

const DEBUG = false;

const { program, Command } = require("commander");
const execa = require("execa");
const inquirer = require("inquirer");
const ora = require("ora"); // For spinner animations
const chalk = require("chalk"); // For colored output
const path = require("path");
const fs = require("fs").promises;

const packageJson = require(path.join(__dirname, "..", "package.json"));
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

// Modified function to get the project name and branch name
async function getProjectName() {
  // If we're in a git repo, use the directory name
  const isGitRepo = await fs
    .access(".git")
    .then(() => true)
    .catch(() => false);

  if (isGitRepo) {
    return path.basename(process.cwd());
  }
  return null;
}

// Git state management
async function saveGitState() {
  const currentBranch = await getCurrentBranch();
  const stashName = `backup-${Date.now()}`;
  const hasChanges =
    (await execGit(["status", "--porcelain"], "Failed to check git status"))
      .length > 0;

  if (hasChanges) {
    await execGit(
      ["stash", "push", "-m", stashName],
      "Failed to stash changes"
    );
  }

  return {
    branch: currentBranch,
    stashName: hasChanges ? stashName : null,
    commit: await execGit(
      ["rev-parse", "HEAD"],
      "Failed to get current commit"
    ),
  };
}

async function restoreGitState(state) {
  // First, reset any half-applied changes
  await execGit(["reset", "--hard", "HEAD"], "Failed to reset changes");

  // Checkout original branch
  await execGit(
    ["checkout", state.branch],
    "Failed to restore original branch"
  );

  // Reset to original commit
  await execGit(
    ["reset", "--hard", state.commit],
    "Failed to reset to original commit"
  );

  // Restore stashed changes if any
  if (state.stashName) {
    const stashList = await execGit(
      ["stash", "list"],
      "Failed to list stashes"
    );
    const stashIndex = stashList
      .split("\n")
      .findIndex((line) => line.includes(state.stashName));

    if (stashIndex !== -1) {
      await execGit(
        ["stash", "pop", `stash@{${stashIndex}}`],
        "Failed to restore stashed changes"
      );
    }
  }
}

// Git utilities
async function execGit(args, errorMessage) {
  const command = `git ${args.join(" ")}`;
  if (DEBUG) log(`${command}`, "step");

  try {
    const result = await execa("git", args);
    if (result.stdout.trim() && DEBUG) {
      log(`Output: ${result.stdout.trim()}`, "info");
    }
    return result.stdout.trim();
  } catch (e) {
    log(`${errorMessage}: ${e.message}`, "error");
    throw new Error(`${errorMessage}: ${e.message}`);
  }
}

async function getCurrentBranch() {
  return execGit(["branch", "--show-current"], "Failed to get current branch");
}

async function getBaseBranch() {
  const branches = await execGit(["branch", "-a"], "Failed to get branches");
  const hasDev = branches.includes("dev");
  return hasDev ? "dev" : "main";
}

// Config management
async function getPatchConfig() {
  const projectName = await getProjectName();
  const configPath = path.join(
    process.cwd(),
    `.${projectName || PACKAGE_NAME}`
  );
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (e) {
    return {
      branch: projectName || BRANCH_NAME,
      appliedPatches: [],
    };
  }
}

async function savePatchConfig(config) {
  const projectName = await getProjectName();
  const configPath = path.join(
    process.cwd(),
    `.${projectName || PACKAGE_NAME}`
  );
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

async function getAppliedPatches() {
  const baseBranch = await getBaseBranch();
  try {
    const commits = await execGit(
      ["log", `${baseBranch}..HEAD`, "--grep=^cow_", "--format=%s"],
      "Failed to get patch commits"
    );

    return commits
      .split("\n")
      .filter(Boolean)
      .map((commit) => {
        const match = commit.match(/^cow_(.+)$/);
        return match ? match[1] : null;
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Repository management
async function verifyRepo() {
  const origin = await execGit(
    ["remote", "get-url", "origin"],
    "Failed to get origin URL"
  );
  if (!origin.includes(TARGET_REPO.replace(".git", ""))) {
    throw new Error(
      `Not in the correct repository. Expected origin to be ${TARGET_REPO}`
    );
  }
}

async function setupPatchesRemote() {
  const remotes = await execGit(["remote"], "Failed to list remotes");
  if (!remotes.includes(PATCHES_REMOTE)) {
    await execGit(
      ["remote", "add", PATCHES_REMOTE, PATCHES_REPO],
      "Failed to add patches remote"
    );
  }
  await execGit(["fetch", PATCHES_REMOTE], "Failed to fetch patches remote");
}

// Branch management
async function syncBranches() {
  const spinner = ora("Syncing branches...").start();

  try {
    await execGit(["fetch", "origin"], "Failed to fetch origin");
    const baseBranch = await getBaseBranch();
    spinner.text = `Using ${baseBranch} as base branch`;
    await execGit(["checkout", baseBranch], "Failed to checkout base branch");
    await execGit(["pull", "origin", baseBranch], "Failed to pull base branch");

    spinner.succeed(`Successfully synced with ${baseBranch}`);
    return baseBranch;
  } catch (error) {
    spinner.fail("Failed to sync branches");
    throw error;
  }
}

async function ensurePatchBranch() {
  await setupPatchesRemote();
  const branches = await execGit(["branch"], "Failed to list branches");
  const branchExists = branches
    .split("\n")
    .map((b) => b.trim())
    .includes(BRANCH_NAME);

  if (!branchExists) {
    // Create a new branch from the current HEAD
    const baseBranch = await getBaseBranch();
    await execGit(
      ["checkout", "-b", BRANCH_NAME, baseBranch],
      "Failed to create patch branch"
    );
  } else {
    await execGit(["checkout", BRANCH_NAME], "Failed to checkout patch branch");
  }

  // Try to set upstream, but don't fail if it doesn't exist
  try {
    await execGit(
      ["branch", `--set-upstream-to=${PATCHES_REMOTE}/${PACKAGE_NAME}-base`],
      "Failed to set upstream"
    );
  } catch (e) {
    // If the remote branch doesn't exist, that's okay
    log("No remote base branch found, creating new local branch", "info");
  }

  const config = await getPatchConfig();
  await savePatchConfig(config);
}

async function handlePackageChanges() {
  const spinner = ora("Checking package dependencies...").start();

  try {
    // Check for package-lock.json conflicts
    const hasLockConflict = await execGit(
      ["diff", "--name-only", "--diff-filter=U"],
      "Failed to check conflicts"
    ).then((output) =>
      output.split("\n").some((file) => file === "package-lock.json")
    );

    if (hasLockConflict) {
      spinner.text = "Resolving package-lock.json conflicts...";

      // Remove conflicted package-lock.json
      await fs.unlink("package-lock.json").catch(() => {
        log("No existing package-lock.json found", "info");
      });

      // Regenerate package-lock.json
      spinner.text = "Regenerating package-lock.json...";
      try {
        const npmResult = await execa(
          "npm",
          ["install", "--package-lock-only"],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        log(npmResult.stdout, "info");
      } catch (e) {
        spinner.fail("Failed to regenerate package-lock.json");
        throw e;
      }

      // Stage regenerated package-lock.json
      await execGit(
        ["add", "package-lock.json"],
        "Failed to stage regenerated package-lock.json"
      );

      spinner.succeed("Package lock file regenerated successfully");
      return true;
    }

    // Check if we need to run regular npm install
    const packageLockExists = await fs
      .access("package-lock.json")
      .then(() => true)
      .catch(() => false);

    if (!packageLockExists) {
      spinner.text = "Installing dependencies...";
      try {
        const npmResult = await execa("npm", ["install"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        log(npmResult.stdout, "info");
      } catch (e) {
        spinner.fail("Failed to install dependencies");
        throw e;
      }
    }

    spinner.succeed("Dependencies handled successfully");
    return false;
  } catch (error) {
    spinner.fail("Failed to handle package changes");
    throw error;
  }
}

async function applyPatch(patchName) {
  const spinner = ora(`Applying patch: ${patchName}`).start();
  const appliedPatches = await getAppliedPatches();

  if (appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is already applied`);
    return;
  }

  const initialState = await saveGitState();

  try {
    spinner.text = "Finding patch commit...";
    const commit = await execGit(
      ["rev-list", "-n", "1", `${PATCHES_REMOTE}/${patchName}`, "^HEAD"],
      `Failed to find commit for patch ${patchName}`
    );

    if (!commit) {
      spinner.fail(`No unique commits found in ${patchName}`);
      throw new Error(`No unique commits found in ${patchName}`);
    }

    try {
      spinner.text = "Applying patch changes...";
      await execGit(["cherry-pick", commit], "Failed to cherry-pick commit");

      // Update commit message to track patch
      await execGit(
        ["commit", "--amend", "-m", `${patchName}`],
        "Failed to update commit message"
      );

      spinner.succeed(`Successfully applied patch: ${patchName}`);
    } catch (cherryPickError) {
      spinner.warn("Cherry-pick failed, attempting alternative approach...");

      await execGit(["cherry-pick", "--abort"], "Failed to abort cherry-pick");
      await execGit(
        ["cherry-pick", "-n", commit],
        "Failed to cherry-pick commit"
      );

      spinner.text = "Handling package dependencies...";
      const handledLockConflict = await handlePackageChanges();

      if (!handledLockConflict) {
        const hasOtherConflicts = await execGit(
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
      await execGit(["add", "."], "Failed to stage changes");
      await execGit(
        ["commit", "-m", `cow_${patchName}`],
        "Failed to commit changes"
      );
    }
  } catch (error) {
    spinner.fail(`Failed to apply patch: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await restoreGitState(initialState);
    throw error;
  }
}

async function removePatch(patchName) {
  const spinner = ora(`Removing patch: ${patchName}`).start();
  const appliedPatches = await getAppliedPatches();
  if (!appliedPatches.includes(patchName)) {
    spinner.info(`Patch ${patchName} is not applied`);
    return;
  }

  const initialState = await saveGitState();

  try {
    const baseBranch = await getBaseBranch();

    // Find the commit that applied this patch
    const patchCommit = await execGit(
      ["log", "--grep", `^${patchName}$`, "--format=%H"],
      "Failed to find patch commit"
    );

    if (!patchCommit) {
      throw new Error(`Could not find commit for patch ${patchName}`);
    }

    // Create temporary branch
    const tempBranch = `temp-${Date.now()}`;
    await execGit(["branch", tempBranch], "Failed to create temp branch");

    // Reset to base branch
    await execGit(
      ["reset", "--hard", baseBranch],
      "Failed to reset to base branch"
    );

    // Get all commits except the patch to remove
    const commits = await execGit(
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
          await execGit(["cherry-pick", hash], "Failed to cherry-pick commit");
        } catch (e) {
          await execGit(
            ["cherry-pick", "--abort"],
            "Failed to abort cherry-pick"
          );
          await execGit(
            ["cherry-pick", "-n", hash],
            "Failed to cherry-pick commit"
          );
          await handlePackageChanges();
          await execGit(["add", "."], "Failed to stage changes");
          await execGit(["commit", "-m", message], "Failed to commit changes");
        }
      }
    }

    // Clean up temporary branch
    await execGit(["branch", "-D", tempBranch], "Failed to delete temp branch");

    // Update dependencies
    await handlePackageChanges();

    spinner.succeed(`Successfully removed patch: ${patchName}`);
  } catch (error) {
    spinner.fail(`Failed to remove patch: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await restoreGitState(initialState);
    throw error;
  }
}

async function listPatches() {
  const appliedPatches = await getAppliedPatches();

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
// Installation management
async function ensureGlobalLink() {
  try {
    await execa("npm", ["link"], { cwd: path.join(__dirname, "..") });
    console.log("Global command link created successfully");
  } catch (e) {
    throw new Error(`Failed to create global command link: ${e.message}`);
  }
}

async function nukePatches() {
  const baseBranch = await getBaseBranch();
  await execGit(["checkout", baseBranch], "Failed to checkout base branch");

  try {
    await execGit(["branch", "-D", BRANCH_NAME], "Failed to delete branch");
    console.log(`Deleted branch ${BRANCH_NAME}`);
  } catch (e) {
    console.log(`Branch ${BRANCH_NAME} does not exist`);
  }

  try {
    await execGit(
      ["remote", "remove", PATCHES_REMOTE],
      "Failed to remove remote"
    );
    console.log(`Removed remote ${PATCHES_REMOTE}`);
  } catch (e) {
    console.log(`Remote ${PATCHES_REMOTE} does not exist`);
  }

  try {
    await execa("npm", ["unlink"], { cwd: path.join(__dirname, "..") });
    console.log("Removed global command link");
  } catch (e) {
    console.log("Global command link does not exist");
  }

  console.log("Nuke completed successfully!");
}

async function resetPatches() {
  const baseBranch = await getBaseBranch();
  console.log("Removing all patches and upgrading to latest base version...");

  await execGit(["checkout", baseBranch], "Failed to checkout base branch");
  try {
    await execGit(["branch", "-D", BRANCH_NAME], "Failed to delete branch");
    console.log(`Deleted branch ${BRANCH_NAME}`);
  } catch (e) {
    console.log(`Branch ${BRANCH_NAME} does not exist`);
  }

  await syncBranches();
  await ensurePatchBranch();
  await setupPatchesRemote();

  console.log("Reset completed successfully!");
  await listPatches();
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
  await execGit(["init"], "Failed to initialize git repository");
  await execGit(
    ["remote", "add", "origin", TARGET_REPO],
    "Failed to add origin remote"
  );
  return projectPath;
}

async function promptForBranch() {
  const currentBranch = await getCurrentBranch();
  const branches = await execGit(["branch", "-a"], "Failed to list branches");
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
        await verifyRepo();
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

    try {
      await verifyRepo();
      spinner.succeed("Repository configured");
    } catch (e) {
      // Configuration failed, but we'll set it up
      spinner.text = "Configuring repository...";
      await execGit(
        ["remote", "add", "origin", TARGET_REPO],
        "Failed to add origin remote"
      );
      spinner.succeed("Repository configured");
    }

    // Sync branches
    spinner.text = "Syncing branches...";
    await syncBranches();
    spinner.succeed("Branches synced");

    // Stop spinner for branch selection
    spinner.stop();
    const selectedBranch = await promptForBranch();

    // Resume spinner for next operations
    spinner.start("Checking out selected branch...");
    await execGit(
      ["checkout", selectedBranch],
      "Failed to checkout selected branch"
    );
    spinner.succeed("Branch checked out");

    // Setup patch management
    spinner.start("Setting up patch management...");
    await ensurePatchBranch();
    spinner.succeed("Patch management configured");

    spinner.start("Installing dependencies...");
    const npmInstall = await execa("npm", ["install"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    log(npmInstall.stdout, "info");
    spinner.succeed("Dependencies installed");

    spinner.start("Creating global command link...");
    await ensureGlobalLink();
    spinner.succeed("Command link created");

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

// Modified program setup
program
  .name(PACKAGE_NAME)
  .description("Patch management system for game engine")
  .version(packageJson.version)
  .action(interactiveInstall); // Default action when no command is provided

// Rest of the existing commands and functions remain the same...

program
  .command("install")
  .description("Install the patch management system")
  .action(async () => {
    try {
      await verifyRepo();
      const baseBranch = await syncBranches();
      await ensurePatchBranch();
      await execa("npm", ["install"]);
      await ensureGlobalLink();
      console.log("Patch management system installed successfully!");
      await listPatches();
    } catch (e) {
      console.error(`Installation failed: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("patch <patchName>")
  .description("Apply a specific patch")
  .action(async (patchName) => {
    try {
      // Remove package prefix if it's already there
      const cleanPatchName = patchName.startsWith(`cow_`)
        ? patchName
        : `cow_${patchName}`;
      await applyPatch(cleanPatchName);
      await listPatches();
    } catch (e) {
      console.error(`Failed to apply patch: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("unpatch <patchName>")
  .description("Remove a specific patch")
  .action(async (patchName) => {
    try {
      const cleanPatchName = patchName.replace(/^cow_/, '');
      await removePatch(cleanPatchName);
      await listPatches();
    } catch (e) {
      console.error(`Failed to remove patch: ${e.message}`);
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
  .description("Remove all patches and upgrade to latest base version")
  .action(async () => {
    try {
      await resetPatches();
    } catch (e) {
      console.error(`Reset failed: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("nuke")
  .description("Remove everything: patches, branch, remote, and global command")
  .action(async () => {
    try {
      await nukePatches();
    } catch (e) {
      console.error(`Nuke failed: ${e.message}`);
      process.exit(1);
    }
  });

async function searchPatches(searchTerm = "") {
  await execGit(["remote", "update", PATCHES_REMOTE, "--prune"]);

  const branches = await execGit(
    ["branch", "-a"],
    "Failed to list all branches"
  );

  const remoteBranches = branches
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`remotes/${PATCHES_REMOTE}/cow_`))
    .filter((b) => !b.endsWith("-base")) // Filter out base branch
    .map((b) => b.replace(`remotes/${PATCHES_REMOTE}/`, ""))
    .map((b) => b.replace(`cow_`, "")); // Remove package prefix

  console.log(remoteBranches)
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
  const commitInfo = await execGit(
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

async function publishPatch(branchName) {
  // Verify we're on the correct branch
  const currentBranch = await getCurrentBranch();
  if (currentBranch !== branchName) {
    throw new Error(
      `Not on branch ${branchName}. Please checkout the branch first.`
    );
  }

  const patchBranchName = `cow_${branchName}`;

  // Check if patch branch already exists
  const existingBranches = await searchPatches();
  if (existingBranches.includes(patchBranchName)) {
    // Compare diffs
    const existingDiff = await getBranchDiff(
      `${PATCHES_REMOTE}/${patchBranchName}`
    );
    const currentDiff = await getBranchDiff(branchName);

    if (existingDiff === currentDiff) {
      console.log(
        `Patch ${patchBranchName} already exists with the same changes.`
      );
      return;
    }

    throw new Error(
      `Patch ${patchBranchName} already exists with different changes.`
    );
  }

  // Create new branch for the patch
  await execGit(
    ["checkout", "-b", patchBranchName],
    "Failed to create patch branch"
  );

  // Get the base branch commit
  const baseBranch = await getBaseBranch();
  const baseCommit = await execGit(
    ["merge-base", `${PACKAGE_NAME}-base`, branchName],
    "Failed to find merge base"
  );

  // Squash all commits since the base branch
  await execGit(
    ["reset", "--soft", baseCommit],
    "Failed to reset to base commit"
  );

  // Create single commit with all changes
  await execGit(
    ["commit", "-m", `Patch: ${branchName}`],
    "Failed to create patch commit"
  );

  // Push to remote
  await execGit(
    ["push", "-u", PATCHES_REMOTE, patchBranchName],
    "Failed to push patch branch"
  );

  // Return to original branch
  await execGit(
    ["checkout", branchName],
    "Failed to return to development branch"
  );

  console.log(`Successfully published patch: ${patchBranchName}`);
}

// Add new commands to the CLI
program
  .command("publish <branchName>")
  .description("Publish current branch as a patch")
  .action(async (branchName) => {
    try {
      await publishPatch(branchName);
    } catch (e) {
      console.error(`Failed to publish patch: ${e.message}`);
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
      } else {
        for (const patch of patches) {
          const { author, relativeTime } = await getPatchInfo(patch);
          console.log(`  - ${patch} (by ${author}, ${relativeTime})`);
        }
      }
    } catch (e) {
      console.error(`Failed to search patches: ${e.message}`);
      process.exit(1);
    }
  });

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
            const baseBranch = await getBaseBranch();

            // Fetch latest changes
            await execGit(["fetch", "origin"], "Failed to fetch updates");

            // Create dev branch if it doesn't exist
            const branches = await execGit(
              ["branch"],
              "Failed to list branches"
            );
            if (!branches.includes(devBranch)) {
              await execGit(
                ["checkout", "-b", devBranch, baseBranch],
                "Failed to create dev branch"
              );
            } else {
              await execGit(
                ["checkout", devBranch],
                "Failed to checkout dev branch"
              );
            }

            // Set up config
            const config = await getPatchConfig();
            config.patchName = patchName;
            config.type = "development";
            await savePatchConfig(config);

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
            const baseBranch = await getBaseBranch();
            const currentBranch = await getCurrentBranch();

            // Verify we're on dev branch
            if (currentBranch !== devBranch) {
              throw new Error(
                `Not on development branch. Please checkout ${devBranch} first.`
              );
            }

            // Fetch and rebase
            await execGit(["fetch", "origin"], "Failed to fetch updates");

            try {
              await execGit(
                ["rebase", `origin/${baseBranch}`],
                "Failed to rebase on base branch"
              );
            } catch (e) {
              // Handle rebase conflicts
              spinner.warn(
                "Conflicts detected during rebase, attempting resolution..."
              );
              const hasLockConflict = await handlePackageChanges();

              if (!hasLockConflict) {
                const hasOtherConflicts = await execGit(
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

              await execGit(
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
              await execGit(["rebase", "--abort"], "Failed to abort rebase");
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
            const currentBranch = await getCurrentBranch();

            // Verify we're on dev branch
            if (currentBranch !== devBranch) {
              throw new Error(
                `Not on development branch. Please checkout ${devBranch} first.`
              );
            }

            // Create or checkout release branch from main
            const baseBranch = await getBaseBranch();
            const branches = (
              await execGit(["branch"], "Failed to list branches")
            )
              .split("\n")
              .map((branch) => branch.trim().replace("* ", ""))
              .filter(Boolean);

            if (!branches.includes(releaseBranch)) {
              await execGit(
                ["checkout", "-b", releaseBranch, baseBranch],
                "Failed to create release branch"
              );
            } else {
              await execGit(
                ["checkout", releaseBranch],
                "Failed to checkout release branch"
              );
              await execGit(
                ["reset", "--hard", baseBranch],
                "Failed to reset release branch"
              );
            }

            // Squash merge all changes from dev branch
            try {
              await execGit(
                ["merge", "--squash", devBranch],
                "Failed to merge dev changes"
              );
              await execGit(
                ["commit", "-m", `${patchName} v${version}`],
                "Failed to commit release"
              );
            } catch (e) {
              // Handle conflicts
              spinner.warn("Conflicts detected, attempting resolution...");
              await handlePackageChanges();
              await execGit(["add", "."], "Failed to stage changes");
              await execGit(
                ["commit", "-m", `${patchName} v${version}`],
                "Failed to commit release"
              );
            }

            // Create version tag
            await execGit(
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
            await execGit(
              ["push", "-f", PATCHES_REMOTE, releaseBranch],
              "Failed to push release branch"
            );
            await execGit(
              ["push", PATCHES_REMOTE, `${patchName}-v${version}`],
              "Failed to push tag"
            );

            // Return to original branch
            await execGit(
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

// Modified version command to work with patches
program
  .command("versions")
  .description("List all available versions of a patch")
  .argument("<patchName>", "name of the patch")
  .action(async (patchName) => {
    try {
      const spinner = ora(`Fetching versions for ${patchName}`).start();

      try {
        await execGit(["fetch", "--all", "--tags"], "Failed to fetch updates");

        const tags = await execGit(
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

        spinner.stop();

        if (versions.length === 0) {
          console.log(`No versions found for ${patchName}`);
          return;
        }

        console.log(`\nAvailable versions for ${patchName}:`);
        for (const { tag, version } of versions) {
          const info = await execGit(
            ["show", "-s", "--format=%an|%at", tag],
            `Failed to get info for ${tag}`
          );
          const [author, timestamp] = info.split("|");
          const relativeTime = getRelativeTime(parseInt(timestamp) * 1000);

          console.log(`  - v${version} (by ${author}, ${relativeTime})`);
        }
      } catch (error) {
        spinner.fail(`Failed to list versions: ${error.message}`);
        throw error;
      }
    } catch (e) {
      console.error(`Failed to list versions: ${e.message}`);
      process.exit(1);
    }
  });

// Modified install-version command
program
  .command("install-version")
  .description("Install a specific version of a patch")
  .argument("<patchName>", "name of the patch")
  .argument("<version>", "version to install")
  .action(async (patchName, version) => {
    try {
      const spinner = ora(`Installing ${patchName} v${version}`).start();

      try {
        // Fetch latest
        await execGit(["fetch", "--all", "--tags"], "Failed to fetch updates");

        const baseBranch = await getBaseBranch();
        const currentBranch = await getCurrentBranch();

        // Checkout base branch
        if (currentBranch !== baseBranch) {
          await execGit(
            ["checkout", baseBranch],
            "Failed to checkout base branch"
          );
        }

        // Apply the specific version
        try {
          await execGit(
            ["cherry-pick", `${patchName}-v${version}`],
            "Failed to apply patch version"
          );
        } catch (e) {
          // Handle conflicts
          spinner.warn("Conflicts detected, attempting resolution...");
          await execGit(
            ["cherry-pick", "--abort"],
            "Failed to abort cherry-pick"
          );
          await execGit(
            ["cherry-pick", "-n", `${patchName}-v${version}`],
            "Failed to apply patch version"
          );

          await handlePackageChanges();
          await execGit(["add", "."], "Failed to stage changes");
          await execGit(
            ["commit", "-m", `Installed ${patchName} v${version}`],
            "Failed to commit changes"
          );
        }

        spinner.succeed(`Successfully installed ${patchName} v${version}`);
      } catch (error) {
        spinner.fail(`Failed to install version: ${error.message}`);
        throw error;
      }
    } catch (e) {
      console.error(`Failed to install version: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
