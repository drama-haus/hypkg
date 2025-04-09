const execa = require("execa");
const chalk = require("chalk");
const fs = require("fs").promises;
const path = require("path");
const ora = require("ora");

const DEBUG = false;

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
  await execGit(["reset", "--hard", "HEAD"], "Failed to reset changes");
  await execGit(
    ["checkout", state.branch],
    "Failed to restore original branch"
  );
  await execGit(
    ["reset", "--hard", state.commit],
    "Failed to reset to original commit"
  );

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

async function getCurrentBranch() {
  return execGit(["branch", "--show-current"], "Failed to get current branch");
}

async function getBaseBranch() {
  const branches = await execGit(["branch", "-a"], "Failed to get branches");
  const hasDev = branches.includes("dev");
  return hasDev ? "dev" : "main";
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
async function verifyRepo(targetRepo) {
  const origin = await execGit(
    ["remote", "get-url", "origin"],
    "Failed to get origin URL"
  );
  if (!origin.includes(targetRepo.replace(".git", ""))) {
    throw new Error(
      `Not in the correct repository. Expected origin to be ${targetRepo}`
    );
  }
}

async function setupPatchesRemote(patchesRepo, patchesRemote) {
  const remotes = await execGit(["remote"], "Failed to list remotes");
  if (!remotes.includes(patchesRemote)) {
    await execGit(
      ["remote", "add", patchesRemote, patchesRepo],
      "Failed to add patches remote"
    );
  }
  await execGit(["fetch", patchesRemote], "Failed to fetch patches remote");
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

async function ensurePatchBranch(branchName, selectedBranch, patchesRemote) {
  const branches = await execGit(["branch"], "Failed to list branches");
  const branchExists = branches
    .split("\n")
    .map((b) => b.trim())
    .includes(branchName);

  if (!branchExists) {
    const baseBranch = await getBaseBranch();
    await execGit(
      ["checkout", "-b", branchName, baseBranch],
      "Failed to create patch branch"
    );
  } else {
    await execGit(["checkout", branchName], "Failed to checkout patch branch");
  }

  if (selectedBranch) {
    try {
      await execGit(
        ["branch", `--set-upstream-to=${patchesRemote}/${selectedBranch}`],
        "Failed to set upstream"
      );
    } catch (e) {
      log("No remote branch found, creating new local branch", "info");
    }
  }
}

// Package management
async function handlePackageChanges() {
  const spinner = ora("Checking package dependencies...").start();

  try {
    const hasLockConflict = await execGit(
      ["diff", "--name-only", "--diff-filter=U"],
      "Failed to check conflicts"
    ).then((output) =>
      output.split("\n").some((file) => file === "package-lock.json")
    );

    if (hasLockConflict) {
      spinner.text = "Resolving package-lock.json conflicts...";
      await fs.unlink("package-lock.json").catch(() => {
        log("No existing package-lock.json found", "info");
      });

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

      await execGit(
        ["add", "package-lock.json"],
        "Failed to stage regenerated package-lock.json"
      );

      spinner.succeed("Package lock file regenerated successfully");
      return true;
    }

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

module.exports = {
  // Git utilities
  execGit,
  getCurrentBranch,
  getBaseBranch,
  getAppliedPatches,
  saveGitState,
  restoreGitState,

  // Repository management
  verifyRepo,
  setupPatchesRemote,

  // Branch management
  syncBranches,
  ensurePatchBranch,

  // Package management
  handlePackageChanges,

  // Logging utilities
  log,
};
