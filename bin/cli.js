#!/usr/bin/env node

const DEBUG = false;

// Import the new Git utilities
const git = require("../src/lib/git");
const { GIT } = require("../src/lib/constants");
const {
  GitOperationError,
  GitCommandError,
  PatchNotFoundError,
  RepositoryError,
} = require("../src/lib/errors");

// Keep original utils for now - we'll gradually migrate
const utils = require("../src/utils");

const { program, Command } = require("commander");
const execa = require("execa");
const inquirer = require("inquirer");
const ora = require("ora"); // For spinner animations
const chalk = require("chalk"); // For colored output
const path = require("path");
const fs = require("fs").promises;

const dotenv = require("dotenv");

const packageJson = require("../package.json");
const {
  promptForAction,
  promptForNewProject,
  promptForBranch,
  promptForPatches,
  promptForEnvVariables,
} = require("../src/lib/prompts");
const { searchPatches } = require("./searchPatches");
const { getPatchInfo } = require("./getPatchInfo");
const {
  fetchVerifiedRepositories,
  isVerifiedRepository,
} = require("./fetchVerifiedRepositories");
const { applyPatchFromRepo } = require("./applyPatchFromRepo");
const { log } = require("./log");
const { getAppliedPatches } = require("./getAppliedPatches");
const {
  addRepository,
  removeRepository,
  listRepositories,
  getRepositoryForPatch,
  getPreferredReleaseRepository
} = require("./repository");
const {
  browseForks,
  addGitHubRepository,
  enhanceRepositoriesWithGitHubData
} = require("./github");

const config = {
  patchesRepo: packageJson.config.patchesRepo,
  patchesRemote: packageJson.config.patchesRemoteName,
  targetRepo: packageJson.config.targetRepo,
  packageName: packageJson.name,
};

const TARGET_REPO = packageJson.config.targetRepo;
exports.TARGET_REPO = TARGET_REPO;
const PACKAGE_NAME = packageJson.name;
let BRANCH_NAME = PACKAGE_NAME;

/**
 * Get the associated patch name for a branch
 * This first checks git config to see if a mapping exists,
 * then falls back to naming conventions
 *
 * @param {string} branchName - Name of the branch
 * @returns {Promise<string>} - The patch name associated with this branch
 */
async function getPatchNameForBranch(branchName) {
  try {
    // First check if there's a stored mapping in git config
    try {
      const configKey = `hyperfy.mod.${branchName}.patchName`;
      const configuredPatchName = await git.execGit(
        ["config", "--get", configKey],
        "Failed to get patch name from git config"
      );

      if (configuredPatchName && configuredPatchName.trim()) {
        return configuredPatchName.trim();
      }
    } catch (error) {
      // Git config not set, continue to convention-based approach
    }

    // Check for legacy naming conventions
    if (branchName.startsWith(GIT.BRANCH_PREFIX)) {
      return branchName.replace(GIT.BRANCH_PREFIX, "");
    }

    // Fallback to using the branch name itself
    return branchName;
  } catch (error) {
    console.warn(
      `Warning: Failed to determine patch name from branch: ${error.message}`
    );
    // Return branch name as fallback
    return branchName;
  }
}

/**
 * Validates the current branch is not a base branch, and offers alternatives if it is
 * @returns {boolean} - Whether the current branch is valid for operations
 */
async function ensureNotOnBaseBranch() {
  try {
    const currentBranch = await utils.getCurrentBranch();
    const baseBranch = await utils.getBaseBranch();
    const commonBaseBranches = [
      "main",
      "master",
      "dev",
      "develop",
      "development",
    ];

    // Check if current branch is a base branch
    if (
      currentBranch === baseBranch ||
      commonBaseBranches.includes(currentBranch)
    ) {
      log(
        `You are currently on ${currentBranch}, which appears to be a base branch.`,
        "warning"
      );
      log(
        "Operations should not be performed directly on base branches.",
        "warning"
      );

      // Get list of other branches for selection
      const branchesOutput = await utils.execGit(
        ["branch"],
        "Failed to list branches"
      );
      let branches = branchesOutput
        .split("\n")
        .map((b) => b.trim().replace("* ", ""))
        .filter((b) => b && !commonBaseBranches.includes(b));

      // Prepare selection menu options
      const choices = [
        { name: "➕ Create a new branch", value: "new" },
        ...branches.map((b) => ({ name: b, value: b })),
      ];

      if (choices.length === 1) {
        log(
          "No other branches available. You need to create a new branch.",
          "info"
        );
        const { newBranchName } = await inquirer.prompt([
          {
            type: "input",
            name: "newBranchName",
            message: "Enter a name for the new branch:",
            validate: (input) => {
              if (!input.trim()) return "Branch name cannot be empty";
              if (input.includes(" "))
                return "Branch name cannot contain spaces";
              return true;
            },
          },
        ]);

        await createNewBranch(newBranchName, currentBranch);
        return true;
      }

      // Show selection menu
      const { selectedBranch } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedBranch",
          message: "Select a branch to use instead:",
          choices,
        },
      ]);

      if (selectedBranch === "new") {
        const { newBranchName } = await inquirer.prompt([
          {
            type: "input",
            name: "newBranchName",
            message: "Enter a name for the new branch:",
            validate: (input) => {
              if (!input.trim()) return "Branch name cannot be empty";
              if (input.includes(" "))
                return "Branch name cannot contain spaces";
              return true;
            },
          },
        ]);

        await createNewBranch(newBranchName, currentBranch);
      } else {
        // Checkout existing branch
        const spinner = ora(`Checking out branch ${selectedBranch}...`).start();
        await utils.execGit(
          ["checkout", selectedBranch],
          "Failed to checkout selected branch"
        );
        spinner.succeed(`Switched to branch ${selectedBranch}`);
      }

      return true;
    }

    // Not on a base branch, all good
    return true;
  } catch (error) {
    log(`Branch validation failed: ${error.message}`, "error");
    return false;
  }
}

/**
 * Creates and checks out a new branch
 * @param {string} newBranchName - Name for the new branch
 * @param {string} baseBranch - Base branch to create from
 */
async function createNewBranch(newBranchName, baseBranch) {
  const spinner = ora(
    `Creating and checking out new branch ${newBranchName}...`
  ).start();
  try {
    await utils.execGit(
      ["checkout", "-b", newBranchName, baseBranch],
      "Failed to create new branch"
    );
    spinner.succeed(`Created and switched to branch ${newBranchName}`);
  } catch (error) {
    spinner.fail(`Failed to create branch: ${error.message}`);
    throw error;
  }
}

/**
 * Ensures the current project is valid and properly set up
 * Checks package.json and configures remotes if needed
 * @param {object} options - Command options
 * @returns {boolean} - Whether the project is valid
 */
