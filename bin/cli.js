#!/usr/bin/env node

const { program } = require("commander");
const execa = require("execa");
const path = require("path");
const fs = require("fs").promises;

const packageJson = require(path.join(__dirname, "..", "package.json"));
const PATCHES_REPO = packageJson.config.patchesRepo;
const PATCHES_REMOTE = packageJson.config.patchesRemoteName;
const TARGET_REPO = packageJson.config.targetRepo;
const PACKAGE_NAME = packageJson.name;
const BRANCH_NAME = PACKAGE_NAME;

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
  try {
    const result = await execa("git", args);
    return result.stdout.trim();
  } catch (e) {
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
  const configPath = path.join(process.cwd(), "." + PACKAGE_NAME);
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (e) {
    return {
      branch: BRANCH_NAME,
      appliedPatches: [],
    };
  }
}

async function savePatchConfig(config) {
  const configPath = path.join(process.cwd(), "." + PACKAGE_NAME);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
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
  await execGit(["fetch", "origin"], "Failed to fetch origin");
  const baseBranch = await getBaseBranch();
  console.log(`Using ${baseBranch} as base branch`);
  await execGit(["checkout", baseBranch], "Failed to checkout base branch");
  await execGit(["pull", "origin", baseBranch], "Failed to pull base branch");
  return baseBranch;
}

async function ensurePatchBranch() {
  await setupPatchesRemote();
  const branches = await execGit(["branch"], "Failed to list branches");
  const branchExists = branches
    .split("\n")
    .map((b) => b.trim())
    .includes(BRANCH_NAME);

  if (!branchExists) {
    await execGit(
      [
        "branch",
        "--track",
        PACKAGE_NAME,
        `${PATCHES_REMOTE}/${PACKAGE_NAME}-base`,
      ],
      "Failed to create patch branch"
    );
  }

  await execGit(["checkout", BRANCH_NAME], "Failed to checkout patch branch");
  await execGit(
    ["branch", `--set-upstream-to=${PATCHES_REMOTE}/${PACKAGE_NAME}-base`],
    "Failed to set upstream"
  );
  await execGit(
    ["branch", PACKAGE_NAME, "--unset-upstream"],
    "Failed to unset upstream"
  );

  const config = await getPatchConfig();
  await savePatchConfig(config);
}

// Patch operations
async function handlePackageChanges() {
  const packageLockExists = await fs
    .access("package-lock.json")
    .then(() => true)
    .catch(() => false);

  if (packageLockExists) {
    await fs.unlink("package-lock.json");
  }

  try {
    await execa("npm", ["install"]);
  } catch (e) {
    throw new Error(`Failed to run npm install: ${e.message}`);
  }
}

async function applyPatch(patchName) {
  const config = await getPatchConfig();
  const initialState = await saveGitState();

  if (config.appliedPatches.includes(patchName)) {
    console.log(`Patch ${patchName} is already applied`);
    return;
  }

  try {
    const commit = await execGit(
      ["rev-list", "-n", "1", `${PATCHES_REMOTE}/${patchName}`, "^HEAD"],
      `Failed to find commit for patch ${patchName}`
    );

    if (!commit) {
      throw new Error(`No unique commits found in ${patchName}`);
    }

    try {
      // Try normal cherry-pick first
      await execGit(["cherry-pick", commit], "Failed to cherry-pick commit");
    } catch (cherryPickError) {
      // If it fails, abort and try the package-lock.json handling approach
      await execGit(["cherry-pick", "--abort"], "Failed to abort cherry-pick");

      // Try cherry-pick without committing
      await execGit(
        ["cherry-pick", "-n", commit],
        "Failed to cherry-pick commit"
      );

      // Handle package-lock.json and npm install
      await handlePackageChanges();

      // Stage and commit all changes
      await execGit(["add", "."], "Failed to stage changes");
      await execGit(
        ["commit", "-m", `Applied patch: ${patchName}`],
        "Failed to commit changes"
      );
    }

    // Update config only after successful patch application
    config.appliedPatches.push(patchName);
    await savePatchConfig(config);

    console.log(`Successfully applied patch: ${patchName}`);
  } catch (error) {
    console.error(
      `Error while applying patch, rolling back to initial state...`
    );
    await restoreGitState(initialState);
    throw error;
  }
}

async function removePatch(patchName) {
  const config = await getPatchConfig();
  const initialState = await saveGitState();

  if (!config.appliedPatches.includes(patchName)) {
    console.log(`Patch ${patchName} is not applied`);
    return;
  }

  try {
    const baseBranch = await getBaseBranch();
    const tempBranch = `temp-${Date.now()}`;

    await execGit(["branch", tempBranch], "Failed to create temp branch");
    await execGit(
      ["reset", "--hard", baseBranch],
      "Failed to reset to base branch"
    );

    const commits = await execGit(
      ["log", `${baseBranch}..${tempBranch}`, "--format=%H %s"],
      "Failed to get commit list"
    );

    const commitList = commits.split("\n").reverse().filter(Boolean);

    for (const commit of commitList) {
      const [hash, ...messageParts] = commit.split(" ");
      const message = messageParts.join(" ");

      if (!message.includes(`Applied patch: ${patchName}`)) {
        try {
          await execGit(["cherry-pick", hash], "Failed to cherry-pick commit");
        } catch (e) {
          // If cherry-pick fails, try the package-lock.json handling approach
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

    await execGit(["branch", "-D", tempBranch], "Failed to delete temp branch");

    // Update package dependencies after all patches are reapplied
    await handlePackageChanges();

    config.appliedPatches = config.appliedPatches.filter(
      (p) => p !== patchName
    );
    await savePatchConfig(config);

    console.log(`Successfully removed patch: ${patchName}`);
  } catch (error) {
    console.error(
      `Error while removing patch, rolling back to initial state...`
    );
    await restoreGitState(initialState);
    throw error;
  }
}

async function listPatches() {
  const config = await getPatchConfig();

  console.log("\nCurrently applied patches:");
  if (config.appliedPatches.length === 0) {
    console.log("  No patches applied");
  } else {
    config.appliedPatches.forEach((patch) => console.log(`  - ${patch}`));
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

// CLI commands setup
program
  .name(PACKAGE_NAME)
  .description("Patch management system for game engine")
  .version(packageJson.version);

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
      await applyPatch(patchName);
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
      await removePatch(patchName);
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
  const branches = await execGit(
    ["branch", "-a"],
    "Failed to list all branches"
  );

  const remoteBranches = branches
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`remotes/${PATCHES_REMOTE}/${PACKAGE_NAME}`))
    .map((b) => b.replace(`remotes/${PATCHES_REMOTE}/`, ""));

  if (searchTerm) {
    return remoteBranches.filter((b) => b.includes(searchTerm));
  }
  return remoteBranches;
}

async function getBranchDiff(branchName) {
  const baseBranch = await getBaseBranch();
  return execGit(
    ["diff", `${baseBranch}...${branchName}`, "--name-only"],
    "Failed to get branch diff"
  );
}

async function publishPatch(branchName) {
  // Verify we're on the correct branch
  const currentBranch = await getCurrentBranch();
  if (currentBranch !== branchName) {
    throw new Error(
      `Not on branch ${branchName}. Please checkout the branch first.`
    );
  }

  const patchBranchName = `${PACKAGE_NAME}_${branchName}`;

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
    ["merge-base", `${BRANCH_NAME}-base`, branchName],
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
        patches.forEach((patch) => console.log(`  - ${patch}`));
      }
    } catch (e) {
      console.error(`Failed to search patches: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
