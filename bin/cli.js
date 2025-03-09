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

/**
 * Convert a potentially namespaced patch name to a tag-compatible format
 * @param {string} patchName - The patch name (potentially with repo prefix)
 * @returns {string} - The tag-compatible format replacing / with -
 */
function getTagCompatibleName(patchName) {
  // Replace any forward slashes with hyphens for git tag compatibility
  return patchName.replace(/\//g, "-");
}

/**
 * Extract repository and patch name from a tag-compatible name
 * @param {string} tagName - The tag name without version suffix
 * @returns {Object} - Object with repository and patchName
 */
function parseTagCompatibleName(tagName) {
  // If there's no hyphen, it's not a namespaced patch
  if (!tagName.includes("-")) {
    return {
      repository: PATCHES_REMOTE,
      patchName: tagName,
    };
  }

  // Split on first hyphen to get repo and patch parts
  const firstHyphen = tagName.indexOf("-");
  const repository = tagName.substring(0, firstHyphen);
  const patchName = tagName.substring(firstHyphen + 1);

  return { repository, patchName };
}

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
      const configuredPatchName = await utils.execGit(
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
    if (branchName.startsWith("dev_cow_")) {
      return branchName.replace("dev_cow_", "");
    } else if (branchName.startsWith("cow_")) {
      return branchName.replace("cow_", "");
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
 * Gets the release branch name for a patch
 *
 * @param {string} patchName - Name of the patch
 * @returns {string} - The release branch name (always with cow_ prefix)
 */
function getReleaseBranchName(patchName) {
  // Ensure the patch name doesn't already have the prefix
  const cleanPatchName = patchName.replace(/^cow_/, "");
  return `cow_${cleanPatchName}`;
}

/**
 * Determines if a branch name is a base/protected branch
 *
 * @param {string} branchName - Name of the branch to check
 * @returns {Promise<boolean>} - True if this is a base/protected branch
 */
async function isBaseBranch(branchName) {
  const baseBranch = await utils.getBaseBranch();
  const commonBaseBranches = [
    baseBranch,
    "main",
    "master",
    "dev",
    "develop",
    "development",
  ];

  return commonBaseBranches.includes(branchName);
}

/**
 * Get the preferred repository for a patch
 * This simplifies the repository selection logic and can be
 * reused across commands
 *
 * @param {string} patchName - Name of the patch
 * @param {boolean} interactive - Whether to allow interactive selection
 * @returns {Promise<string>} - The repository name to use
 */
async function getRepositoryForPatch(patchName, interactive = true) {
  try {
    // First try to get repository from git config
    try {
      const configKey = `hyperfy.mod.${patchName}.repository`;
      const configuredRepo = await utils.execGit(
        ["config", "--get", configKey],
        "Failed to get repository from git config"
      );

      if (configuredRepo && configuredRepo.trim()) {
        // Verify the repository exists
        const repositories = await getRegisteredRepositories();
        if (repositories.some((repo) => repo.name === configuredRepo.trim())) {
          return configuredRepo.trim();
        }
      }
    } catch (error) {
      // Git config not set, continue to interactive selection or default
    }

    if (interactive) {
      // Get repository through interactive selection
      return await getPreferredReleaseRepository(patchName);
    } else {
      // Default to the patches remote
      return PATCHES_REMOTE;
    }
  } catch (error) {
    console.warn(`Warning: Failed to determine repository: ${error.message}`);
    return PATCHES_REMOTE;
  }
}

// Add this function near the top of the file, after utility functions
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
 * Get the appropriate base repository remote based on origin configuration
 * This will return 'hyperfy' if origin is not pointing to the canonical repository
 * @returns {string} - The remote name to use for base branch operations
 */
async function getBaseRemote() {
  try {
    // First check if origin exists
    const remotes = await utils.execGit(["remote"], "Failed to list remotes");
    const remoteList = remotes
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    if (!remoteList.includes("origin")) {
      // No origin, check if hyperfy remote exists
      if (remoteList.includes("hyperfy")) {
        return "hyperfy";
      }
      throw new Error("No origin or hyperfy remote found");
    }

    // Check if origin is the canonical repository
    const originUrl = await utils.execGit(
      ["remote", "get-url", "origin"],
      "Failed to get origin URL"
    );

    // If origin is not the canonical repository but hyperfy remote exists, use hyperfy
    if (originUrl.trim() !== TARGET_REPO && remoteList.includes("hyperfy")) {
      return "hyperfy";
    }

    // Default to origin
    return "origin";
  } catch (error) {
    console.warn(
      "Failed to determine base remote, defaulting to origin:",
      error.message
    );
    return "origin";
  }
}

/**
 * Generates an enhanced commit message with metadata
 * @param {string} patchName - Name of the patch
 * @param {string} version - Version of the patch (optional)
 * @param {string} originalCommitHash - Original commit hash of the mod release
 * @param {string} modBaseBranchHash - Base branch commit hash when the mod was created
 * @param {string} currentBaseBranchHash - Current base branch commit hash
 * @returns {string} - The enhanced commit message
 */
async function generateEnhancedCommitMessage(
  patchName,
  version = null,
  originalCommitHash = null,
  modBaseBranchHash = null,
  currentBaseBranchHash = null
) {
  // Get required hashes if not provided
  if (!currentBaseBranchHash) {
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await getBaseRemote();
    try {
      currentBaseBranchHash = await utils.execGit(
        ["rev-parse", `${baseRemote}/${baseBranch}`],
        "Failed to get current base branch commit hash"
      );
    } catch (e) {
      currentBaseBranchHash = "unknown";
    }
  }

  // Format the commit message with additional metadata
  const versionInfo = version ? ` v${version}` : "";
  let message = `cow: ${patchName}${versionInfo}\n`;

  // Add metadata section
  message += `---\n`;
  message += `mod-hash: ${originalCommitHash || "unknown"}\n`;
  message += `mod-base: ${modBaseBranchHash || "unknown"}\n`;
  message += `current-base: ${currentBaseBranchHash}\n`;

  return message;
}

/**
 * Parses an enhanced commit message to extract metadata
 * @param {string} commitMessage - The commit message to parse
 * @returns {Object} - The parsed metadata
 */
function parseEnhancedCommitMessage(commitMessage) {
  // Handle both multiline and single-line formats
  const lines = commitMessage.trim().split("\n");

  const patchInfo = {
    name: null,
    version: null,
    originalCommitHash: null,
    modBaseBranchHash: null,
    currentBaseBranchHash: null,
  };

  // First try to parse the first line for patch name and version
  const firstLine = lines[0] || "";

  if (firstLine.startsWith("cow: ")) {
    // Check if the metadata is on the same line (single-line format)
    if (firstLine.includes(" --- ")) {
      // Single-line format: "cow: name v1.0.0 --- mod-hash: abc mod-base: def current-base: ghi"
      const parts = firstLine.split(" --- ");
      const nameVersionPart = parts[0].substring(5).trim(); // Remove "cow: " prefix

      // Extract name and version from the first part
      const versionMatch = nameVersionPart.match(/ v([0-9.]+)/);
      if (versionMatch) {
        patchInfo.name = nameVersionPart.substring(
          0,
          nameVersionPart.lastIndexOf(" v")
        );
        patchInfo.version = versionMatch[1];
      } else {
        patchInfo.name = nameVersionPart;
      }

      // Extract metadata from the rest of the line
      if (parts.length > 1) {
        const metadataPart = parts[1];
        const metadataItems = metadataPart.split(" ");

        for (let i = 0; i < metadataItems.length; i++) {
          if (
            metadataItems[i] === "mod-hash:" &&
            i + 1 < metadataItems.length
          ) {
            patchInfo.originalCommitHash = metadataItems[i + 1];
          } else if (
            metadataItems[i] === "mod-base:" &&
            i + 1 < metadataItems.length
          ) {
            patchInfo.modBaseBranchHash = metadataItems[i + 1];
          } else if (
            metadataItems[i] === "current-base:" &&
            i + 1 < metadataItems.length
          ) {
            patchInfo.currentBaseBranchHash = metadataItems[i + 1];
          }
        }
      }
    } else {
      // Multi-line format: traditional format with --- separator on its own line
      const patchNameWithVersion = firstLine.substring(5).trim();
      const versionMatch = patchNameWithVersion.match(/ v([0-9.]+)/);

      if (versionMatch) {
        patchInfo.name = patchNameWithVersion.substring(
          0,
          patchNameWithVersion.lastIndexOf(" v")
        );
        patchInfo.version = versionMatch[1];
      } else {
        patchInfo.name = patchNameWithVersion;
      }

      // Parse metadata section from subsequent lines
      let inMetadataSection = false;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line === "---") {
          inMetadataSection = true;
          continue;
        }

        if (!inMetadataSection) continue;

        if (line.startsWith("mod-hash: ")) {
          patchInfo.originalCommitHash = line.substring(10);
        } else if (line.startsWith("mod-base: ")) {
          patchInfo.modBaseBranchHash = line.substring(10);
        } else if (line.startsWith("current-base: ")) {
          patchInfo.currentBaseBranchHash = line.substring(14);
        }
      }
    }
  }

  return patchInfo;
}

/**
 * Get all registered patch repositories
 * @returns {Promise<Array<{name: string, url: string}>>} Array of repository objects
 */
async function getRegisteredRepositories() {
  try {
    // Get all remotes from git
    const remotes = await utils.execGit(["remote"], "Failed to list remotes");
    const remoteList = remotes
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    // Get URL for each remote
    const repositories = [];
    for (const remote of remoteList) {
      try {
        const url = await utils.execGit(
          ["remote", "get-url", remote],
          `Failed to get URL for remote ${remote}`
        );
        repositories.push({ name: remote, url: url.trim() });
      } catch (error) {
        console.warn(
          `Warning: Could not get URL for remote ${remote}: ${error.message}`
        );
      }
    }

    return repositories;
  } catch (error) {
    console.error(`Failed to get registered repositories: ${error.message}`);
    return [{ name: PATCHES_REMOTE, url: config.patchesRepo }];
  }
}

/**
 * Extract a repository name from URL
 * @param {string} url - Repository URL
 * @returns {string} - Suggested repository name
 */
function extractRepoNameFromUrl(url) {
  try {
    // Handle GitHub URLs
    const githubMatch = url.match(/github\.com\/([^\/]+)/);
    if (githubMatch) {
      return githubMatch[1];
    }

    // Handle GitLab URLs
    const gitlabMatch = url.match(/gitlab\.com\/([^\/]+)/);
    if (gitlabMatch) {
      return gitlabMatch[1];
    }

    // Handle Bitbucket URLs
    const bitbucketMatch = url.match(/bitbucket\.org\/([^\/]+)/);
    if (bitbucketMatch) {
      return bitbucketMatch[1];
    }

    // Generic git URLs with format username@host:path/repo.git
    const sshMatch = url.match(/@([^:]+):([^\/]+)/);
    if (sshMatch) {
      return sshMatch[2];
    }

    // If no specific pattern matches, extract domain name without TLD
    const domainMatch = url.match(/\/\/([^\/]+)/);
    if (domainMatch) {
      const domain = domainMatch[1].split(".")[0];
      return domain !== "www"
        ? domain
        : url.split("/").pop().replace(".git", "");
    }

    // Fallback: use the last part of the URL
    return url.split("/").pop().replace(".git", "");
  } catch (error) {
    // If anything goes wrong, return a generic name
    return "custom-repo";
  }
}

/**
 * Add a new patch repository
 * @param {string} nameOrUrl - The name for the remote or the URL (name will be derived)
 * @param {string} [url] - The URL of the repository (optional if first param is URL)
 * @returns {Promise<boolean>} Success status
 */
async function addRepository(nameOrUrl, url) {
  try {
    let repoName, repoUrl;

    // Check if only one parameter was provided (URL)
    if (!url) {
      repoUrl = nameOrUrl;
      repoName = extractRepoNameFromUrl(repoUrl);
    } else {
      repoName = nameOrUrl;
      repoUrl = url;
    }

    // Validate name format
    if (!repoName.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error(
        "Repository name must contain only letters, numbers, underscore, and hyphen"
      );
    }

    // Check if remote already exists
    const remotes = await utils.execGit(["remote"], "Failed to list remotes");
    const remoteList = remotes
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    if (remoteList.includes(repoName)) {
      // Ask if the user wants to use a different name
      const { useNewName } = await inquirer.prompt([
        {
          type: "confirm",
          name: "useNewName",
          message: `Remote ${repoName} already exists. Would you like to use a different name?`,
          default: true,
        },
      ]);

      if (useNewName) {
        const { newName } = await inquirer.prompt([
          {
            type: "input",
            name: "newName",
            message: "Enter a new name for the repository:",
            validate: (input) => {
              if (!input.trim()) return "Repository name cannot be empty";
              if (!input.match(/^[a-zA-Z0-9_-]+$/))
                return "Repository name must contain only letters, numbers, underscore, and hyphen";
              if (remoteList.includes(input.trim()))
                return `Remote ${input.trim()} already exists`;
              return true;
            },
          },
        ]);
        repoName = newName.trim();
      } else {
        throw new Error(
          `Remote ${repoName} already exists and no new name was provided`
        );
      }
    }

    log(`Adding repository '${repoName}' with URL: ${repoUrl}`, "info");

    // Add the remote
    await utils.execGit(
      ["remote", "add", repoName, repoUrl],
      `Failed to add remote ${repoName}`
    );

    // Fetch from the new remote
    const spinner = ora(`Fetching from new repository ${repoName}...`).start();
    try {
      await utils.execGit(
        ["fetch", repoName],
        `Failed to fetch from ${repoName}`
      );
      spinner.succeed(`Successfully fetched from ${repoName}`);
    } catch (error) {
      spinner.fail(
        `Warning: Failed to fetch from ${repoName}: ${error.message}`
      );
      console.warn(
        "The remote was added but initial fetch failed. The repository may be inaccessible."
      );
    }

    return { success: true, name: repoName };
  } catch (error) {
    console.error(`Failed to add repository: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Remove a patch repository
 * @param {string} name - The name of the remote to remove
 * @returns {Promise<boolean>} Success status
 */
async function removeRepository(name) {
  try {
    // Don't allow removing the default patches remote
    if (name === PATCHES_REMOTE) {
      throw new Error(
        `Cannot remove the default patches remote ${PATCHES_REMOTE}`
      );
    }

    // Check if remote exists
    const remotes = await utils.execGit(["remote"], "Failed to list remotes");
    const remoteList = remotes
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    if (!remoteList.includes(name)) {
      throw new Error(`Remote ${name} does not exist`);
    }

    // Remove the remote
    await utils.execGit(
      ["remote", "remove", name],
      `Failed to remove remote ${name}`
    );

    return true;
  } catch (error) {
    console.error(`Failed to remove repository: ${error.message}`);
    return false;
  }
}

/**
 * List all registered patch repositories
 */
async function listRepositories() {
  try {
    const repositories = await getRegisteredRepositories();

    console.log("\nRegistered patch repositories:");
    if (repositories.length === 0) {
      console.log("  No repositories registered");
    } else {
      repositories.forEach((repo) => {
        const isDefault = repo.name === PATCHES_REMOTE ? " (default)" : "";
        console.log(`  - ${repo.name}${isDefault}: ${repo.url}`);
      });
    }
  } catch (error) {
    console.error(`Failed to list repositories: ${error.message}`);
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

    // Check if the patches remote exists
    if (!remoteList.includes(PATCHES_REMOTE)) {
      // Remote doesn't exist, set it up
      log(`Setting up patches remote ${PATCHES_REMOTE}...`, "info");
      try {
        await utils.setupPatchesRemote(
          config.patchesRepo,
          config.patchesRemote
        );
        log(`Successfully set up patches remote ${PATCHES_REMOTE}`, "success");
      } catch (error) {
        log(
          `Warning: Failed to set up patches remote: ${error.message}`,
          "warning"
        );
        log(
          "Proceeding without patches remote. Some features may not work.",
          "warning"
        );
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

// Extract version from commit message if it exists
function extractVersionFromMessage(message) {
  const versionMatch = message.match(/v(\d+\.\d+\.\d+)/);
  if (versionMatch) {
    return versionMatch[1];
  }
  return null;
}

/**
 * Applies a patch from a specific repository with mandatory namespacing
 * @param {string} patchName - Name of the patch
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<void>}
 */
async function applyPatchFromRepo(patchName, remoteName) {
  const spinner = ora(`Applying mod: ${patchName} from ${remoteName}`).start();
  const appliedPatches = await utils.getAppliedPatches();

  // Clean up the patch name (remove cow_ prefix if present)
  const cleanPatchName = patchName.replace(/^cow_/, "");

  // Always namespace the patch with the remote name
  const namespacedPatchName = `${remoteName}/${cleanPatchName}`;

  // Check if patch is already applied (considering namespace)
  if (
    appliedPatches.some((p) => {
      const name = typeof p === "string" ? p : p.name;
      return name === namespacedPatchName;
    })
  ) {
    spinner.info(`Patch ${namespacedPatchName} is already applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    spinner.text = "Finding mod commit...";

    // Format the branch name correctly for this remote
    const remoteBranchName = `cow_${cleanPatchName}`;

    // Get the original commit hash and message from the remote branch
    const originalCommitHash = await utils.execGit(
      ["rev-parse", `${remoteName}/${remoteBranchName}`],
      `Failed to find commit hash for mod ${cleanPatchName} from ${remoteName}`
    );

    const commitMessage = await utils.execGit(
      ["log", "-1", "--format=%B", originalCommitHash],
      `Failed to get commit message for mod ${cleanPatchName} from ${remoteName}`
    );

    // Get current base branch hash
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await getBaseRemote();
    const currentBaseBranchHash = await utils.execGit(
      ["rev-parse", `${baseRemote}/${baseBranch}`],
      "Failed to get current base branch commit hash"
    );

    // Try to extract mod base branch hash from the original commit message
    let modBaseBranchHash = null;
    const parsedMessage = parseEnhancedCommitMessage(commitMessage);

    if (
      parsedMessage &&
      parsedMessage.currentBaseBranchHash &&
      parsedMessage.currentBaseBranchHash !== "unknown"
    ) {
      // If the original commit has metadata, use its current-base as our mod-base
      modBaseBranchHash = parsedMessage.currentBaseBranchHash;
    } else if (
      parsedMessage &&
      parsedMessage.modBaseBranchHash &&
      parsedMessage.modBaseBranchHash !== "unknown"
    ) {
      // Or use mod-base if available
      modBaseBranchHash = parsedMessage.modBaseBranchHash;
    } else {
      // For patches without enhanced metadata, we'll use the commit's parent
      try {
        // Try to find the parent commit that the mod was based on
        const parentHash = await utils.execGit(
          ["rev-list", "--parents", "-n", "1", originalCommitHash],
          "Failed to get parent commit"
        );

        // The format is: <commit> <parent1> <parent2> ...
        const parents = parentHash.split(" ");
        if (parents.length > 1) {
          // Use the first parent as the base hash
          modBaseBranchHash = parents[1];
        } else {
          // Fallback to current base branch hash if we can't determine
          modBaseBranchHash = currentBaseBranchHash;
        }
      } catch (e) {
        // If all else fails, use current base branch hash
        modBaseBranchHash = currentBaseBranchHash;
      }
    }

    // Get the version if it's in the commit message
    const version = extractVersionFromMessage(commitMessage);

    const commit = await utils.execGit(
      ["rev-list", "-n", "1", `${remoteName}/${remoteBranchName}`, "^HEAD"],
      `Failed to find commit for mod ${cleanPatchName} from ${remoteName}`
    );

    if (!commit) {
      spinner.fail(
        `No unique commits found in ${cleanPatchName} from ${remoteName}`
      );
      throw new Error(
        `No unique commits found in ${cleanPatchName} from ${remoteName}`
      );
    }

    try {
      spinner.text = "Applying mod changes...";
      await utils.execGit(
        ["cherry-pick", commit],
        "Failed to cherry-pick commit"
      );

      // Generate enhanced commit message with metadata
      const enhancedCommitMessage = await generateEnhancedCommitMessage(
        namespacedPatchName,
        version,
        originalCommitHash,
        modBaseBranchHash,
        currentBaseBranchHash
      );

      // Update commit message with enhanced metadata
      await utils.execGit(
        ["commit", "--amend", "-m", enhancedCommitMessage],
        "Failed to update commit message"
      );

      spinner.succeed(`Successfully applied mod: ${namespacedPatchName}`);
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

      // Generate enhanced commit message with metadata
      const enhancedCommitMessage = await generateEnhancedCommitMessage(
        namespacedPatchName,
        version,
        originalCommitHash,
        modBaseBranchHash,
        currentBaseBranchHash
      );

      await utils.execGit(
        ["commit", "-m", enhancedCommitMessage],
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
  const repositories = await getRegisteredRepositories();
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
    const appliedPatches = await getAppliedPatches();
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await getBaseRemote();

    // Fetch latest refs and tags
    await utils
      .execGit(["fetch", "--all", "--tags"], "Failed to fetch refs and tags")
      .catch((e) => {
        // Log but continue if fetch fails
        spinner.warn(`Could not fetch latest refs: ${e.message}`);
      });

    // Get the current base branch hash for comparison
    const currentBaseBranchHash = await utils.execGit(
      ["rev-parse", `${baseRemote}/${baseBranch}`],
      "Failed to get current base branch commit hash"
    );

    spinner.succeed("Patch information gathered");

    console.log("\nCurrently applied patches:");
    if (appliedPatches.length === 0) {
      console.log("  No patches applied");
    } else {
      for (const patch of appliedPatches) {
        const patchName = typeof patch === "string" ? patch : patch.name;
        const version = patch.version ? ` v${patch.version}` : "";

        // Line 1: Patch name and version
        const patchLine = `  - ${patchName}${version}`;
        process.stdout.write(chalk.green(patchLine));

        // Check if a newer version is available
        let updateMessage = "";
        if (patch.version) {
          try {
            // Instead of using just the clean patch name, use the tag-compatible format
            // that includes the repository name to avoid conflicts

            // Extract repo and patch parts
            let repoName, patchNamePart;
            if (patchName.includes("/")) {
              [repoName, patchNamePart] = patchName.split("/", 2);
            } else {
              // For backward compatibility with non-namespaced patches
              repoName = PATCHES_REMOTE;
              patchNamePart = patchName;
            }

            // Create tag-compatible name
            const tagCompatibleName = getTagCompatibleName(
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
              const relativeTime = getRelativeTime(
                parseInt(commitTimestamp) * 1000
              );
              console.log(chalk.gray(`    Committed: ${relativeTime}`));
            }
          }

          // Also try to get author information
          const { author, relativeTime } = await getPatchInfo(
            patchName.split("/").pop(), // Get just the patch name without repo prefix
            patchName.split("/")[0] // Get the repo name
          );
          console.log(
            chalk.gray(`    Author: ${author}, Created: ${relativeTime}`)
          );
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
        const relativeTime = getRelativeTime(parseInt(commitTimestamp) * 1000);
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
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await getBaseRemote();
    spinner.text = `Removing all patches and upgrading to latest base version from ${baseRemote}...`;

    // Get current branch name before proceeding
    const currentBranch = await utils.getCurrentBranch();

    // Get base branch upstream configuration
    let originalBaseBranch;
    try {
      const upstream = await utils.execGit(
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

    // Sync with remote using the enhanced utility function
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
        ["branch", `--set-upstream-to=${originalBaseBranch}`],
        "Failed to set upstream"
      );
    } catch (e) {
      spinner.text = "No remote branch found, creating new local branch";
    }

    await utils.setupPatchesRemote(config.patchesRepo, config.patchesRemote);

    // Initialize metadata with empty state
    const baseCommitHash = await utils.execGit(
      ["rev-parse", `${baseRemote}/${baseBranch}`],
      "Failed to get base commit hash"
    );

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

  return selectedPatches;
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

async function promptForEnvVariables(variables) {
  const values = {};
  const questions = [];

  for (const variable of variables) {
    if (variable.type === "input") {
      questions.push({
        type: "input",
        name: variable.key,
        message: `Enter value for ${variable.key}:`,
        validate: (input) => {
          if (input.trim().length === 0) {
            return `${variable.key} cannot be empty`;
          }
          return true;
        },
      });
    } else if (variable.type === "switch") {
      questions.push({
        type: "list",
        name: variable.key,
        message: `Select value for ${variable.key}:`,
        choices: variable.options,
        default: variable.defaultValue,
      });
    }
  }

  if (questions.length > 0) {
    return await inquirer.prompt(questions);
  }

  return values;
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

/**
 * Search for patches across all registered repositories
 * @param {string} searchTerm - Optional search term to filter patches
 * @returns {Promise<Array<{name: string, remote: string}>>} Array of patch objects with remote info
 */
async function searchPatches(searchTerm = "") {
  // Get all registered repositories
  const repositories = await getRegisteredRepositories();
  const results = [];

  for (const repo of repositories) {
    try {
      // Update the remote
      await utils.execGit(["remote", "update", repo.name, "--prune"]);

      // Get branches from this remote
      const branches = await utils.execGit(
        ["branch", "-a"],
        `Failed to list branches from ${repo.name}`
      );

      // Filter remote branches that follow the patch pattern (cow_*)
      // MODIFIED: Updated to exclude our new backup branch format (cow_repoName_patchName_v*)
      const remoteBranches = branches
        .split("\n")
        .map((b) => b.trim())
        .filter(
          (b) =>
            b.startsWith(`remotes/${repo.name}/cow_`) &&
            !b.includes("backup") &&
            // Exclude our new backup branch format
            !b.match(/remotes\/.*\/cow_.*_.*_v\d/)
        )
        .map((b) => b.replace(`remotes/${repo.name}/`, ""))
        .map((b) => b.replace(`cow_`, "")); // Remove package prefix

      // Add to results with remote info
      remoteBranches.forEach((branch) => {
        if (!searchTerm || branch.includes(searchTerm)) {
          results.push({
            name: branch,
            remote: repo.name,
          });
        }
      });
    } catch (error) {
      console.warn(
        `Warning: Failed to search in repository ${repo.name}: ${error.message}`
      );
    }
  }

  return results;
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

/**
 * Get information about a patch
 * @param {string} branchName - Name of the patch
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<{author: string, relativeTime: string}>} Patch info
 */
async function getPatchInfo(branchName, remoteName) {
  const fullBranchName = `${remoteName}/cow_${branchName}`;
  try {
    const commitInfo = await utils.execGit(
      ["log", "-1", "--format=%an|%at", fullBranchName],
      `Failed to get commit info for ${branchName} from ${remoteName}`
    );

    const [author, timestamp] = commitInfo.split("|");
    const relativeTime = getRelativeTime(parseInt(timestamp) * 1000);

    return {
      author,
      relativeTime,
    };
  } catch (error) {
    console.warn(
      `Warning: Could not get info for ${branchName} from ${remoteName}: ${error.message}`
    );
    return {
      author: "Unknown",
      relativeTime: "Unknown",
    };
  }
}

/**
 * Get all applied patches with enhanced metadata from commit messages
 * @returns {Promise<Array>} Array of applied patches with metadata
 */
async function getAppliedPatches() {
  const baseBranch = await utils.getBaseBranch();
  const currentBranch = await utils.getCurrentBranch();

  // Get all commits between base branch and current branch with full commit messages
  const output = await utils.execGit(
    [
      "log",
      `${baseBranch}..${currentBranch}`,
      "--pretty=format:%s%n%b%n---COMMIT_SEPARATOR---",
    ],
    "Failed to get commit history"
  );

  // Split by commit separator
  const commitMessages = output.split("---COMMIT_SEPARATOR---").filter(Boolean);

  // Extract mod information from commit messages
  const appliedPatches = [];

  for (const commitMessage of commitMessages) {
    // Check if this is a cow commit
    if (commitMessage.trim().startsWith("cow: ")) {
      // Parse the enhanced commit message
      const patchInfo = parseEnhancedCommitMessage(commitMessage);

      if (patchInfo && patchInfo.name) {
        appliedPatches.push({
          name: patchInfo.name,
          version: patchInfo.version,
          originalCommitHash: patchInfo.originalCommitHash,
          modBaseBranchHash: patchInfo.modBaseBranchHash,
          currentBaseBranchHash: patchInfo.currentBaseBranchHash,
        });
      }
    }
  }

  return appliedPatches.reverse(); // Reverse to get them in application order
}

async function syncPatches() {
  const spinner = ora("Starting mod synchronization...").start();

  try {
    // Safety checks: Get current branch name
    const currentBranch = await utils.getCurrentBranch();
    const baseBranch = await utils.getBaseBranch();

    // Check if we're on a dev, cow_, or dev_cow_ branch
    if (currentBranch.startsWith("dev_cow_")) {
      spinner.fail(
        `Cannot run sync on a development branch (${currentBranch})`
      );
      log(
        "The sync command should not be run on development branches.",
        "error"
      );
      log(
        "These branches are used for mod development and would be reset by sync.",
        "warning"
      );
      log(
        "Please checkout your main feature branch before running this command.",
        "info"
      );
      return;
    }

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

    const failedPatches = [];

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

          // For namespaced patch, create tag-compatible name
          let tagCompatibleName = patch.name;
          if (patch.name.includes("/")) {
            tagCompatibleName = getTagCompatibleName(patch.name);
          }

          // Get the original commit hash for the version tag
          let originalCommitHash;
          try {
            originalCommitHash = await utils.execGit(
              ["rev-parse", `${tagCompatibleName}-v${patch.version}`],
              "Failed to get original commit hash for version tag"
            );
          } catch (e) {
            // If we can't get the tag hash, just continue with null
            originalCommitHash = null;
          }

          try {
            await utils.execGit(
              ["cherry-pick", `${tagCompatibleName}-v${patch.version}`],
              "Failed to apply mod version"
            );
          } catch (e) {
            spinner.warn(
              "Cherry-pick failed, attempting alternative approach..."
            );

            await utils.execGit(
              ["cherry-pick", "--abort"],
              "Failed to abort cherry-pick"
            );
            await utils.execGit(
              ["cherry-pick", "-n", `${tagCompatibleName}-v${patch.version}`],
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
          // Regular mod application - use applyPatchFromRepo for better namespace handling
          if (patch.name.includes("/")) {
            // Extract the remote and patch name from the namespaced format
            const parts = patch.name.split("/");
            const remoteName = parts[0];
            const patchName = parts.slice(1).join("/");

            // Format the patch name for the remote
            const cleanPatchName = patchName.startsWith("cow_")
              ? patchName
              : `cow_${patchName}`;

            // Apply using the more robust function
            await applyPatchFromRepo(cleanPatchName, remoteName);
          } else {
            // For non-namespaced patches, use the default remote
            const cleanPatchName = patch.name.startsWith("cow_")
              ? patch.name
              : `cow_${patch.name}`;

            await applyPatchFromRepo(cleanPatchName, PATCHES_REMOTE);
          }
        }
      } catch (e) {
        spinner.fail(`Failed to reapply ${patch.name}: ${e.message}`);
        failedPatches.push({
          name: patch.name,
          error: e.message,
        });
      }
    }

    if (failedPatches.length > 0) {
      spinner.warn("Some patches failed to reapply:");
      failedPatches.forEach((patch) => {
        console.log(chalk.yellow(`  - ${patch.name}: ${patch.error}`));
      });
    } else {
      spinner.succeed("Successfully synchronized all patches");
    }

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
 * Stash any uncommitted changes
 * @returns {Promise<boolean>} - True if changes were stashed
 */
async function stashChanges() {
  try {
    // Check if working directory is clean
    const status = await utils.execGit(
      ["status", "--porcelain"],
      "Failed to check git status"
    );

    if (!status.trim()) {
      // Working directory is clean
      return false;
    }

    // Save uncommitted changes with a descriptive stash message
    await utils.execGit(
      ["stash", "push", "-m", "Auto-stashed before patch update"],
      "Failed to stash changes"
    );

    return true;
  } catch (error) {
    console.warn(`Warning: Failed to stash changes: ${error.message}`);
    return false;
  }
}

/**
 * Pop stashed changes if they exist
 * @param {boolean} wasStashed - Whether changes were stashed before
 */
async function popStashedChanges(wasStashed) {
  if (!wasStashed) return;

  try {
    await utils.execGit(["stash", "pop"], "Failed to pop stashed changes");
  } catch (error) {
    console.warn(`Warning: Failed to pop stashed changes: ${error.message}`);
    console.warn(
      `You may need to manually run 'git stash pop' to recover your changes.`
    );
  }
}

/**
 * Prompt the user for action after updating a dev patch
 * @param {string} patchName - The name of the patch
 * @param {boolean} hasChanges - Whether there were significant changes
 * @returns {Promise<string>} - The selected action
 */
async function promptForAction(patchName, hasChanges) {
  const choices = [
    { name: "Keep changes locally only", value: "keep" },
    { name: "Create a new release", value: "release" },
  ];

  if (!hasChanges) {
    console.log(chalk.blue(`No significant changes detected for ${patchName}`));
  } else {
    console.log(chalk.yellow(`Significant changes detected for ${patchName}`));
  }

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "What would you like to do with the updated patch?",
      choices,
      default: hasChanges ? "release" : "keep",
    },
  ]);

  return action;
}

/**
 * Get the preferred repository for releasing a mod
 * First checks git config, then falls back to interactive selection
 * @param {string} patchName - Name of the patch
 * @returns {Promise<string>} Repository name
 */
async function getPreferredReleaseRepository(patchName) {
  try {
    // First try to get repository from git config
    try {
      const configKey = `hyperfy.mod.${patchName}.repository`;
      const configuredRepo = await utils.execGit(
        ["config", "--get", configKey],
        "Failed to get repository from git config"
      );

      if (configuredRepo) {
        // Verify the repository exists
        const repositories = await getRegisteredRepositories();
        if (repositories.some((repo) => repo.name === configuredRepo.trim())) {
          return configuredRepo.trim();
        }
      }
    } catch (error) {
      // Git config not set, continue to interactive selection
    }

    // Fall back to interactive selection
    const repositories = await getRegisteredRepositories();

    if (repositories.length === 1) {
      // If only one repository is available, use it
      return repositories[0].name;
    }

    // Prompt user to select a repository
    const { selectedRepo } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedRepo",
        message: `Select repository to release ${patchName} to:`,
        choices: repositories.map((repo) => ({
          name: `${repo.name}${
            repo.name === PATCHES_REMOTE ? " (default)" : ""
          }: ${repo.url}`,
          value: repo.name,
        })),
        default: PATCHES_REMOTE,
      },
    ]);

    // Prompt if they want to save this choice for future releases
    const { saveChoice } = await inquirer.prompt([
      {
        type: "confirm",
        name: "saveChoice",
        message: `Do you want to save ${selectedRepo} as the default repository for this mod?`,
        default: true,
      },
    ]);

    if (saveChoice) {
      // Save choice in git config
      const configKey = `hyperfy.mod.${patchName}.repository`;
      await utils.execGit(
        ["config", configKey, selectedRepo],
        "Failed to save repository preference"
      );
      log(
        `Saved ${selectedRepo} as the default repository for ${patchName}`,
        "info"
      );
    }

    return selectedRepo;
  } catch (error) {
    log(
      `Failed to determine repository, using default: ${error.message}`,
      "warning"
    );
    return PATCHES_REMOTE;
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
    const baseRemote = await getBaseRemote();
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
    changesStashed = await stashChanges();
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
            await popStashedChanges(changesStashed);
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
      await popStashedChanges(changesStashed);
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
      await popStashedChanges(changesStashed);
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
    const tagCompatibleName = getTagCompatibleName(
      `${targetRepo}/${patchName}`
    );

    // Create release branch name (always with cow_ prefix)
    const releaseBranch = getReleaseBranchName(patchName);

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
    const baseRemote = await getBaseRemote();

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
  .command("init <patchName>")
  .description("Initialize a new mod development environment")
  .option("-r, --repository <repository>", "Target repository for development")
  .option(
    "-b, --branch <branchName>",
    "Custom branch name for development (defaults to patchName)"
  )
  .action(async (patchName, options) => {
    try {
      // Clean up the patch name (remove cow_ prefix if present)
      const cleanPatchName = patchName.replace(/^cow_/, "");

      // Use custom branch name if provided, otherwise use the patch name
      const devBranch = options.branch || cleanPatchName;

      // Determine target repository
      let targetRepo;
      if (options.repository) {
        // Verify the specified repository exists
        const repositories = await getRegisteredRepositories();
        if (!repositories.some((repo) => repo.name === options.repository)) {
          throw new Error(
            `Repository '${options.repository}' is not registered. Use 'repository add' to add it first.`
          );
        }
        targetRepo = options.repository;
      } else if (!options.nonInteractive) {
        // Determine the preferred repository interactively
        targetRepo = await getPreferredReleaseRepository(cleanPatchName);
      } else {
        // Default to the default patches remote
        targetRepo = PATCHES_REMOTE;
      }

      const spinner = ora(
        `Initializing development environment for ${cleanPatchName} (branch: ${devBranch}, target: ${targetRepo})`
      ).start();

      try {
        const baseBranch = await utils.getBaseBranch();
        const baseRemote = await getBaseRemote();

        // Fetch latest changes from the appropriate remote
        spinner.text = `Fetching latest changes from ${baseRemote}...`;
        await utils.execGit(
          ["fetch", baseRemote],
          `Failed to fetch updates from ${baseRemote}`
        );

        // Also fetch from target repository if different
        if (targetRepo !== baseRemote) {
          spinner.text = `Fetching latest changes from ${targetRepo}...`;
          await utils.execGit(
            ["fetch", targetRepo],
            `Failed to fetch updates from ${targetRepo}`
          );
        }

        // Check if the branch already exists
        const branches = await utils.execGit(
          ["branch"],
          "Failed to list branches"
        );

        if (!branches.includes(devBranch)) {
          // Use the proper remote reference for the base branch
          spinner.text = `Creating new branch ${devBranch} from ${baseRemote}/${baseBranch}...`;
          await utils.execGit(
            ["checkout", "-b", devBranch, `${baseRemote}/${baseBranch}`],
            "Failed to create dev branch"
          );
        } else {
          spinner.text = `Checking out existing branch ${devBranch}...`;
          await utils.execGit(
            ["checkout", devBranch],
            "Failed to checkout dev branch"
          );
        }

        // Store the target repository and patch name in git config
        // This allows us to remember which patch this branch is for
        const configKey = `hyperfy.mod.${devBranch}.patchName`;
        await utils.execGit(
          ["config", configKey, cleanPatchName],
          "Failed to save patch name"
        );

        // Store the target repository in git config
        const repoConfigKey = `hyperfy.mod.${cleanPatchName}.repository`;
        await utils.execGit(
          ["config", repoConfigKey, targetRepo],
          "Failed to save repository preference"
        );

        spinner.succeed(
          `Development environment initialized for ${cleanPatchName}\n` +
            `Branch: ${devBranch}\n` +
            `Target repository: ${targetRepo}`
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
  });

program
  .command("update [branchName]")
  .description("Update branch with latest base changes and optionally release")
  .option("-n, --non-interactive", "Skip interactive prompts")
  .option(
    "-r, --auto-release",
    "Automatically create new release if changes detected"
  )
  .option(
    "--repository <repository>",
    "Specify target repository for release (if auto-releasing)"
  )
  .action(async (branchName, options) => {
    try {
      // If no branch name is provided, use current branch
      let sourceBranch = branchName;
      if (!sourceBranch) {
        sourceBranch = await utils.getCurrentBranch();
        console.log(`Using current branch: ${sourceBranch}`);
      }

      // Check if source branch is a base branch
      if (await isBaseBranch(sourceBranch)) {
        throw new Error(
          `Cannot update base branch: ${sourceBranch}. Please use a feature branch.`
        );
      }

      // Update the branch using the flexible method
      const result = await updateBranch(sourceBranch, options);

      if (result.success) {
        // Display information about what happened
        if (result.hadChanges) {
          log(
            `Branch was updated with changes from the base branch`,
            "success"
          );

          if (result.released) {
            log(
              `Released ${result.patchName} v${result.version} to ${result.repository}`,
              "success"
            );
          }
        } else {
          log(`Branch was already up to date with the base branch`, "info");
        }
      }
    } catch (e) {
      console.error(`Failed to update branch: ${e.message}`);
      process.exit(1);
    }
  });

program
  .command("update-all")
  .description("Update all feature branches with latest base changes")
  .option("-n, --non-interactive", "Skip interactive prompts")
  .option(
    "-r, --auto-release",
    "Automatically create new releases for successfully updated branches with changes"
  )
  .action(async (options) => {
    try {
      const spinner = ora("Finding feature branches to update...").start();

      // Get all local branches
      const allBranches = (
        await utils.execGit(["branch"], "Failed to list branches")
      )
        .split("\n")
        .map((b) => b.trim().replace("* ", ""))
        .filter(Boolean);

      // Filter out base branches and empty names
      const baseBranch = await utils.getBaseBranch();
      const commonBaseBranches = [
        baseBranch,
        "main",
        "master",
        "dev",
        "develop",
        "development",
      ];

      const featureBranches = allBranches.filter(
        (branch) => !commonBaseBranches.includes(branch) && branch.trim() !== ""
      );

      if (featureBranches.length === 0) {
        spinner.info("No feature branches found to update");
        return;
      }

      // Store current branch to return to it later
      const originalBranch = await utils.getCurrentBranch();

      // Stash any uncommitted changes at the start
      spinner.text = "Checking for uncommitted changes...";
      const changesStashed = await stashChanges();
      if (changesStashed) {
        spinner.info("Uncommitted changes stashed");
      }

      // First ensure we have the latest base branch
      spinner.text = "Updating base branch...";
      await utils.ensureLatestBase();

      // Ask which branches to update if in interactive mode
      let branchesToUpdate = featureBranches;
      if (!options.nonInteractive) {
        spinner.stop(); // Stop spinner during user input

        const choices = featureBranches.map((branch) => {
          return {
            name: branch,
            value: branch,
            checked: true,
          };
        });

        const { selectedBranches } = await inquirer.prompt([
          {
            type: "checkbox",
            name: "selectedBranches",
            message: "Select branches to update:",
            choices,
            pageSize: 10,
          },
        ]);

        branchesToUpdate = selectedBranches;

        if (branchesToUpdate.length === 0) {
          spinner.info("No branches selected for update");
          if (changesStashed) {
            await popStashedChanges(changesStashed);
            spinner.succeed("Stashed changes restored");
          }
          return;
        }

        spinner.start(
          `Preparing to update ${branchesToUpdate.length} branches...`
        );
      } else {
        spinner.info(
          `Found ${featureBranches.length} feature branches to process`
        );
      }

      const updatedBranches = [];
      const releasedBranches = [];
      const failedBranches = [];

      for (const branch of branchesToUpdate) {
        spinner.text = `Processing ${branch}...`;

        try {
          // Update branch using the flexible method
          const result = await updateBranch(branch, {
            ...options,
            // Don't restore stashes for each branch, we'll do it at the end
            skipStashRestore: true,
          });

          if (result.success) {
            updatedBranches.push({
              name: branch,
              patchName: result.patchName,
              hadChanges: result.hadChanges,
            });

            if (result.released) {
              releasedBranches.push({
                name: branch,
                patchName: result.patchName,
                version: result.version,
              });
            }
          }
        } catch (error) {
          failedBranches.push({
            name: branch,
            error: error.message,
          });
          spinner.warn(`Failed to process ${branch}: ${error.message}`);
        }
      }

      // Return to original branch
      await utils.execGit(
        ["checkout", originalBranch],
        "Failed to return to original branch"
      );

      // Restore stashed changes
      if (changesStashed) {
        spinner.text = "Restoring stashed changes...";
        await popStashedChanges(changesStashed);
        spinner.info("Stashed changes restored");
      }

      // Final status report
      if (failedBranches.length > 0) {
        spinner.warn("\nSome branches failed to process:");
        failedBranches.forEach((branch) => {
          console.log(chalk.yellow(`\n${branch.name}:`));
          console.log(chalk.gray(`  Error: ${branch.error}`));
        });
      }

      if (updatedBranches.length > 0) {
        spinner.succeed(
          `Successfully processed ${updatedBranches.length} branches`
        );
        updatedBranches.forEach((branch) => {
          const icon = branch.hadChanges ? chalk.green("✓") : chalk.blue("ℹ");
          console.log(
            `${icon} ${branch.name} (${branch.patchName}): ${
              branch.hadChanges ? "Changes detected" : "No significant changes"
            }`
          );
        });
      }

      if (releasedBranches.length > 0) {
        console.log(chalk.green("\nReleased patches:"));
        releasedBranches.forEach((branch) => {
          console.log(
            `  ${branch.name} -> ${branch.patchName} v${branch.version}`
          );
        });
      }
    } catch (e) {
      console.error(`Batch update failed: ${e.message}`);
      process.exit(1);
    }
  });

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
        const repositories = await getRegisteredRepositories();
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
      const baseRemote = await getBaseRemote();

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
      const tagCompatibleName = getTagCompatibleName(
        `${targetRepo}/${patchName}`
      );
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

      // For version-specific installation
      if (patchNames.length === 1 && options.version) {
        const patchName = patchNames[0];

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

        // Create tag-compatible name for the patch
        const tagCompatibleName = getTagCompatibleName(
          `${remote}/${parsedName}`
        );

        const spinner = ora(
          `Installing ${parsedName} v${options.version} from ${remote}`
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
            // Use the tag-compatible name for the tag reference
            await utils.execGit(
              ["cherry-pick", `${tagCompatibleName}-v${options.version}`],
              "Failed to apply mod version"
            );
          } catch (e) {
            spinner.warn("Conflicts detected, attempting resolution...");
            await utils.execGit(
              ["cherry-pick", "--abort"],
              "Failed to abort cherry-pick"
            );
            await utils.execGit(
              ["cherry-pick", "-n", `${tagCompatibleName}-v${options.version}`],
              "Failed to apply mod version"
            );

            await utils.handlePackageChanges();
            await utils.execGit(["add", "."], "Failed to stage changes");
            await utils.execGit(
              [
                "commit",
                "-m",
                `cow: ${remote}/${parsedName} v${options.version}`,
              ],
              "Failed to commit changes"
            );
          }

          spinner.succeed(
            `Successfully installed ${remote}/${parsedName} v${options.version}`
          );
        } catch (error) {
          spinner.fail(`Failed to install version: ${error.message}`);
          throw error;
        }
      } else {
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
          await applyPatchFromRepo(cleanPatchName, remote);
        }
      }

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

      // If a specific mod is searched, show its versions too
      if (patchName) {
        for (const [repo, repoPatches] of Object.entries(patchesByRepo)) {
          for (const patch of repoPatches) {
            await utils.execGit(
              ["fetch", "--all", "--tags"],
              "Failed to fetch updates"
            );

            // Use tag-compatible name for tag list
            const tagCompatibleName = getTagCompatibleName(`${repo}/${patch}`);

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
            // Display with repository prefix if not the default repo
            const displayName =
              repo !== PATCHES_REMOTE ? `${repo}/${patch}` : patch;
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
          // Display repository header
          console.log(
            chalk.blue(
              `\n${repo}${repo === PATCHES_REMOTE ? " (default)" : ""}:`
            )
          );

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

// List of commands that don't require project validation
const commandsWithoutValidation = ["install", "extract", "bundle"];

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
  .action(async () => {
    try {
      await listRepositories();
    } catch (e) {
      console.error(`Failed to list repositories: ${e.message}`);
      process.exit(1);
    }
  });

program.addCommand(repoCommand);

// Update commandGroups to include repository management
commandGroups.repo = {
  description: "Repository Management:",
  commands: ["repository add", "repository remove", "repository list"],
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
