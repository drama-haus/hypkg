const chalk = require("chalk");
const inquirer = require("inquirer");
const path = require("path");
const utils = require("../utils");
const fs = require("fs").promises;
const config = require("../config.json");
const { searchPatches } = require("../../bin/searchPatches");
const { getPatchInfo } = require("../../bin/getPatchInfo");

const TARGET_REPO = config.targetRepo;
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
  
  // Get both local and remote branches
  const allBranches = branches
    .split("\n")
    .map((b) => b.trim().replace("* ", ""))
    .filter((b) => b && !b.includes("HEAD"));

  // Extract unique branch names (local and remote)
  const branchNames = new Set();
  
  // Add local branches
  allBranches
    .filter((b) => !b.startsWith("remotes/"))
    .forEach((b) => branchNames.add(b));
  
  // Add remote branches (extract just the branch name)
  allBranches
    .filter((b) => b.startsWith("remotes/origin/"))
    .forEach((b) => {
      const branchName = b.replace("remotes/origin/", "");
      branchNames.add(branchName);
    });

  const availableBranches = Array.from(branchNames).sort();

  // Determine default branch preference: dev > main > master > current > first available
  let defaultBranch = currentBranch;
  if (availableBranches.includes('dev')) {
    defaultBranch = 'dev';
  } else if (availableBranches.includes('main')) {
    defaultBranch = 'main';
  } else if (availableBranches.includes('master')) {
    defaultBranch = 'master';
  }

  const { branch } = await inquirer.prompt([
    {
      type: "list",
      name: "branch",
      message: "Which branch would you like to use?",
      default: defaultBranch,
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

module.exports = {
  promptForAction,
  promptForNewProject,
  promptForBranch,
  promptForPatches,
  promptForEnvVariables,
};
