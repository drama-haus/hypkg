#!/usr/bin/env node
const path = require("path");
const fs = require("fs").promises;
const { execSync } = require("child_process");

// Detect if running through npx by checking if we're in a temporary npm directory
function isRunningThroughNPX() {
  return (
    process.cwd().includes("_npx/") || process.env.npm_lifecycle_event === "npx"
  );
}

async function findGitRoot() {
  try {
    const gitDir = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
    return gitDir;
  } catch (e) {
    throw new Error("Not in a git repository");
  }
}

async function verifyGameEngineRepo(gitRoot) {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      cwd: gitRoot,
    }).trim();

    if (!remote.includes(TARGET_REPO.replace(".git", ""))) {
      throw new Error("Not in the game engine repository");
    }
  } catch (e) {
    throw new Error(`Not in the game engine repository: ${e.message}`);
  }
}

async function findLocalCLI(gitRoot) {
  try {
    const cliPath = path.join(
      gitRoot,
      "node_modules",
      "hucow",
      "bin",
      "cli.js"
    );
    await fs.access(cliPath);
    return cliPath;
  } catch (e) {
    throw new Error(
      "hucow is not installed in this project. Please run: npx hucow"
    );
  }
}

async function main() {
  try {
    if (isRunningThroughNPX()) {
      // If running through npx with no arguments, run install
      if (process.argv.length === 2) {
        const cliPath = path.join(__dirname, "cli.js");
        process.argv.push("install");
        require(cliPath);
        return;
      }
      // If running through npx with arguments, just execute the CLI
      require(path.join(__dirname, "cli.js"));
      return;
    }

    // For direct hucow command, check repo and show usage
    const gitRoot = await findGitRoot();
    await verifyGameEngineRepo(gitRoot);
    const cliPath = await findLocalCLI(gitRoot);
    require(cliPath);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (!isRunningThroughNPX()) {
      console.error("Please ensure you are in the game engine repository");
    }
    process.exit(1);
  }
}

main();