async function ensureValidProject(options = {}) {
  // Skip validation for commands that don't require an existing project
  if (options.skipValidation) {
    return true;
  }

  try {
    // Check if we're in a git repository
    const isGitRepo = await fs
      .access(".git")
      .then(() => true)
      .catch(() => false);

    if (!isGitRepo) {
      if (DEBUG) console.log("Not in a git repository");
      return false;
    }

    // const spinner = ora(`Validating project`).start();

    // Check if it's a Hyperfy project by looking at package.json
    try {
      const packageJsonContent = await fs.readFile("package.json", "utf-8");
      const packageData = JSON.parse(packageJsonContent);

      if (packageData.name !== "hyperfy") {
        log(
          `Not a Hyperfy project. Package name is ${packageData.name}`,
          "warning"
        );
        log("Commands may not work as expected", "warning");

        // Prompt user to confirm they want to continue
        const { proceed } = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceed",
            message: "Continue anyway?",
            default: false,
          },
        ]);

        if (!proceed) {
          return false;
        }
      }

      try {
        // spinner.text = "Checking for verified repositories...";
        const verifiedRepos = await fetchVerifiedRepositories();
        const currentRepos = await git.getRegisteredRepositories();
        const currentRepoUrls = new Map(
          currentRepos.map((r) => [r.url, r.name])
        );

        for (const verifiedRepo of verifiedRepos) {
          if (!currentRepoUrls.has(verifiedRepo.url)) {
            // spinner.text = `Adding verified repository: ${verifiedRepo.name}`;
            await addRepository(
              verifiedRepo.name.replace(".", "-"),
              verifiedRepo.url
            );
            // spinner.succeed(`Added verified repository: ${verifiedRepo.name}`);
          }
        }
      } catch (error) {
        // spinner.warn(
        //   `Warning: Could not ensure verified repositories: ${error.message}`
        // );
      }
    } catch (error) {
      log(`Failed to read package.json: ${error.message}`, "error");
      return false;
    }

    // Check and set up remotes
    const remotes = await utils.execGit(["remote"], "Failed to list remotes");
    const remoteList = remotes
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    // Set up main Hyperfy repository as a remote if not present
    if (!remoteList.includes("hyperfy")) {
      // Check if origin is already pointing to the main hyperfy repo
      let mainRepoAlreadyExists = false;

      if (remoteList.includes("origin")) {
        const originUrl = await utils.execGit(
          ["remote", "get-url", "origin"],
          "Failed to get origin URL"
        );

        // If origin is already pointing to the main repo, we don't need another remote
        if (originUrl.trim() === TARGET_REPO) {
          mainRepoAlreadyExists = true;
        }
      }

      if (!mainRepoAlreadyExists) {
        log(
          `Setting up main Hyperfy repository as remote "hyperfy"...`,
          "info"
        );
        try {
          await utils.execGit(
            ["remote", "add", "hyperfy", TARGET_REPO],
            "Failed to add hyperfy remote"
          );

          // Fetch from the newly added remote
          await utils.execGit(
            ["fetch", "hyperfy"],
            "Failed to fetch from hyperfy remote"
          );

          log(`Successfully set up main Hyperfy repository remote`, "success");
        } catch (error) {
          log(
            `Warning: Failed to set up hyperfy remote: ${error.message}`,
            "warning"
          );
          log(
            "Proceeding without hyperfy remote. Some features may not work correctly.",
            "warning"
          );
        }
      }
    }

    // Validate we're not operating on a base branch
    if (!options.skipBranchCheck) {
      const isValidBranch = await ensureNotOnBaseBranch();
      if (!isValidBranch) {
        return false;
      }
    }

    return true;
  } catch (error) {
    log(`Project validation failed: ${error.message}`, "error");
    return false;
  }
}

/**
 * Parse a patch name that must include a repository prefix
 * Modified version that requires a repository prefix
 * @param {string} fullPatchName - The full patch name, with required repo prefix
 * @returns {Object} Object with remote and patchName
 */
async function parsePatchName(fullPatchName) {
  // Check if the name includes a repository prefix
  const parts = fullPatchName.split("/");

  if (parts.length < 2) {
    throw new Error(
      `Invalid patch name format: ${fullPatchName}. Expected format: 'repository/patchName'`
    );
  }

  // Get the remote name from the first part
  const remoteName = parts[0];

  // Verify the remote exists
  const repositories = await git.getRegisteredRepositories();
  const repoExists = repositories.some((repo) => repo.name === remoteName);

  if (!repoExists) {
    throw new Error(
      `Repository '${remoteName}' is not registered. Use 'repository add' to add it first.`
    );
  }

  return {
    remote: remoteName,
    patchName: parts.slice(1).join("/"),
  };
}

/**
 * Check if a patch name is properly namespaced
 * @param {string} patchName - The patch name to check
 * @returns {boolean} - True if the patch name is properly namespaced
 */
function isNamespacedPatch(patchName) {
  return patchName.includes("/");
}

