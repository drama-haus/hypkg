#!/usr/bin/env node

const { program } = require("commander");
const execa = require("execa"); // Changed this line
const path = require("path");
const fs = require("fs").promises;

const packageJson = require(path.join(__dirname, "..", "package.json"));
const PATCHES_REPO = packageJson.config.patchesRepo;
const PATCHES_REMOTE = packageJson.config.patchesRemoteName;
const TARGET_REPO = packageJson.config.targetRepo;
const PACKAGE_NAME = packageJson.name;
const BRANCH_NAME = PACKAGE_NAME;

async function getCurrentBranch() {
  const { stdout } = await execa("git", ["branch", "--show-current"]);
  return stdout.trim();
}

async function verifyRepo() {
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"]);
    if (!stdout.trim().includes(TARGET_REPO.replace(".git", ""))) {
      throw new Error(
        `Not in the correct repository. Expected origin to be ${TARGET_REPO}`
      );
    }
  } catch (e) {
    throw new Error(`Repository verification failed: ${e.message}`);
  }
}

async function syncBranches() {
  try {
    await execa("git", ["fetch", "origin"]);

    // Check if both branches exist
    const { stdout: branches } = await execa("git", ["branch", "-a"]);
    const hasDev = branches.includes("dev");

    const targetBranch = hasDev ? "dev" : "main";
    console.log(`Using ${targetBranch} as base branch`);

    await execa("git", ["checkout", targetBranch]);
    await execa("git", ["pull", "origin", targetBranch]);

    return targetBranch;
  } catch (e) {
    throw new Error(`Failed to sync branches: ${e.message}`);
  }
}

