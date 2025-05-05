/**
 * Utils wrapper module (LEGACY)
 * This module is maintained for backward compatibility.
 * New code should import directly from src/lib/git.
 * 
 * @deprecated Use direct imports from src/lib/git instead
 */
const chalk = require("chalk");
const git = require("./src/lib/git");
const { CLI } = require("./src/lib/constants");

// Utility function for consistent logging
function log(message, type = "info") {
  const prefix = {
    info: chalk.blue(CLI.LOG_PREFIXES.INFO),
    success: chalk.green(CLI.LOG_PREFIXES.SUCCESS),
    warning: chalk.yellow(CLI.LOG_PREFIXES.WARNING),
    error: chalk.red(CLI.LOG_PREFIXES.ERROR),
    step: chalk.cyan(CLI.LOG_PREFIXES.STEP),
  }[type];

  console.log(`${prefix} ${message}`);
}

// Re-export all git utilities for backward compatibility
module.exports = {
  // Git utilities
  execGit: git.execGit,
  getCurrentBranch: git.getCurrentBranch,
  getBaseBranch: git.getBaseBranch,
  getAppliedPatches: async () => {
    // Legacy format conversion 
    const patches = await git.getAppliedPatches();
    return patches.map(patch => patch.name).filter(Boolean);
  },
  saveGitState: git.saveGitState,
  restoreGitState: git.restoreGitState,

  // Repository management
  verifyRepo: git.verifyRepo, 
  setupPatchesRemote: git.setupPatchesRemote,

  // Branch management
  syncBranches: git.syncBranches,
  ensurePatchBranch: git.ensurePatchBranch,

  // Package management
  handlePackageChanges: git.handlePackageChanges,

  // Logging utilities
  log,
};
