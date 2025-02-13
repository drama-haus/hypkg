#!/usr/bin/env node
const path = require("path");
const fs = require("fs").promises;
const { execSync } = require("child_process");

const packageJson = require(path.join(__dirname, "..", "package.json"));
const TARGET_REPO = packageJson.config.targetRepo;

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

    // Use the same TARGET_REPO check from your original code
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
      "hucow is not installed in this project. Please run npm install"
    );
  }
}

async function main() {
  try {
    const gitRoot = await findGitRoot();
    await verifyGameEngineRepo(gitRoot);
    const cliPath = await findLocalCLI(gitRoot);
    require(cliPath);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(
      "Please ensure you are in the game engine repository and have run npm install"
    );
    process.exit(1);
  }
}

main();