async function getPatchConfig() {
  const configPath = path.join(process.cwd(), "." + PACKAGE_NAME);
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    return config;
  } catch (e) {
    // Return default config if file doesn't exist
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

async function ensurePatchBranch(baseBranch) {
  try {
    const { stdout } = await execa("git", ["remote"]);
    if (!stdout.includes(PATCHES_REMOTE)) {
      await execa("git", ["remote", "add", PATCHES_REMOTE, PATCHES_REPO]);
    } else {
      console.log("remote already");
    }
    await execa("git", ["fetch", PATCHES_REMOTE]);

    // Check if patch branch exists
    const { stdout: branches } = await execa("git", ["branch"]);
    console.log(branches.split("\n").map((b) => b.trim()));
    if (
      !branches
        .split("\n")
        .map((b) => b.trim())
        .includes(BRANCH_NAME)
    ) {
      // Create new branch
      await execa("git", [
        "branch",
        "--track",
        PACKAGE_NAME,
        `${PATCHES_REMOTE}/${PACKAGE_NAME}-base`,
      ]);
      await execa("git", ["checkout", BRANCH_NAME]);
    } else {
      await execa("git", ["checkout", BRANCH_NAME]);
      await execa("git", [
        "branch",
        `--set-upstream-to=${PATCHES_REMOTE}/${PACKAGE_NAME}-base`,
      ]);
    }

    await execa("git", ["branch", PACKAGE_NAME, "--unset-upstream"]);

    const config = await getPatchConfig();
    await savePatchConfig(config);
  } catch (e) {
    throw new Error(`Failed to setup patch branch: ${e.message}`);
  }
}

async function applyPatch(patchName) {
  try {
    const config = await getPatchConfig();

    if (config.appliedPatches.includes(patchName)) {
      console.log(`Patch ${patchName} is already applied`);
      return;
    }

    const { stdout } = await execa("git", [
      "rev-list",
      "-n",
      "1",
      `${PATCHES_REMOTE}/${patchName}`,
      "^HEAD",
    ]);
    if (!stdout) {
      throw new Error(`No unique commits found in ${patchName}`);
    }

    await execa("git", ["cherry-pick", "-n", stdout.trim()]);

    // Update patch config to track the applied patch
    config.appliedPatches.push(patchName);
    await savePatchConfig(config);

    // Commit the changes including the .patches file
    await execa("git", ["add", "."]);
    await execa("git", ["commit", "-m", `Applied patch: ${patchName}`]);

    console.log(`Successfully applied patch: ${patchName}`);
  } catch (e) {
    throw new Error(`Failed to apply patch ${patchName}: ${e.message}`);
  }
}

async function removePatch(patchName) {
  try {
    const config = await getPatchConfig();

    if (!config.appliedPatches.includes(patchName)) {
      console.log(`Patch ${patchName} is not applied`);
      return;
    }

    // Get the base branch (dev or main)
    const { stdout: branches } = await execa("git", ["branch", "-a"]);
    const hasDev = branches.includes("dev");
    const baseBranch = hasDev ? "dev" : "main";

    // Store current branch state
    const { stdout: currentCommit } = await execa("git", ["rev-parse", "HEAD"]);

    // Create a temporary branch to store current state
    const tempBranch = `temp-${Date.now()}`;
    await execa("git", ["branch", tempBranch]);

    // Reset to base branch
    await execa("git", ["reset", "--hard", baseBranch]);

    // Cherry-pick all commits from the temp branch except the patch we want to remove
    const { stdout: commits } = await execa("git", [
      "log",
      `${baseBranch}..${tempBranch}`,
      "--format=%H %s",
    ]);
    const commitList = commits.split("\n").reverse().filter(Boolean);

    for (const commit of commitList) {
      const [hash, ...messageParts] = commit.split(" ");
      const message = messageParts.join(" ");

      // Skip the commit that applied this patch
      if (!message.includes(`Applied patch: ${patchName}`)) {
        try {
          await execa("git", ["cherry-pick", hash]);
        } catch (cherryPickError) {
          // If cherry-pick fails, abort and cleanup
          await execa("git", ["cherry-pick", "--abort"]);
          await execa("git", ["branch", "-D", tempBranch]);
          throw new Error(
            `Failed to cherry-pick commit ${hash}: ${cherryPickError.message}`
          );
        }
      }
    }

    // Clean up temporary branch
    await execa("git", ["branch", "-D", tempBranch]);

    // Update patch config to remove the patch from tracking
    config.appliedPatches = config.appliedPatches.filter(
      (p) => p !== patchName
    );
    await savePatchConfig(config);

    console.log(`Successfully removed patch: ${patchName}`);
  } catch (e) {
    throw new Error(`Failed to remove patch ${patchName}: ${e.message}`);
  }
}
async function listPatches() {
  try {
    const config = await getPatchConfig();

    console.log("\nCurrently applied patches:");
    if (config.appliedPatches.length === 0) {
      console.log("  No patches applied");
    } else {
      config.appliedPatches.forEach((patch) => console.log(`  - ${patch}`));
    }
  } catch (e) {
    throw new Error(`Failed to list patches: ${e.message}`);
  }
}

async function createLocalBinLink() {
  try {
    // Create node_modules/.bin if it doesn't exist
    const binDir = path.join(process.cwd(), "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });

    // Get the absolute path to our CLI script
    const cliPath = path.join(
      process.cwd(),
      "node_modules",
      PACKAGE_NAME,
      "bin",
      "cli.js"
    );
    const localBinPath = path.join(binDir, PACKAGE_NAME);

    // Create symlink
    try {
      await fs.symlink(cliPath, localBinPath);
      console.log(`Created local binary link: ${PACKAGE_NAME}`);
    } catch (e) {
      if (e.code === "EEXIST") {
        console.log("Local binary link already exists");
      } else {
        throw e;
      }
    }

    // Make the CLI file executable
    await fs.chmod(cliPath, "755");
  } catch (e) {
    throw new Error(`Failed to create local binary link: ${e.message}`);
  }
}

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
      await ensurePatchBranch(baseBranch);

      // await execa('npm', ['install']);
      createLocalBinLink();
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

async function resetPatches() {
  try {
    // First checkout to the base branch (dev or main)
    const { stdout: branches } = await execa("git", ["branch", "-a"]);
    const hasDev = branches.includes("dev");
    const baseBranch = hasDev ? "dev" : "main";

    // Make sure we're on the base branch before deleting
    await execa("git", ["checkout", baseBranch]);

    // Try to delete the patches branch
    try {
      await execa("git", ["branch", "-D", BRANCH_NAME]);
      console.log(`Deleted branch ${BRANCH_NAME}`);
    } catch (e) {
      // Branch might not exist, that's okay
      console.log(`Branch ${BRANCH_NAME} does not exist`);
    }

    // Try to remove the remote
    try {
      await execa("git", ["remote", "remove", PATCHES_REMOTE]);
      console.log(`Removed remote ${PATCHES_REMOTE}`);
    } catch (e) {
      // Remote might not exist, that's okay
      console.log(`Remote ${PATCHES_REMOTE} does not exist`);
    }

    console.log("Reset completed successfully!");
  } catch (e) {
    throw new Error(`Failed to reset patches: ${e.message}`);
  }
}

// Add the new command to the program
program
  .command("reset")
  .description("Reset patches by removing the patch branch and remote")
  .action(async () => {
    try {
      await resetPatches();
    } catch (e) {
      console.error(`Reset failed: ${e.message}`);
      process.exit(1);
    }
  });

program.parse();
