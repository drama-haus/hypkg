#!/usr/bin/env node

const { program } = require("commander");
const execa = require("execa");
const path = require("path");
const fs = require("fs").promises;
const https = require("https");

async function getForksList() {
  const repoPath = TARGET_REPO.match(/github\.com\/(.+?)(?:\.git)?$/)[1];

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${repoPath}/forks`,
      headers: {
        "User-Agent": PACKAGE_NAME,
        Accept: "application/vnd.github.v3+json",
      },
    };

    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const forks = JSON.parse(data);
            resolve(
              forks.map((fork) => ({
                name: fork.owner.login,
                cloneUrl: fork.clone_url,
              }))
            );
          } catch (e) {
            reject(
              new Error(`Failed to parse GitHub API response: ${e.message}`)
            );
          }
        });
      })
      .on("error", reject);
  });
}

// Add this function to manage remotes
async function setupForkRemotes() {
  const forks = await getForksList();
  const existingRemotes = (
    await execGit(["remote"], "Failed to list remotes")
  ).split("\n");

  for (const fork of forks) {
    const remoteName = `fork-${fork.name}`;
    if (!existingRemotes.includes(remoteName)) {
      await execGit(
        ["remote", "add", remoteName, fork.cloneUrl],
        `Failed to add remote for ${fork.name}`
      );
    }
    await execGit(["fetch", remoteName], `Failed to fetch from ${fork.name}`);
  }

  return forks.map((fork) => `fork-${fork.name}`);
}

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

async function handlePackageChanges() {
  // Check if there's a merge conflict in package-lock.json
  const hasLockConflict = await execGit(
    ["diff", "--name-only", "--diff-filter=U"],
    "Failed to check conflicts"
  ).then((output) =>
    output.split("\n").some((file) => file === "package-lock.json")
  );

  if (hasLockConflict) {
    // If there's a conflict in package-lock.json, remove it
    await fs.unlink("package-lock.json").catch(() => {
      // Ignore if file doesn't exist
    });

    // Regenerate package-lock.json without modifying node_modules
    try {
      await execa("npm", ["install", "--package-lock-only"]);

      // Stage the regenerated package-lock.json
      await execGit(
        ["add", "package-lock.json"],
        "Failed to stage regenerated package-lock.json"
      );

      return true; // Indicate that we handled a package-lock conflict
    } catch (e) {
      throw new Error(`Failed to regenerate package-lock.json: ${e.message}`);
    }
  }

  // If no package-lock conflict, check if we still need to run regular npm install
  const packageLockExists = await fs
    .access("package-lock.json")
    .then(() => true)
    .catch(() => false);

  if (!packageLockExists) {
    try {
      await execa("npm", ["install"]);
    } catch (e) {
      throw new Error(`Failed to run npm install: ${e.message}`);
    }
  }

  return false; // Indicate no package-lock conflict was handled
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

      // Handle potential package-lock.json conflicts
      const handledLockConflict = await handlePackageChanges();

      // If we didn't handle a package-lock conflict but there are still conflicts,
      // we need to throw an error
      if (!handledLockConflict) {
        const hasOtherConflicts = await execGit(
          ["diff", "--name-only", "--diff-filter=U"],
          "Failed to check conflicts"
        );

        if (hasOtherConflicts) {
          throw new Error(
            "Merge conflicts detected in files other than package-lock.json"
          );
        }
      }

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
    for (const patch of config.appliedPatches) {
      const displayName = patch.replace(`${PACKAGE_NAME}_`, "");
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
      // Remove package prefix if it's already there
      const cleanPatchName = patchName.startsWith(`${PACKAGE_NAME}_`)
        ? patchName
        : `${PACKAGE_NAME}_${patchName}`;
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
      // Remove package prefix if it's already there
      const cleanPatchName = patchName.startsWith(`${PACKAGE_NAME}_`)
        ? patchName
        : `${PACKAGE_NAME}_${patchName}`;
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
  // Get all fork remotes
  const forkRemotes = await setupForkRemotes();
  const allPatches = [];

  // Function to get patches from a specific remote
  async function getPatchesFromRemote(remote) {
    const branches = await execGit(
      ["branch", "-a"],
      `Failed to list branches for ${remote}`
    );

    return branches
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.startsWith(`remotes/${remote}/${PACKAGE_NAME}`))
      .filter((b) => !b.endsWith("-base"))
      .map((b) => ({
        name: b
          .replace(`remotes/${remote}/`, "")
          .replace(`${PACKAGE_NAME}_`, ""),
        remote: remote,
      }));
  }

  // Get patches from original patches remote
  const originalPatches = await getPatchesFromRemote(PATCHES_REMOTE);
  allPatches.push(
    ...originalPatches.map((p) => ({ ...p, source: "original" }))
  );

  // Get patches from each fork
  for (const remote of forkRemotes) {
    try {
      const forkPatches = await getPatchesFromRemote(remote);
      allPatches.push(
        ...forkPatches.map((p) => ({
          ...p,
          source: remote.replace("fork-", ""),
        }))
      );
    } catch (e) {
      console.warn(
        `Warning: Failed to get patches from ${remote}: ${e.message}`
      );
    }
  }

  // Filter by search term if provided
  const filteredPatches = searchTerm
    ? allPatches.filter((p) => p.name.includes(searchTerm))
    : allPatches;

  return filteredPatches;
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

async function getPatchInfo(branchName, remote = PATCHES_REMOTE) {
  const fullBranchName = `${remote}/${PACKAGE_NAME}_${branchName}`;
  const commitInfo = await execGit(
    ["log", "-1", "--format=%H|%s|%an|%ar", fullBranchName],
    `Failed to get commit info for ${branchName}`
  );

  const [hash, subject, author, relativeTime] = commitInfo.split("|");

  return {
    hash: hash.substring(0, 7), // Short hash
    subject: subject.trim(),
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
    ["commit", "-m", `${branchName}`],
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
        // Sort patches by timestamp (newest first)
        const config = await getPatchConfig();

        for (const patch of patches) {
          const { hash, subject, author, relativeTime } = await getPatchInfo(
            patch.name,
            patch.remote
          );
          const isApplied = config.appliedPatches.includes(
            `${PACKAGE_NAME}_${patch.name}`
          );
          const prefix = isApplied ? "* " : "  ";

          // Pad all columns to align output
          const nameCol = patch.name.padEnd(30);
          const hashCol = hash.padEnd(8);
          const subjectCol = subject.padEnd(40);
          const authorCol = author.padEnd(20);

          console.log(
            `${prefix}${nameCol} - ${hashCol} - ${subjectCol} - ${author} (${relativeTime})`
          );
        }
      }
    } catch (e) {
      console.error(`Failed to search patches: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
