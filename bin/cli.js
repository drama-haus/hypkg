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
async function applyPatch(patchName) {
  const config = await getPatchConfig();

  if (config.appliedPatches.includes(patchName)) {
    console.log(`Patch ${patchName} is already applied`);
    return;
  }

  const commit = await execGit(
    ["rev-list", "-n", "1", `${PATCHES_REMOTE}/${patchName}`, "^HEAD"],
    `Failed to find commit for patch ${patchName}`
  );

  if (!commit) {
    throw new Error(`No unique commits found in ${patchName}`);
  }

  await execGit(["cherry-pick", "-n", commit], "Failed to cherry-pick commit");

  config.appliedPatches.push(patchName);
  await savePatchConfig(config);

  await execGit(["add", "."], "Failed to stage changes");
  await execGit(
    ["commit", "-m", `Applied patch: ${patchName}`],
    "Failed to commit changes"
  );

  console.log(`Successfully applied patch: ${patchName}`);
}

async function removePatch(patchName) {
  const config = await getPatchConfig();

  if (!config.appliedPatches.includes(patchName)) {
    console.log(`Patch ${patchName} is not applied`);
    return;
  }

  const baseBranch = await getBaseBranch();
  const currentCommit = await execGit(
    ["rev-parse", "HEAD"],
    "Failed to get current commit"
  );
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
        await execGit(
          ["cherry-pick", "--abort"],
          "Failed to abort cherry-pick"
        );
        await execGit(
          ["branch", "-D", tempBranch],
          "Failed to delete temp branch"
        );
        throw new Error(`Failed to cherry-pick commit ${hash}: ${e.message}`);
      }
    }
  }

  await execGit(["branch", "-D", tempBranch], "Failed to delete temp branch");

  config.appliedPatches = config.appliedPatches.filter((p) => p !== patchName);
  await savePatchConfig(config);

  console.log(`Successfully removed patch: ${patchName}`);
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

program.parse();
