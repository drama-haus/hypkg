/**
 * Git branch management utilities
 */
const { execGit } = require('./commands');
const { GIT } = require('../constants');

/**
 * Get the current branch name
 * @returns {Promise<string>} - Current branch name
 */
async function getCurrentBranch() {
  return execGit(['branch', '--show-current'], 'Failed to get current branch');
}

/**
 * Get all branches matching a pattern
 * @param {Object} options - Options for listing branches
 * @param {boolean} [options.all=false] - Include remote branches
 * @param {boolean} [options.remote=false] - Only list remote branches
 * @param {string} [options.pattern] - Pattern to filter branches
 * @returns {Promise<string[]>} - List of branch names
 */
async function getBranches({ all = false, remote = false, pattern = '' } = {}) {
  const args = ['branch'];
  
  if (all) {
    args.push('-a');
  } else if (remote) {
    args.push('-r');
  }
  
  if (pattern) {
    args.push('--list', pattern);
  }
  
  const output = await execGit(args, 'Failed to list branches');
  
  return output
    .split('\n')
    .map(branch => branch.trim().replace('* ', ''))
    .filter(Boolean);
}

/**
 * Get local branches only
 * @param {string} [pattern] - Optional pattern to filter branches
 * @returns {Promise<string[]>} - List of local branch names
 */
async function getLocalBranches(pattern = '') {
  return getBranches({ pattern });
}

/**
 * Get all branches including remotes
 * @param {string} [pattern] - Optional pattern to filter branches
 * @returns {Promise<string[]>} - List of all branch names
 */
async function getAllBranches(pattern = '') {
  return getBranches({ all: true, pattern });
}

/**
 * Get remote branches only
 * @param {string} [pattern] - Optional pattern to filter branches
 * @returns {Promise<string[]>} - List of remote branch names
 */
async function getRemoteBranches(pattern = '') {
  return getBranches({ remote: true, pattern });
}

/**
 * Determine the base branch of the project
 * Prefers 'dev' if it exists, otherwise 'main'
 * @returns {Promise<string>} - Name of the base branch
 */
async function getBaseBranch() {
  const branches = await getLocalBranches();
  return branches.includes('dev') ? 'dev' : 'main';
}

/**
 * Check if a branch exists
 * @param {string} branchName - Name of the branch to check
 * @param {boolean} [includeRemote=false] - Whether to include remote branches in the check
 * @returns {Promise<boolean>} - Whether the branch exists
 */
async function branchExists(branchName, includeRemote = false) {
  const branches = await getBranches({ all: includeRemote });
  return branches.includes(branchName);
}

/**
 * Create a new branch
 * @param {string} branchName - Name of the branch to create
 * @param {string} [startPoint='HEAD'] - Starting point for the new branch
 * @param {boolean} [checkout=true] - Whether to check out the new branch
 * @returns {Promise<string>} - Command output
 */
async function createBranch(branchName, startPoint = 'HEAD', checkout = true) {
  const args = checkout ? ['checkout', '-b'] : ['branch'];
  args.push(branchName);
  
  if (startPoint !== 'HEAD') {
    args.push(startPoint);
  }
  
  return execGit(args, `Failed to create branch ${branchName}`);
}

/**
 * Checkout a branch
 * @param {string} branchName - Name of the branch to check out
 * @returns {Promise<string>} - Command output
 */
async function checkoutBranch(branchName) {
  return execGit(['checkout', branchName], `Failed to checkout branch ${branchName}`);
}

/**
 * Delete a branch
 * @param {string} branchName - Name of the branch to delete
 * @param {boolean} [force=false] - Whether to force delete the branch
 * @returns {Promise<string>} - Command output
 */
async function deleteBranch(branchName, force = false) {
  const args = ['branch', force ? '-D' : '-d', branchName];
  return execGit(args, `Failed to delete branch ${branchName}`);
}

/**
 * Check if the current branch is a base branch
 * @returns {Promise<boolean>} - Whether the current branch is a base branch
 */
async function isOnBaseBranch() {
  const currentBranch = await getCurrentBranch();
  const baseBranch = await getBaseBranch();
  
  return (
    currentBranch === baseBranch ||
    GIT.COMMON_BASE_BRANCHES.includes(currentBranch)
  );
}

/**
 * Get all patch branches (branches starting with cow_)
 * @param {string} [remote] - Optional remote name to get branches from
 * @returns {Promise<string[]>} - List of patch branch names
 */
async function getPatchBranches(remote = null) {
  const pattern = `${GIT.BRANCH_PREFIX}*`;
  
  if (remote) {
    // For remote branches
    const remoteBranches = await getRemoteBranches(`${remote}/${pattern}`);
    return remoteBranches.map(branch => branch.replace(`remotes/${remote}/`, ''));
  }
  
  // For local branches
  return getLocalBranches(pattern);
}

/**
 * Sync branches with remote
 * @param {string} [remote='origin'] - Remote to sync with
 * @returns {Promise<string>} - Base branch that was synced
 */
async function syncBranches(remote = 'origin') {
  await execGit(['fetch', remote], `Failed to fetch ${remote}`);
  const baseBranch = await getBaseBranch();
  await checkoutBranch(baseBranch);
  await execGit(['pull', remote, baseBranch], `Failed to pull ${baseBranch}`);
  return baseBranch;
}

/**
 * Ensure a patch branch exists and is properly set up
 * @param {string} branchName - Name of the branch to ensure
 * @param {string} [selectedBranch] - Remote branch to track (if provided)
 * @param {string} [patchesRemote='patches'] - Remote name for patches
 * @returns {Promise<void>}
 */
async function ensurePatchBranch(branchName, selectedBranch, patchesRemote = 'patches') {
  const exists = await branchExists(branchName);

  if (!exists) {
    const baseBranch = await getBaseBranch();
    await createBranch(branchName, baseBranch);
  } else {
    await checkoutBranch(branchName);
  }

  if (selectedBranch) {
    try {
      await execGit(
        ['branch', `--set-upstream-to=${patchesRemote}/${selectedBranch}`],
        'Failed to set upstream'
      );
    } catch (e) {
      // No remote branch found, creating new local branch
      console.log("No remote branch found, creating new local branch");
    }
  }
}

module.exports = {
  getCurrentBranch,
  getBranches,
  getLocalBranches,
  getAllBranches,
  getRemoteBranches,
  getBaseBranch,
  branchExists,
  createBranch,
  checkoutBranch,
  deleteBranch,
  isOnBaseBranch,
  getPatchBranches,
  syncBranches,
  ensurePatchBranch
}; 