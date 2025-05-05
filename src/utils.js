/**
 * Utils wrapper module (LEGACY)
 * This module is maintained for backward compatibility.
 * New code should import directly from src/lib/git.
 * 
 * @deprecated Use direct imports from src/lib/git instead
 */
const chalk = require("chalk");
const git = require("./lib/git");
const { CLI } = require("./lib/constants");

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
  getRelativeTime,
};
