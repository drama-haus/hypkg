/**
 * Git utilities index
 * Exports all Git-related operations from a single entry point
 */

// Import modules
const commands = require('./commands');
const branch = require('./branch');
const state = require('./state');
const remote = require('./remote');
const patch = require('./patch');
const pkgManager = require('./package');

// Export everything consolidated
module.exports = {
  // Core Git command execution
  execGit: commands.execGit,
  isGitRepository: commands.isGitRepository,
  abortOperation: commands.abortOperation,
  getStatus: commands.getStatus,
  hasUncommittedChanges: commands.hasUncommittedChanges,
  reset: commands.reset,
  
  // Branch operations
  getCurrentBranch: branch.getCurrentBranch,
  getBranches: branch.getBranches,
  getLocalBranches: branch.getLocalBranches,
  getAllBranches: branch.getAllBranches,
  getRemoteBranches: branch.getRemoteBranches,
  getBaseBranch: branch.getBaseBranch,
  branchExists: branch.branchExists,
  createBranch: branch.createBranch,
  checkoutBranch: branch.checkoutBranch,
  deleteBranch: branch.deleteBranch,
  isOnBaseBranch: branch.isOnBaseBranch,
  getPatchBranches: branch.getPatchBranches,
  syncBranches: branch.syncBranches,
  ensurePatchBranch: branch.ensurePatchBranch,
  
  // State management
  saveGitState: state.saveGitState,
  restoreGitState: state.restoreGitState,
  stashChanges: state.stashChanges,
  popStashedChanges: state.popStashedChanges,
  
  // Remote management
  getRemotes: remote.getRemotes,
  getRemoteUrl: remote.getRemoteUrl,
  getRegisteredRepositories: remote.getRegisteredRepositories,
  remoteExists: remote.remoteExists,
  addRemote: remote.addRemote,
  updateRemoteUrl: remote.updateRemoteUrl,
  removeRemote: remote.removeRemote,
  fetchRemote: remote.fetchRemote,
  getBaseRemote: remote.getBaseRemote,
  setupPatchesRemote: remote.setupPatchesRemote,
  verifyRepo: remote.verifyRepo,
  
  // Patch operations
  getTagCompatibleName: patch.getTagCompatibleName,
  getAppliedPatches: patch.getAppliedPatches,
  getCommitMessage: patch.getCommitMessage,
  parseEnhancedCommitMessage: patch.parseEnhancedCommitMessage,
  generateEnhancedCommitMessage: patch.generateEnhancedCommitMessage,
  getPatchBranchName: patch.getPatchBranchName,
  isPatchApplied: patch.isPatchApplied,
  findPatchCommit: patch.findPatchCommit,
  getAvailableVersions: patch.getAvailableVersions,
  getNextPatchVersion: patch.getNextPatchVersion,
  getPatchNameForBranch: patch.getPatchNameForBranch,
  isBaseBranch: patch.isBaseBranch,
  isNamespacedPatch: patch.isNamespacedPatch,
  parsePatchName: patch.parsePatchName,
  getRepositoryForPatch: patch.getRepositoryForPatch,
  
  // Package management
  handlePackageChanges: pkgManager.handlePackageChanges,
  
  // Also expose the original modules for more targeted imports
  commands,
  branch,
  state,
  remote,
  patch,
  pkgManager
}; 