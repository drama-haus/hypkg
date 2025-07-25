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


const config = {
  targetRepo: packageJson.config.targetRepo,
  packageName: packageJson.name,
};

const TARGET_REPO = packageJson.config.targetRepo;
exports.TARGET_REPO = TARGET_REPO;
const PACKAGE_NAME = packageJson.name;
let BRANCH_NAME = PACKAGE_NAME;




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
        const repositories = await git.getRegisteredRepositories();
        if (repositories.some((repo) => repo.name === configuredRepo.trim())) {
          return configuredRepo.trim();
        }
      }
    } catch (error) {
      // Git config not set, continue to interactive selection
    }

    // Fall back to interactive selection
    const repositories = await git.getRegisteredRepositories();

    if (repositories.length === 1) {
      // If only one repository is available, use it
      return repositories[0].name;
    }

    const choices = [];
    for (let i = 0; i < repositories.length; i++) {
      const repo = repositories[i];
      const isVerified = await isVerifiedRepository(repo.name);
      const verificationBadge = isVerified ? chalk.green(" [✓ Verified]") : "";
      choices.push({
        name: `  - ${repo.name}${verificationBadge}: ${repo.url}`,
        value: repo.name,
      });
    }
    // Prompt user to select a repository
    const { selectedRepo } = await inquirer.prompt([
      {
        type: "list",
        name: "selectedRepo",
        message: `Select repository to release ${patchName} to:`,
        choices,
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
    log(`Failed to determine repository: ${error.message}`, "warning");
  }
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
        const repositories = await git.getRegisteredRepositories();
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
    }
  } catch (error) {
    console.warn(`Warning: Failed to determine repository: ${error.message}`);
  }
}
exports.getRepositoryForPatch = getRepositoryForPatch;
exports.getPreferredReleaseRepository = getPreferredReleaseRepository;


/**
 * Remove a patch repository
 * @param {string} name - The name of the remote to remove
 * @returns {Promise<boolean>} Success status
 */
async function removeRepository(name) {
  try {
    // Check if repository is verified
    const repositories = await git.getRegisteredRepositories();
    const repo = repositories.find((r) => r.name === name);

    if (!repo) {
      throw new Error(`Repository ${name} does not exist`);
    }

    const verifiedRepos = await fetchVerifiedRepositories();
    const isVerified = verifiedRepos.some((vr) => vr.url === repo.url);

    if (isVerified) {
      throw new Error(
        `Cannot remove verified repository ${name}. Verified repositories are managed automatically.`
      );
    }

    // Proceed with removal logic for non-verified repos
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
 * @param {object} options - Display options
 */
async function listRepositories(options = {}) {
  try {
    const repositories = await git.getRegisteredRepositories();
    const verifiedRepos = await fetchVerifiedRepositories();
    const verifiedRepoMap = new Map(verifiedRepos.map((r) => [r.url, r]));

    // Enhanced repositories with GitHub data if requested
    let enhancedRepos = repositories;
    if (options.githubInfo) {
      try {
        const { enhanceRepositoriesWithGitHubData } = require("./github");
        enhancedRepos = await enhanceRepositoriesWithGitHubData(repositories);
      } catch (error) {
        console.warn(`Failed to fetch GitHub data: ${error.message}`);
      }
    }

    console.log("\nRegistered repositories:");
    if (enhancedRepos.length === 0) {
      console.log("  No repositories registered");
    } else {
      enhancedRepos.forEach((repo) => {
        const verifiedInfo = verifiedRepoMap.has(repo.url)
          ? chalk.green(` [✓ Verified]`)
          : "";
        
        console.log(`  - ${repo.name}: ${repo.url}${verifiedInfo}`);
        
        // Show GitHub metadata if available
        if (repo.github) {
          console.log(`    ${repo.github.description}`);
          console.log(`    ⭐ ${repo.github.stars} stars, 🍴 ${repo.github.forks} forks`);
          console.log(`    Language: ${repo.github.language}, updated ${repo.github.lastUpdated}`);
          if (repo.github.topics.length > 0) {
            console.log(`    Topics: ${repo.github.topics.join(', ')}`);
          }
        }
      });
    }
  } catch (error) {
    console.error(`Failed to list repositories: ${error.message}`);
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

module.exports = {
  addRepository,
  removeRepository,
  listRepositories,
};