async function removePatch(patchName) {
  const spinner = ora(`Removing mod: ${patchName}`).start();

  // Use the enhanced getAppliedPatches function defined in this file
  const appliedPatches = await getAppliedPatches();

  // Check if the patch is applied by looking at the name property
  const foundPatch = appliedPatches.find((patch) => {
    const patchNameToCheck = typeof patch === "string" ? patch : patch.name;
    return (
      patchNameToCheck === patchName || patchNameToCheck === `cow_${patchName}`
    );
  });

  if (!foundPatch) {
    spinner.info(`Patch ${patchName} is not applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    const baseBranch = await utils.getBaseBranch();

    // Find the commit that applied this mod
    // For namespaced patches, we need to handle the exact format used in commit messages
    spinner.text = "Finding patch commit...";

    // Get all commits between base branch and current branch with full messages
    const output = await utils.execGit(
      [
        "log",
        `${baseBranch}..HEAD`,
        "--pretty=format:%H %s%n%b%n---COMMIT_SEPARATOR---",
      ],
      "Failed to get commit history"
    );

    // Split by commit separator
    const commits = output.split("---COMMIT_SEPARATOR---").filter(Boolean);

    // Find the commit that applied this patch by looking at commit messages
    let patchCommit = null;
    const exactPatchName =
      typeof foundPatch === "string" ? foundPatch : foundPatch.name;

    for (const commitInfo of commits) {
      const lines = commitInfo.split("\n");
      const firstLine = lines[0] || "";
      const [hash, ...messageParts] = firstLine.split(" ");
      const message = messageParts.join(" ");

      // Check if this commit message matches our patch
      // - Look for the exact patch name in the message
      // - Handle the "cow: patchName" format
      // - Handle the old "cow_patchName" format
      if (
        message === exactPatchName ||
        message === `cow_${exactPatchName}` ||
        message === `cow: ${exactPatchName}` ||
        message.startsWith(`cow: ${exactPatchName} v`) // Handle versioned patches
      ) {
        patchCommit = hash;
        break;
      }
    }

    if (!patchCommit) {
      spinner.warn(
        "Could not find commit with exact patch name, trying alternative search..."
      );

      // Try a more flexible search if exact match fails
      // This handles cases where the commit message might have additional text
      try {
        // Try grep with just the last part of the patch name (after /)
        const simpleName = patchName.includes("/")
          ? patchName.split("/").pop()
          : patchName;
        patchCommit = await utils.execGit(
          ["log", `${baseBranch}..HEAD`, "--grep", simpleName, "--format=%H"],
          "Failed to find mod commit"
        );

        // If multiple commits found, use the first one
        patchCommit = patchCommit.split("\n")[0];
      } catch (e) {
        throw new Error(`Could not find commit for mod ${patchName}`);
      }
    }

    if (!patchCommit) {
      throw new Error(`Could not find commit for mod ${patchName}`);
    }

    spinner.text = `Found commit ${patchCommit.substring(
      0,
      8
    )} for patch ${patchName}`;

    // Create temporary branch
    const tempBranch = `temp-${Date.now()}`;
    await utils.execGit(["branch", tempBranch], "Failed to create temp branch");

    // Reset to base branch
    await utils.execGit(
      ["reset", "--hard", baseBranch],
      "Failed to reset to base branch"
    );

    // Get all commits except the mod to remove
    const allCommits = await utils.execGit(
      ["log", `${baseBranch}..${tempBranch}`, "--format=%H %s"],
      "Failed to get commit list"
    );

    spinner.text = "Reapplying all commits except the patch to remove...";

    // Apply all commits except the mod commit
    for (const commitLine of allCommits.split("\n").reverse()) {
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
/**
 * Display enhanced information about applied patches with insightful messages
 */
async function listPatches() {
  const spinner = ora("Gathering patch information...").start();

  try {
    // Use our new git module for getting applied patches
    const appliedPatches = await getAppliedPatches();
    const baseBranch = await git.getBaseBranch();
    const baseRemote = await git.getBaseRemote();

    // Fetch latest refs and tags
    await git
      .execGit(["fetch", "--all", "--tags"], "Failed to fetch refs and tags")
      .catch((e) => {
        // Log but continue if fetch fails
        spinner.warn(`Could not fetch latest refs: ${e.message}`);
      });

    // Get the current base branch hash for comparison
    const currentBaseBranchHash = await git.execGit(
      ["rev-parse", `${baseRemote}/${baseBranch}`],
      "Failed to get current base branch commit hash"
    );

    // Get verification information
    const repositories = await git.getRegisteredRepositories();
    const verifiedRepos = await fetchVerifiedRepositories();
    const verifiedRepoMap = new Map(verifiedRepos.map((r) => [r.url, r]));

    // Create a map from repo name to verification status
    const repoVerificationMap = new Map();
    for (const repo of repositories) {
      repoVerificationMap.set(
        repo.name,
        verifiedRepoMap.has(repo.url) ? verifiedRepoMap.get(repo.url) : null
      );
    }

    spinner.succeed("Patch information gathered");

    console.log("\nCurrently applied patches:");
    if (appliedPatches.length === 0) {
      console.log("  No patches applied");
    } else {
      for (const patch of appliedPatches) {
        const patchName = typeof patch === "string" ? patch : patch.name;
        const version = patch.version ? ` v${patch.version}` : "";

        // Skip non-namespaced patches if they somehow exist in the history
        if (!patchName.includes("/")) {
          console.log(
            chalk.yellow(
              `  - ${patchName}${version} (legacy format not supported)`
            )
          );
          continue;
        }

        // Extract repository name from patch
        const [repoName, ...patchNameParts] = patchName.split("/");
        const patchNamePart = patchNameParts.join("/");

        // Check if this repository is verified
        const verifiedInfo = repoVerificationMap.get(repoName);
        const verifiedBadge = verifiedInfo ? chalk.green(" [✓ Verified]") : "";

        // Line 1: Patch name, version and verification status
        const patchLine = `  - ${patchName}${version}${verifiedBadge}`;
        process.stdout.write(chalk.green(patchLine));

        // Check if a newer version is available
        let updateMessage = "";
        if (patch.version) {
          try {
            // Create tag-compatible name
            const tagCompatibleName = git.getTagCompatibleName(
              `${repoName}/${patchNamePart}`
            );

            // Get all tags for this patch using the tag-compatible name
            const tags = await utils.execGit(
              ["tag", "-l", `${tagCompatibleName}-v*`],
              "Failed to list versions"
            );

            if (tags) {
              const versions = tags
                .split("\n")
                .map((tag) => tag.replace(`${tagCompatibleName}-v`, ""))
                .filter(Boolean)
                .map((ver) => {
                  const [major, minor, patch] = ver.split(".").map(Number);
                  return { major, minor, patch, original: ver };
                })
                .sort((a, b) => {
                  if (a.major !== b.major) return b.major - a.major;
                  if (a.minor !== b.minor) return b.minor - a.minor;
                  return b.patch - a.patch;
                });

              if (versions.length > 0) {
                const latest = versions[0].original;
                const current = patch.version;

                // Compare versions
                if (latest !== current) {
                  updateMessage = ` (update to v${latest} is available)`;
                  process.stdout.write(chalk.cyan(updateMessage));
                }
              }
            }
          } catch (e) {
            // Silently continue if we can't check for updates
          }
        }

        console.log(); // End the line

        // Additional metadata
        if (patch.originalCommitHash) {
          console.log(
            chalk.gray(
              `    Mod Commit: ${patch.originalCommitHash.substring(0, 8)}`
            )
          );
        }

        // Check if mod base branch hash is different from current base
        if (patch.modBaseBranchHash) {
          const isOutdated = patch.modBaseBranchHash !== currentBaseBranchHash;
          console.log(
            chalk[isOutdated ? "yellow" : "gray"](
              `    Mod Base: ${patch.modBaseBranchHash.substring(0, 8)}${
                isOutdated ? " (different from current base)" : ""
              }`
            )
          );
        }

        if (patch.currentBaseBranchHash) {
          console.log(
            chalk.gray(
              `    Applied on Base: ${patch.currentBaseBranchHash.substring(
                0,
                8
              )}`
            )
          );
        }

        // Get mod commit date and display in relative time
        try {
          // First try to use the mod's original commit hash
          let commitHash = patch.originalCommitHash;

          // If not available, try to find it in the commit history
          if (!commitHash) {
            try {
              commitHash = await utils.execGit(
                ["log", "-1", "--format=%H", "--grep", `^cow: ${patchName}$`],
                `Failed to get commit hash for ${patchName}`
              );
            } catch (e) {
              // Skip if we can't find the commit
            }
          }

          if (commitHash) {
            // Get the commit timestamp
            const commitTimestamp = await utils.execGit(
              ["log", "-1", "--format=%at", commitHash],
              `Failed to get timestamp for ${commitHash}`
            );

            if (commitTimestamp) {
              const relativeTime = utils.getRelativeTime(
                parseInt(commitTimestamp) * 1000
              );
              console.log(chalk.gray(`    Committed: ${relativeTime}`));
            }
          }

          // Also try to get author information
          const { author, relativeTime } = await getPatchInfo(
            patchNamePart, // Get just the patch name without repo prefix
            repoName // Get the repo name
          );

          // Add Discord ID for verified repository owners
          let authorInfo = `Author: ${author}, Created: ${relativeTime}`;
          if (verifiedInfo) {
            authorInfo += `, Verified`;
          }

          console.log(chalk.gray(`    ${authorInfo}`));
        } catch (error) {
          // Skip author info if not available
        }
      }
    }

    // Also display current base branch information
    const currentBranch = await utils.getCurrentBranch();
    console.log(chalk.blue(`\nBranch information:`));
    console.log(`  Current branch: ${currentBranch}`);
    console.log(`  Base branch: ${baseBranch} (${baseRemote})`);

    try {
      const baseCommitHash = await utils.execGit(
        ["rev-parse", `${baseRemote}/${baseBranch}`],
        "Failed to get base commit hash"
      );
      console.log(`  Base commit: ${baseCommitHash.substring(0, 8)}`);

      // Get the commit date and format as relative time
      const commitTimestamp = await utils.execGit(
        ["log", "-1", "--format=%at", baseCommitHash],
        `Failed to get timestamp for ${baseCommitHash}`
      );

      if (commitTimestamp) {
        const relativeTime = utils.getRelativeTime(
          parseInt(commitTimestamp) * 1000
        );
        console.log(`  Last updated: ${relativeTime}`);
      }

      // Check if base is up to date
      const behindCount = await utils.execGit(
        ["rev-list", "--count", `HEAD..${baseRemote}/${baseBranch}`],
        "Failed to check if base branch is behind"
      );

      if (parseInt(behindCount.trim()) > 0) {
        console.log(
          chalk.yellow(
            `  Base is ${behindCount.trim()} commits ahead of current branch`
          )
        );
      } else {
        console.log(chalk.green(`  Base is up to date`));
      }
    } catch (error) {
      console.log(
        chalk.red(
          `  Could not determine base commit information: ${error.message}`
        )
      );
    }
  } catch (error) {
    if (spinner) spinner.fail(`Failed to list patches: ${error.message}`);
    else console.error(`Failed to list patches: ${error.message}`);
    throw error;
  }
}

async function resetPatches() {
  const spinner = ora("Starting reset process...").start();
  try {
    const baseBranch = await git.getBaseBranch();
    const baseRemote = await git.getBaseRemote();
    spinner.text = `Removing all patches and upgrading to latest base version from ${baseRemote}...`;

    // Get current branch name before proceeding
    const currentBranch = await git.getCurrentBranch();

    // Get base branch upstream configuration
    let originalBaseBranch;
    try {
      const upstream = await git.execGit(
        ["rev-parse", "--abbrev-ref", `${baseBranch}@{upstream}`],
        "Failed to get base branch upstream"
      );
      originalBaseBranch = upstream.replace(`${baseRemote}/`, "");
      spinner.text = `Found base branch upstream: ${originalBaseBranch}`;
    } catch (e) {
      // No upstream set for base branch, use the base branch itself
      originalBaseBranch = baseBranch;
      spinner.text = `Using default base branch: ${baseBranch}`;
    }

    // Checkout and clean base branch
    await git.checkoutBranch(baseBranch);

    // Try to delete the current branch if it exists
    try {
      await git.deleteBranch(currentBranch, true);
      spinner.text = `Deleted branch ${currentBranch}`;
    } catch (e) {
      spinner.text = `Branch ${currentBranch} does not exist`;
    }

    // Sync with remote
    spinner.text = "Syncing with remote repository...";
    await utils.syncBranches(); // Keep this for now

    // Create new branch with the same name as before
    spinner.text = "Recreating branch...";
    await git.createBranch(currentBranch, baseBranch);

    // Continue with rest of the function...
  } catch (error) {
    spinner.fail(`Reset failed: ${error.message}`);
    throw error;
  }
}

// Modified function to detect switch-type variables in .env.example
async function findEnvVariables(envFile) {
  const content = await fs.readFile(envFile, "utf-8");
  const vars = dotenv.parse(content);

  // Parse regular and switch-type variables
  const variables = [];

  for (const [key, value] of Object.entries(vars)) {
    // Check if this is a switch-type variable (format: "SWITCH_TYPE=<option1|option2|option3>")
    const switchMatch = value.match(/^<(.+)>$/);

    if (switchMatch) {
      // This is a switch type variable
      const options = switchMatch[1].split("|").map((opt) => opt.trim());
      variables.push({
        key,
        type: "switch",
        options,
        defaultValue: options[0],
      });
    } else if (value === "") {
      // This is an empty variable that needs a value
      variables.push({
        key,
        type: "input",
        value: "",
      });
    }
    // If the variable already has a value, we don't prompt for it
  }

  return variables;
}

async function writeEnvFile(envFile, variables) {
  const content = await fs.readFile(envFile, "utf-8");
  let newContent = content;

  for (const [key, value] of Object.entries(variables)) {
    // For switch types in the original file (<option1|option2>), replace with the selected value
    // For regular empty variables, replace the empty value with the provided one
    const switchRegex = new RegExp(`${key}=<[^>]+>`);
    const emptyRegex = new RegExp(`${key}=.*`);

    if (newContent.match(switchRegex)) {
      newContent = newContent.replace(switchRegex, `${key}=${value}`);
    } else {
      newContent = newContent.replace(emptyRegex, `${key}=${value}`);
    }
  }

  await fs.writeFile(".env", newContent);
}

async function setupEnvironment(spinner) {
  spinner.start("Setting up environment...");

  try {
    // Copy environment file
    await execa("cp", [".env.example", ".env"]);

    // Find variables in .env.example that need configuration
    const variables = await findEnvVariables(".env.example");

    if (variables.length > 0) {
      spinner.info("Some environment variables need to be configured");
      const values = await promptForEnvVariables(variables);

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

async function syncPatches(options = {}) {
  const spinner = ora("Starting mod synchronization...").start();

  try {
    // Safety checks: Get current branch name
    const currentBranch = await utils.getCurrentBranch();
    const baseBranch = await utils.getBaseBranch();

    // Check if we're on a cow_ branch
    if (currentBranch.startsWith("cow_")) {
      spinner.fail(`Cannot run sync on a patch branch (${currentBranch})`);
      log("The sync command should not be run on patch branches.", "error");
      log("These branches contain the official releases of mods.", "warning");
      log(
        "Please checkout your main feature branch before running this command.",
        "info"
      );
      return;
    }

    // Check if we're on a mod development branch by checking git config
    try {
      const configKey = `hyperfy.mod.${currentBranch}.patchName`;
      const configuredPatchName = await utils.execGit(
        ["config", "--get", configKey],
        "Failed to get patch name from git config"
      );

      if (configuredPatchName && configuredPatchName.trim()) {
        spinner.fail(
          `Cannot run sync on a mod development branch (${currentBranch})`
        );
        log(
          "The sync command should not be run on mod development branches.",
          "error"
        );
        log(
          `Branch '${currentBranch}' is registered as a development branch for mod '${configuredPatchName.trim()}'.`,
          "warning"
        );
        log(
          "Please checkout your main feature branch before running this command.",
          "info"
        );
        return;
      }
    } catch (error) {
      // Git config not set, continue with other checks
    }

    if (["dev", "develop", "development"].includes(currentBranch)) {
      spinner.fail(
        `Cannot run sync on a development branch (${currentBranch})`
      );
      log(
        "The sync command should not be run on development branches.",
        "error"
      );
      log(
        "Please checkout your main feature branch before running this command.",
        "info"
      );
      return;
    }

    // Also prevent running on base branches
    if (currentBranch === baseBranch) {
      spinner.fail(`Cannot run sync on the base branch (${baseBranch})`);
      log(
        "The sync command should be run on a feature branch, not the base branch.",
        "error"
      );
      log(
        "Please checkout your feature branch before running this command.",
        "info"
      );
      return;
    }

    // Store initial state before any operations
    const initialState = await utils.saveGitState();

    // Store the list of patches with their complete metadata
    spinner.text = "Getting currently applied patches...";
    const appliedPatches = await getAppliedPatches();

    // Fetch latest tags and refs to check for newer versions
    spinner.text = "Fetching latest tags and refs...";
    await utils
      .execGit(["fetch", "--all", "--tags"], "Failed to fetch updates")
      .catch((e) => {
        // Log but continue if fetch fails
        spinner.warn(`Could not fetch latest refs: ${e.message}`);
      });

    try {
      // Reset to base branch
      spinner.text = "Resetting to base branch...";
      await resetPatches();

      // Reapply each mod with proper metadata, checking for newer versions
      const failedPatches = [];
      const updatedPatches = [];

      for (const patch of appliedPatches) {
        // Extract all the needed metadata
        const patchName = patch.name;
        const originalVersion = patch.version;
        const originalCommitHash = patch.originalCommitHash;
        const modBaseBranchHash = patch.modBaseBranchHash;

        spinner.text = `Checking for updates to mod ${patchName}${
          originalVersion ? ` v${originalVersion}` : ""
        }...`;

        try {
          // Require namespaced patches - breaking change
          if (!patchName.includes("/")) {
            throw new Error(
              `Non-namespaced patch "${patchName}" is no longer supported. Please use the format "repository/patchName".`
            );
          }

          // Extract the remote and patch name from the namespaced format
          const parts = patchName.split("/");
          const remoteName = parts[0];
          const patchNameOnly = parts.slice(1).join("/");

          // Get the tag-compatible name for version checking
          const tagCompatibleName = git.getTagCompatibleName(patchName);

          // Check if a newer version is available
          let latestVersion = originalVersion;
          let shouldUseLatestVersion = false;

          if (originalVersion) {
            // Check for newer versions
            const allVersions = await getAvailableVersions(tagCompatibleName);

            if (allVersions.length > 0 && allVersions[0] !== originalVersion) {
              latestVersion = allVersions[0];

              // Ask user if they want to update to the newer version
              if (!options.nonInteractive) {
                spinner.stop(); // Pause spinner for user input

                const { updateToLatest } = await inquirer.prompt([
                  {
                    type: "confirm",
                    name: "updateToLatest",
                    message: `Newer version available for ${patchName}: v${latestVersion} (current: v${originalVersion}). Update?`,
                    default: true,
                  },
                ]);

                shouldUseLatestVersion = updateToLatest;
                spinner.start(); // Resume spinner
              } else if (options.autoUpdate) {
                // Auto-update if configured
                shouldUseLatestVersion = true;
                spinner.info(
                  `Auto-updating ${patchName} from v${originalVersion} to v${latestVersion}`
                );
              } else {
                // Default to keeping current version
                spinner.info(
                  `Newer version v${latestVersion} available for ${patchName}, keeping v${originalVersion} (use --auto-update to upgrade)`
                );
              }
            }
          }

          // Determine which version to use
          const versionToUse = shouldUseLatestVersion
            ? latestVersion
            : originalVersion;

          if (versionToUse) {
            // Handle versioned patch
            spinner.text = `Applying versioned patch ${patchName} v${versionToUse}...`;

            try {
              // Apply the changes via cherry-pick but with custom commit
              await utils.execGit(
                ["cherry-pick", "-n", `${tagCompatibleName}-v${versionToUse}`],
                "Failed to apply mod version"
              );

              // Get base branch hash for metadata
              const baseRemote = await git.getBaseRemote();
              const currentBaseBranchHash = await utils.execGit(
                ["rev-parse", `${baseRemote}/${baseBranch}`],
                "Failed to get current base branch commit hash"
              );

              // Handle any package changes
              await utils.handlePackageChanges();
              await utils.execGit(["add", "."], "Failed to stage changes");

              // Create an enhanced commit message with proper metadata
              const enhancedCommitMessage =
                await git.generateEnhancedCommitMessage(
                  patchName,
                  versionToUse,
                  originalCommitHash,
                  modBaseBranchHash,
                  currentBaseBranchHash
                );

              // Commit with the enhanced message
              await utils.execGit(
                ["commit", "-m", enhancedCommitMessage],
                "Failed to commit changes"
              );

              if (shouldUseLatestVersion) {
                updatedPatches.push({
                  name: patchName,
                  oldVersion: originalVersion,
                  newVersion: versionToUse,
                });
              }
            } catch (e) {
              spinner.warn(
                `Failed to apply versioned patch, aborting: ${e.message}`
              );
              await utils
                .execGit(
                  ["cherry-pick", "--abort"],
                  "Failed to abort cherry-pick"
                )
                .catch(() => {}); // Ignore errors if no cherry-pick in progress
              throw e;
            }
          } else {
            // Apply non-versioned patch using the robust function
            const cleanPatchName = patchNameOnly.startsWith("cow_")
              ? patchNameOnly
              : `cow_${patchNameOnly}`;

            await applyPatchFromRepo(cleanPatchName, remoteName);
          }

          // await setupEnvironment(spinner);
        } catch (e) {
          spinner.fail(`Failed to reapply ${patchName}: ${e.message}`);
          failedPatches.push({
            name: patchName,
            error: e.message,
          });
        }
      }

      // [Rest of the function remains the same...]
      if (failedPatches.length > 0) {
        spinner.warn(
          "Some patches failed to reapply. Restoring original state..."
        );
        // Restore to initial state
        await utils.restoreGitState(initialState);

        // Show which patches failed
        spinner.warn("The following patches failed to reapply:");
        failedPatches.forEach((patch) => {
          console.log(chalk.yellow(`  - ${patch.name}: ${patch.error}`));
        });

        log("Your repository has been restored to its original state.", "info");
      } else {
        spinner.succeed("Successfully synchronized all patches");

        // Show summary of updates
        if (updatedPatches.length > 0) {
          console.log(chalk.green("\nUpdated patches:"));
          updatedPatches.forEach((patch) => {
            console.log(
              chalk.green(
                `  - ${patch.name}: v${patch.oldVersion} → v${patch.newVersion}`
              )
            );
          });
        }
      }

      // Show final patch list
      await listPatches();
    } catch (e) {
      spinner.fail(`Sync process failed: ${e.message}`);

      // Restore to initial state
      spinner.info("Restoring to original state...");
      await utils.restoreGitState(initialState);

      log("Your repository has been restored to its original state.", "info");
      throw e;
    }
  } catch (e) {
    spinner.fail(`Sync failed: ${e.message}`);
    throw e;
  }
}

/**
 * Get all available versions for a patch, sorted newest first
 * @param {string} tagCompatibleName - The tag-compatible name of the patch
 * @returns {Promise<string[]>} - Array of version strings, sorted newest first
 */
async function getAvailableVersions(tagCompatibleName) {
  try {
    // Ensure we have the latest tags
    await utils.execGit(
      ["fetch", "--all", "--tags"],
      "Failed to fetch updates"
    );

    // Get all version tags for this patch
    const tags = await utils.execGit(
      ["tag", "-l", `${tagCompatibleName}-v*`],
      "Failed to list versions"
    );

    if (!tags) {
      return [];
    }

    // Parse and sort versions
    const versions = tags
      .split("\n")
      .map((tag) => tag.replace(`${tagCompatibleName}-v`, ""))
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

    // Return sorted version strings
    return versions.map((v) => v.original);
  } catch (error) {
    console.warn(
      `Error getting versions for ${tagCompatibleName}: ${error.message}`
    );
    return [];
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
      for (const patchName of selectedPatches) {
        // Ensure patch name is properly namespaced
        if (!isNamespacedPatch(patchName)) {
          throw new Error(
            `Invalid patch name format: ${patchName}. Expected format: 'repository/patchName'`
          );
        }

        // Parse the patch name to get remote and name
        const { remote, patchName: parsedName } = await parsePatchName(
          patchName
        );

        // Format the patch name for the remote
        const cleanPatchName = parsedName.startsWith("cow_")
          ? parsedName
          : `cow_${parsedName}`;

        // Apply the patch from the specified remote
        await applyPatchFromRepo(cleanPatchName, remote);
      }
    }

    // await setupEnvironment(spinner);

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
/**
 * Check if there are meaningful changes between current state and base branch
 * @param {string} baseBranch - The name of the base branch
 * @param {string} baseRemote - The name of the base remote
 * @returns {Promise<boolean>} - True if there are significant changes
 */
async function hasSignificantChanges() {
  try {
    // Get the diff stats to see how many files were changed and how extensively
    const diffStats = await utils.execGit(
      ["diff", "--stat", "HEAD@{1}", "HEAD"],
      "Failed to get diff stats"
    );

    // If no diff or only whitespace/timestamp changes
    if (!diffStats.trim() || diffStats.includes("0 files changed")) {
      return false;
    }

    // Check if only package-lock.json was modified
    const changedFiles = await utils.execGit(
      ["diff", "--name-only", "HEAD@{1}", "HEAD"],
      "Failed to get changed files"
    );

    const files = changedFiles.split("\n").filter(Boolean);
    if (files.length === 1 && files[0] === "package-lock.json") {
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      `Failed to determine if changes are significant: ${error.message}`
    );
    // Default to true to be safe
    return true;
  }
}



/**
 * Updates a development branch with the latest base changes
 * This function works with any branch naming convention
 *
 * @param {string} branchName - Name of the branch to update
 * @param {object} options - Command options
 * @returns {Promise<object>} - Result with success status and change information
 */
async function updateBranch(branchName, options = {}) {
  const spinner = ora(`Updating ${branchName}...`).start();
  let changesStashed = false;

  try {
    // Get the patch name associated with this branch
    const patchName = await getPatchNameForBranch(branchName);
    spinner.text = `Updating branch ${branchName} for patch ${patchName}...`;

    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await git.getBaseRemote();
    const currentBranch = await utils.getCurrentBranch();

    // Verify we're on the target branch
    if (currentBranch !== branchName) {
      spinner.text = `Switching to branch ${branchName}...`;
      await utils.execGit(
        ["checkout", branchName],
        `Failed to checkout branch ${branchName}`
      );
    }

    // Stash any uncommitted changes
    spinner.text = "Checking for uncommitted changes...";
    changesStashed = await git.stashChanges();
    if (changesStashed) {
      spinner.info("Uncommitted changes stashed");
    }

    // Fetch latest changes from the appropriate remote
    spinner.text = `Fetching latest changes from ${baseRemote}...`;
    await utils.execGit(
      ["fetch", baseRemote],
      `Failed to fetch updates from ${baseRemote}`
    );

    // Attempt to rebase on the appropriate remote base branch
    spinner.text = `Rebasing on ${baseRemote}/${baseBranch}...`;
    let hadConflicts = false;
    try {
      await utils.execGit(
        ["rebase", `${baseRemote}/${baseBranch}`],
        "Failed to rebase on base branch"
      );
    } catch (e) {
      // Handle rebase conflicts
      spinner.warn(
        "Conflicts detected during rebase, attempting resolution..."
      );
      hadConflicts = true;
      const hasLockConflict = await utils.handlePackageChanges();

      if (!hasLockConflict) {
        const hasOtherConflicts = await utils.execGit(
          ["diff", "--name-only", "--diff-filter=U"],
          "Failed to check conflicts"
        );

        if (hasOtherConflicts) {
          spinner.fail("Unresolved conflicts detected");

          // Try to abort the rebase
          try {
            await utils.execGit(
              ["rebase", "--abort"],
              "Failed to abort rebase"
            );
          } catch (abortError) {
            // Ignore errors if no rebase is in progress
          }

          // Restore stashed changes
          if (changesStashed) {
            await git.popStashedChanges(changesStashed);
          }

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

    // Check if there are significant changes
    spinner.text = "Analyzing changes...";
    const hasChanges = hadConflicts || (await hasSignificantChanges());

    spinner.succeed(
      `Successfully updated ${branchName} from ${baseRemote}/${baseBranch}`
    );

    // Handle interactive mode or auto-release based on whether there are changes
    if (!options.nonInteractive && !options.autoRelease) {
      spinner.stop(); // Stop spinner during interactive prompts
      const action = await promptForAction(patchName, hasChanges);

      if (action === "release") {
        // Release the updated patch
        await releaseBranch(branchName, patchName, { spinner });
      }
    } else if (options.autoRelease && hasChanges) {
      // Auto-release only if there were significant changes
      spinner.info("Significant changes detected, creating new release...");
      await releaseBranch(branchName, patchName, { spinner });
    } else if (options.autoRelease && !hasChanges) {
      spinner.info("No significant changes detected, skipping release");
    }

    // Restore stashed changes if any
    if (changesStashed) {
      spinner.text = "Restoring stashed changes...";
      await git.popStashedChanges(changesStashed);
      spinner.succeed("Stashed changes restored");
    }

    return {
      success: true,
      hadChanges: hasChanges,
      patchName: patchName,
    };
  } catch (error) {
    spinner.fail(`Update failed: ${error.message}`);

    // Abort any pending rebase
    try {
      await utils.execGit(["rebase", "--abort"], "Failed to abort rebase");
    } catch (e) {
      // Ignore error if no rebase in progress
    }

    // Restore stashed changes if any
    if (changesStashed) {
      spinner.text = "Restoring stashed changes...";
      await git.popStashedChanges(changesStashed);
      spinner.info("Stashed changes restored");
    }

    throw error;
  }
}

/**
 * Create a release from any branch
 *
 * @param {string} sourceBranch - Source branch to release from
 * @param {string} patchName - Name of the patch (optional, will be determined if not provided)
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Result with success status and version
 */
async function releaseBranch(sourceBranch, patchName = null, options = {}) {
  // Use existing spinner or create a new one
  const spinner =
    options.spinner || ora(`Preparing release from ${sourceBranch}...`).start();

  try {
    // Get the patch name if not provided
    if (!patchName) {
      patchName = await getPatchNameForBranch(sourceBranch);
    }

    // Get target repository
    spinner.text = `Determining target repository for ${patchName}...`;
    let targetRepo;

    if (options.repository) {
      targetRepo = options.repository;
    } else {
      // If we can't do interactive selection, use stored preference or default
      if (options.nonInteractive) {
        targetRepo = await getRepositoryForPatch(patchName, false);
      } else {
        spinner.stop();
        targetRepo = await getRepositoryForPatch(patchName, true);
        spinner.start();
      }
    }

    spinner.text = `Preparing release for ${patchName} to ${targetRepo}...`;

    // Create the tag-compatible name
    const tagCompatibleName = git.getTagCompatibleName(
      `${targetRepo}/${patchName}`
    );

    // Create release branch name (always with cow_ prefix)
    const releaseBranch = git.getPatchBranchName(patchName);

    // Get the next version number
    spinner.text = "Determining next version number...";
    await utils.execGit(
      ["fetch", "--all", "--tags"],
      "Failed to fetch updates"
    );

    // Use tag-compatible name for version lookup
    const version = await getNextPatchVersion(tagCompatibleName);

    spinner.text = `Preparing release v${version} to ${targetRepo}...`;

    // Remember the current state
    const initialState = await utils.saveGitState();

    // Get base branch to use as clean slate
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await git.getBaseRemote();

    // Check if release branch exists and create backup if needed
    const branches = (
      await utils.execGit(["branch"], "Failed to list branches")
    )
      .split("\n")
      .map((branch) => branch.trim().replace("* ", ""))
      .filter(Boolean);

    let backupCreated = false;
    let backupBranch = "";

    // If release branch exists, create a backup branch
    if (branches.includes(releaseBranch)) {
      // MODIFIED: Changed the backup branch naming scheme to include repository name
      backupBranch = `cow_${targetRepo}_${patchName}_v${version}`;
      spinner.text = `Creating backup branch ${backupBranch}...`;
      await utils.execGit(
        ["branch", backupBranch, releaseBranch],
        "Failed to create backup branch"
      );
      backupCreated = true;
    }

    // Create/reset release branch from base
    if (branches.includes(releaseBranch)) {
      // Checkout and reset release branch
      await utils.execGit(
        ["checkout", releaseBranch],
        "Failed to checkout release branch"
      );
      await utils.execGit(
        ["reset", "--hard", `${baseRemote}/${baseBranch}`],
        "Failed to reset release branch"
      );
    } else {
      // Create new release branch from base
      await utils.execGit(
        ["checkout", "-b", releaseBranch, `${baseRemote}/${baseBranch}`],
        "Failed to create release branch"
      );
    }

    // Squash merge all changes from source branch
    spinner.text = "Merging changes...";
    try {
      await utils.execGit(
        ["merge", "--squash", sourceBranch],
        "Failed to merge source changes"
      );
      await utils.execGit(
        ["commit", "-m", `${patchName} v${version}`],
        "Failed to commit release"
      );
    } catch (e) {
      // Handle conflicts
      spinner.warn("Conflicts detected, attempting resolution...");
      await utils.handlePackageChanges();

      const hasOtherConflicts = await utils.execGit(
        ["diff", "--name-only", "--diff-filter=U"],
        "Failed to check conflicts"
      );

      if (hasOtherConflicts) {
        spinner.fail("Unresolved conflicts detected");
        // Restore to initial state
        await utils.restoreGitState(initialState);
        throw new Error(
          "Merge conflicts detected. Please resolve conflicts manually and try again."
        );
      }

      await utils.execGit(["add", "."], "Failed to stage changes");
      await utils.execGit(
        ["commit", "-m", `${patchName} v${version}`],
        "Failed to commit release"
      );
    }

    // Create version tag using the tag-compatible name
    spinner.text = "Creating version tag...";
    await utils.execGit(
      [
        "tag",
        "-a",
        `${tagCompatibleName}-v${version}`,
        "-m",
        `${patchName} version ${version}`,
      ],
      "Failed to create version tag"
    );

    // Push changes and tags to the specified repository
    spinner.text = `Pushing changes to ${targetRepo}...`;
    await utils.execGit(
      ["push", "-f", targetRepo, releaseBranch],
      "Failed to push release branch"
    );
    await utils.execGit(
      ["push", targetRepo, `${tagCompatibleName}-v${version}`],
      "Failed to push tag"
    );

    // Push backup branch if it exists
    if (backupCreated) {
      spinner.text = "Pushing backup branch...";
      await utils.execGit(
        ["push", "-f", targetRepo, backupBranch],
        "Failed to push backup branch"
      );
    }

    // Return to source branch
    await utils.execGit(
      ["checkout", sourceBranch],
      "Failed to return to original branch"
    );

    // Store metadata about the release
    try {
      // Save release repository in git config for future releases
      const configKey = `hyperfy.mod.${patchName}.repository`;
      await utils.execGit(
        ["config", configKey, targetRepo],
        "Failed to save repository preference"
      );
    } catch (error) {
      spinner.warn(
        `Note: Failed to save repository preference: ${error.message}`
      );
    }

    spinner.succeed(
      `Successfully created release ${patchName} v${version} in ${targetRepo}` +
        (backupCreated ? `\nBackup saved in ${backupBranch}` : "")
    );

    return {
      success: true,
      version,
      repository: targetRepo,
      patchName,
    };
  } catch (error) {
    spinner.fail(`Failed to create release: ${error.message}`);
    throw error;
  }
}

// Helper function to determine next version number for a patch
async function getNextPatchVersion(tagCompatibleName) {
  try {
    await utils.execGit(
      ["fetch", "--all", "--tags"],
      "Failed to fetch updates"
    );

    // Get all version tags for this patch
    // tagCompatibleName should already be in tag-compatible format
    const tags = await utils.execGit(
      ["tag", "-l", `${tagCompatibleName}-v*`],
      "Failed to list versions"
    );

    if (!tags) {
      return "1.0.0";
    }

    // Find highest version
    const versions = tags
      .split("\n")
      .map((tag) => tag.replace(`${tagCompatibleName}-v`, ""))
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
      `Error determining version for ${tagCompatibleName}, using 1.0.0:`,
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
  .command("release [branchName]")
  .description("Create a new release from the current or specified branch")
  .option("-r, --repository <repository>", "Target repository for the release")
  .action(async (branchName, options) => {
    try {
      const spinner = ora("Preparing release...").start();

      // Get current branch if no branch name is provided
      let sourceBranch = branchName;
      if (!sourceBranch) {
        sourceBranch = await utils.getCurrentBranch();
        spinner.text = `Using current branch: ${sourceBranch}`;
      }

      // Check if source branch is a base branch (main, master, dev, etc.)
      const baseBranch = await utils.getBaseBranch();
      const forbiddenBranches = [
        baseBranch,
        "main",
        "master",
        "dev",
        "develop",
        "development",
      ];

      if (forbiddenBranches.includes(sourceBranch)) {
        spinner.fail(
          `Cannot create a release from base branch: ${sourceBranch}`
        );
        throw new Error(
          "Please use a feature branch for releases, not a base branch"
        );
      }

      // First, update the source branch with the latest base branch changes
      // This ensures we catch and handle rebase conflicts early
      spinner.text = `Updating ${sourceBranch} with latest base branch changes...`;
      try {
        await updateBranch(sourceBranch, { ...options, nonInteractive: true });
        spinner.succeed(
          `Updated ${sourceBranch} with latest base branch changes`
        );
        spinner.start(`Proceeding with release...`);
      } catch (updateError) {
        spinner.fail(`Failed to update branch: ${updateError.message}`);
        throw new Error(
          `Cannot proceed with release until branch is updated with latest base branch changes. Please resolve conflicts and try again.`
        );
      }

      // Determine patch name based on branch name
      let patchName;

      // Case 2: Already a release branch (cow_patchName)
      if (sourceBranch.startsWith("cow_")) {
        patchName = sourceBranch.replace("cow_", "");
        spinner.text = `Using release branch directly. Patch name: ${patchName}`;
      }
      // Case 3: Regular branch name, use as-is for patch name
      else {
        patchName = sourceBranch;
        spinner.text = `Using branch name as patch name: ${patchName}`;
      }

      // Get target repository - either from options, or determine it
      let targetRepo;
      if (options.repository) {
        // Verify the specified repository exists
        const repositories = await git.getRegisteredRepositories();
        if (!repositories.some((repo) => repo.name === options.repository)) {
          spinner.fail(`Repository '${options.repository}' not found`);
          throw new Error(
            `Repository '${options.repository}' is not registered. Use 'repository add' to add it first.`
          );
        }
        targetRepo = options.repository;
      } else {
        spinner.stop(); // Pause spinner for interactive prompt

        // Determine the preferred repository interactively
        targetRepo = await getPreferredReleaseRepository(patchName);

        // Resume spinner
        spinner.start(`Using repository: ${targetRepo}`);
      }

      // Create release branch name (always with cow_ prefix)
      const releaseBranch = `cow_${patchName}`;

      // Get the next version number
      spinner.text = "Determining next version number...";
      await utils.execGit(
        ["fetch", "--all", "--tags"],
        "Failed to fetch updates"
      );

      // Create the tag-compatible name
      const tagCompatibleName = git.getTagCompatibleName(
        `${targetRepo}/${patchName}`
      );

      // Get the next version number
      spinner.text = "Determining next version number...";
      await utils.execGit(
        ["fetch", "--all", "--tags"],
        "Failed to fetch updates"
      );

      // Use tag-compatible name for version lookup
      const version = await getNextPatchVersion(tagCompatibleName);

      spinner.text = `Preparing release v${version} to ${targetRepo}...`;

      // Remember the current state
      const initialState = await utils.saveGitState();

      // Check if release branch exists and create backup if needed
      const branches = (
        await utils.execGit(["branch"], "Failed to list branches")
      )
        .split("\n")
        .map((branch) => branch.trim().replace("* ", ""))
        .filter(Boolean);

      let backupCreated = false;
      let backupBranch = "";

      // If release branch exists, create a backup branch
      if (branches.includes(releaseBranch)) {
        // MODIFIED: Changed the backup branch naming scheme to include repository name
        backupBranch = `cow_${targetRepo}_${patchName}_v${version}`;
        spinner.text = `Creating backup branch ${backupBranch}...`;
        await utils.execGit(
          ["branch", backupBranch, releaseBranch],
          "Failed to create backup branch"
        );
        backupCreated = true;
      }

      // Get base branch for clean slate
      const baseRemote = await git.getBaseRemote();

      // Create/reset release branch from base
      if (branches.includes(releaseBranch)) {
        // Checkout and reset release branch
        await utils.execGit(
          ["checkout", releaseBranch],
          "Failed to checkout release branch"
        );
        await utils.execGit(
          ["reset", "--hard", `${baseRemote}/${baseBranch}`],
          "Failed to reset release branch"
        );
      } else {
        await utils.execGit(
          ["checkout", "-b", releaseBranch, `${baseRemote}/${baseBranch}`],
          "Failed to create release branch"
        );
      }

      // Squash merge all changes from source branch
      spinner.text = "Merging changes...";
      try {
        await utils.execGit(
          ["merge", "--squash", sourceBranch],
          "Failed to merge source changes"
        );
        await utils.execGit(
          ["commit", "-m", `${patchName} v${version}`],
          "Failed to commit release"
        );
      } catch (e) {
        // Handle conflicts
        spinner.warn("Conflicts detected, attempting resolution...");
        await utils.handlePackageChanges();

        const hasOtherConflicts = await utils.execGit(
          ["diff", "--name-only", "--diff-filter=U"],
          "Failed to check conflicts"
        );

        if (hasOtherConflicts) {
          spinner.fail("Unresolved conflicts detected");
          // Restore initial state
          await utils.restoreGitState(initialState);
          throw new Error(
            "Merge conflicts detected. Please resolve conflicts manually and try again."
          );
        }

        await utils.execGit(["add", "."], "Failed to stage changes");
        await utils.execGit(
          ["commit", "-m", `${patchName} v${version}`],
          "Failed to commit release"
        );
      }

      // Create version tag
      spinner.text = "Creating version tag...";
      // const tagCompatibleName = git.getTagCompatibleName(
      //   `${targetRepo}/${patchName}`
      // );
      await utils.execGit(
        [
          "tag",
          "-a",
          `${tagCompatibleName}-v${version}`,
          "-m",
          `${patchName} version ${version}`,
        ],
        "Failed to create version tag"
      );

      // Push changes and tags to the specified repository
      spinner.text = `Pushing changes to ${targetRepo}...`;
      await utils.execGit(
        ["push", "-f", targetRepo, releaseBranch],
        "Failed to push release branch"
      );
      await utils.execGit(
        ["push", targetRepo, `${tagCompatibleName}-v${version}`],
        "Failed to push tag"
      );

      // Push backup branch if it exists
      if (backupCreated) {
        spinner.text = "Pushing backup branch...";
        await utils.execGit(
          ["push", "-f", targetRepo, backupBranch],
          "Failed to push backup branch"
        );
      }

      // Return to original branch
      await utils.execGit(
        ["checkout", sourceBranch],
        "Failed to return to original branch"
      );

      // Store metadata about the release
      try {
        // Save release repository in git config for future releases
        const configKey = `hyperfy.mod.${patchName}.repository`;
        await utils.execGit(
          ["config", configKey, targetRepo],
          "Failed to save repository preference"
        );
      } catch (error) {
        spinner.warn(
          `Note: Failed to save repository preference: ${error.message}`
        );
      }

      spinner.succeed(
        `Successfully created release ${patchName} v${version} in ${targetRepo}` +
          (backupCreated ? `\nBackup saved in ${backupBranch}` : "")
      );
    } catch (e) {
      console.error(`Failed to prepare release: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("apply [patchNames...]")
  .description("Apply one or more mods (format: repository/patch_name)")
  .option(
    "-v, --version <version>",
    "specific version to install (only for single patch)"
  )
  .action(async (patchNames, options) => {
    try {
      // If version is specified, ensure only one patch name is provided
      if (options.version && patchNames.length > 1) {
        throw new Error(
          "Version option can only be used when applying a single mod"
        );
      }

      // If no patch names provided, show interactive selection menu
      if (patchNames.length === 0) {
        // Get available patches from all repositories
        const allPatches = await searchPatches();

        if (allPatches.length === 0) {
          console.log("No patches available to apply.");
          return;
        }

        const patchChoices = await Promise.all(
          allPatches.map(async (patch) => {
            try {
              const { author, relativeTime } = await getPatchInfo(
                patch.name,
                patch.remote
              );
              // Always display with repository prefix
              const displayName = `${patch.remote}/${patch.name}`;
              return {
                name: `${displayName} (by ${author}, ${relativeTime})`,
                value: displayName,
              };
            } catch (error) {
              // Fallback if we can't get patch info
              const displayName = `${patch.remote}/${patch.name}`;
              return {
                name: displayName,
                value: displayName,
              };
            }
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

        if (selectedPatches.length === 0) {
          log("No patches selected to apply", "info");
          return;
        }
        patchNames = selectedPatches;
      }

      // Apply each patch in sequence
      for (const patchName of patchNames) {
        // Ensure patch name is properly namespaced
        if (!isNamespacedPatch(patchName)) {
          throw new Error(
            `Invalid patch name format: ${patchName}. Expected format: 'repository/patchName'`
          );
        }

        // Parse the patch name to get remote and name
        const { remote, patchName: parsedName } = await parsePatchName(
          patchName
        );

        // Format the patch name for the remote
        const cleanPatchName = parsedName.startsWith("cow_")
          ? parsedName
          : `cow_${parsedName}`;

        // Apply the patch from the specified remote
        if (options.version && patchNames.length === 1) {
          // For version-specific installation
          await applyPatchFromRepo(cleanPatchName, remote, options.version);
        } else {
          // Apply latest version
          await applyPatchFromRepo(cleanPatchName, remote);
        }
      }

      // After all patches have been applied, check for environment variables
      // const spinner = ora("Checking for environment variables...").start();
      // await setupEnvironment(spinner);

      // Display the list of all applied patches
      await listPatches();
    } catch (e) {
      console.error(`Failed to apply mod(s): ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("remove [patchNames...]")
  .description("Remove one or more mods")
  .action(async (patchNames) => {
    try {
      // If no patch names provided, show interactive selection menu
      if (patchNames.length === 0) {
        // Get currently applied patches using the enhanced function
        const appliedPatches = await getAppliedPatches();

        if (appliedPatches.length === 0) {
          log("No patches are currently applied", "info");
          return;
        }

        const patchChoices = appliedPatches.map((patch) => {
          // Handle both string and object formats
          const name = typeof patch === "string" ? patch : patch.name;
          const version =
            typeof patch === "object" && patch.version
              ? ` v${patch.version}`
              : "";

          // Clean up the name for display
          const displayName = name.replace(/^cow_/, "");

          return {
            name: `${displayName}${version}`,
            value: name,
          };
        });

        const { selectedPatches } = await inquirer.prompt([
          {
            type: "checkbox",
            name: "selectedPatches",
            message: "Select patches to remove:",
            choices: patchChoices,
            pageSize: 10,
            validate: (answer) => {
              if (answer.length === 0) {
                return "You must select at least one patch to remove.";
              }
              return true;
            },
          },
        ]);

        if (selectedPatches.length === 0) {
          log("No patches selected to remove", "info");
          return;
        }
        patchNames = selectedPatches;
      }

      // Remove each patch in sequence
      for (const patchName of patchNames) {
        const cleanPatchName = patchName.replace(/^cow_/, "");
        await removePatch(cleanPatchName);
      }

      // Display the list of remaining applied patches
      await listPatches();
    } catch (e) {
      console.error(`Failed to remove mod(s): ${e.message}`);
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
  .description(
    "Search for patches across all repositories (lists all if no name provided)"
  )
  .action(async (patchName) => {
    try {
      const patches = await searchPatches(patchName);
      console.log("\nAvailable patches:");

      if (patches.length === 0) {
        console.log("  No patches found");
        return;
      }

      // Group patches by repository for better display
      const patchesByRepo = {};
      for (const patch of patches) {
        if (!patchesByRepo[patch.remote]) {
          patchesByRepo[patch.remote] = [];
        }
        patchesByRepo[patch.remote].push(patch.name);
      }

      // Get repository information for verification badges
      const repositories = await git.getRegisteredRepositories();
      const verifiedRepos = await fetchVerifiedRepositories();
      const verifiedRepoMap = new Map(verifiedRepos.map((r) => [r.url, r]));

      // If a specific mod is searched, show its versions too
      if (patchName) {
        for (const [repo, repoPatches] of Object.entries(patchesByRepo)) {
          for (const patch of repoPatches) {
            await utils.execGit(
              ["fetch", "--all", "--tags"],
              "Failed to fetch updates"
            );

            // Use tag-compatible name for tag list
            const tagCompatibleName = git.getTagCompatibleName(
              `${repo}/${patch}`
            );

            // Get tag list using the tag-compatible name
            const tagsOutput = await utils.execGit(
              [
                "tag",
                "-l",
                `${tagCompatibleName}-v*`,
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
                  version: tag.replace(`${tagCompatibleName}-v`, ""),
                  tagger: tagger.trim(),
                  date: date.trim(),
                  description: subject.trim(),
                };
              });

            // First show the mod info
            const { author, relativeTime } = await getPatchInfo(patch, repo);
            // Display with repository prefix
            const displayName = `${repo}/${patch}`;
            console.log(chalk.cyan(`  ${displayName}`));
            console.log(`    Author: ${author}`);
            console.log(`    Created: ${relativeTime}`);
            console.log(`    Repository: ${repo}`);

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
          }
        }
      } else {
        // Show all patches organized by repository
        for (const [repo, repoPatches] of Object.entries(patchesByRepo)) {
          // Find this repository in our list to get its URL
          const repoObj = repositories.find((r) => r.name === repo);
          const isVerified = repoObj && verifiedRepoMap.has(repoObj.url);

          // Create verification badge if repository is verified
          const verifiedBadge = isVerified ? chalk.green(` [✓ Verified]`) : "";

          // Display repository header with verification status
          console.log(chalk.blue(`\n${repo}:${verifiedBadge}`));

          // Show patches from this repository
          for (const patch of repoPatches) {
            const { author, relativeTime } = await getPatchInfo(patch, repo);
            console.log(`  - ${patch} (by ${author}, ${relativeTime})`);
          }
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
  .option("-n, --non-interactive", "Skip interactive prompts")
  .option(
    "-u, --auto-update",
    "Automatically update to the latest version of each patch"
  )
  .action(async (options) => {
    try {
      await syncPatches(options);
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

// List of commands that don't require project validation
const commandsWithoutValidation = ["install", "extract", "bundle", "github"];

// Add repository management commands
const repoCommand = new Command("repository").description(
  "Repository management commands"
);

repoCommand
  .command("add <name> [url]")
  .description("Add a new mod repository")
  .action(async (name, url) => {
    try {
      const success = await addRepository(name, url);
      if (success) {
        log(`Repository '${name}' added successfully`, "success");
        await listRepositories();
      }
    } catch (e) {
      console.error(`Failed to add repository: ${e.message}`);
      process.exit(1);
    }
  });

repoCommand
  .command("remove <name>")
  .description("Remove a mod repository")
  .action(async (name) => {
    try {
      const success = await removeRepository(name);
      if (success) {
        log(`Repository '${name}' removed successfully`, "success");
        await listRepositories();
      }
    } catch (e) {
      console.error(`Failed to remove repository: ${e.message}`);
      process.exit(1);
    }
  });

repoCommand
  .command("list")
  .description("List all registered mod repositories")
  .option("--github-info", "Show GitHub metadata (stars, forks, etc.)")
  .action(async (options) => {
    try {
      await listRepositories(options);
    } catch (e) {
      console.error(`Failed to list repositories: ${e.message}`);
      process.exit(1);
    }
  });

program.addCommand(repoCommand);

// Add GitHub integration commands
const githubCommand = new Command("github").description(
  "GitHub integration commands"
);

githubCommand
  .command("browse-forks [repository]")
  .description("Browse forks of a repository (format: owner/repo, defaults to origin if in git repo)")
  .option("-l, --list", "List forks without interactive selection")
  .action(async (repository, options) => {
    try {
      await browseForks(repository, options);
    } catch (e) {
      console.error(`Failed to browse forks: ${e.message}`);
      process.exit(1);
    }
  });

githubCommand
  .command("add <repository>")
  .description("Add a GitHub repository (format: owner/repo)")
  .action(async (repository) => {
    try {
      await addGitHubRepository(repository);
    } catch (e) {
      console.error(`Failed to add repository: ${e.message}`);
      process.exit(1);
    }
  });

program.addCommand(githubCommand);

// Update commandGroups to include repository management and GitHub
commandGroups.repo = {
  description: "Repository Management:",
  commands: ["repository add", "repository remove", "repository list"],
};

commandGroups.github = {
  description: "GitHub Integration:",
  commands: ["github browse-forks", "github add"],
};

// Add a pre-action hook to validate the project before any command
program.hook("preAction", async (thisCommand, actionCommand) => {
  // Skip validation for certain commands
  if (commandsWithoutValidation.includes(actionCommand.name())) {
    return;
  }

  const isValid = await ensureValidProject();
  if (!isValid) {
    log("Command cannot be executed without a valid project setup", "error");
    process.exit(1);
  }
});

program.parse();
