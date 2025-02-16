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

// Time utilities
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

// Patch management
async function getPatchInfo(branchName, patchesRemote) {
  const fullBranchName = `${patchesRemote}/cow_${branchName}`;
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

async function searchPatches(patchesRemote, searchTerm = "") {
  await execGit(["remote", "update", patchesRemote, "--prune"]);

  const branches = await execGit(
    ["branch", "-a"],
    "Failed to list all branches"
  );

  const remoteBranches = branches
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`remotes/${patchesRemote}/cow_`))
    .map((b) => b.replace(`remotes/${patchesRemote}/`, ""))
    .map((b) => b.replace(`cow_`, ""));

  if (searchTerm) {
    return remoteBranches.filter((b) => b.includes(searchTerm));
  }
  return remoteBranches;
}

// Hyp file utilities
function ab2str(buf) {
  return String.fromCharCode.apply(null, buf);
}

async function extractHypFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const view = new DataView(buffer.buffer);
    const headerSize = view.getUint32(0, true);
    const headerBytes = new Uint8Array(buffer.buffer.slice(4, 4 + headerSize));
    const header = JSON.parse(ab2str(headerBytes));
    const baseDir = path.basename(filePath, ".hyp");

    await fs.mkdir(baseDir, { recursive: true });
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

    const blueprintPath = path.join(baseDir, "blueprint.json");
    await fs.writeFile(
      blueprintPath,
      JSON.stringify(header.blueprint, null, 2)
    );
    console.log(`- blueprint.json: Blueprint data`);
    console.log(`\nFiles extracted to ./${baseDir}/`);

    return {
      assets: header.assets,
      blueprint: header.blueprint,
      extractedPath: baseDir,
    };
  } catch (error) {
    throw new Error(`Error extracting .hyp file: ${error.message}`);
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

  // Patch management
  getPatchInfo,
  searchPatches,

  // File utilities
  extractHypFile,

  // Logging utilities
  log,

  // Time utilities
  getRelativeTime,
};
