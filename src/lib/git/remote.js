/**
 * Git remote repository operations
 */
const { execGit } = require('./commands');
const { GIT } = require('../constants');
const { RepositoryError } = require('../errors');

/**
 * Get all remotes 
 * @returns {Promise<string[]>} - List of remote names
 */
async function getRemotes() {
  const output = await execGit(['remote'], 'Failed to list remotes');
  return output.split('\n').filter(Boolean);
}

/**
 * Get the URL of a remote
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<string>} - URL of the remote
 */
async function getRemoteUrl(remoteName) {
  return execGit(
    ['remote', 'get-url', remoteName], 
    `Failed to get URL for remote ${remoteName}`
  );
}

/**
 * Get all registered repositories (remote name and URL)
 * @returns {Promise<Array<{name: string, url: string}>>} - Array of repository objects
 */
async function getRegisteredRepositories() {
  const remotes = await getRemotes();
  const repositories = [];

  for (const remote of remotes) {
    try {
      const url = await getRemoteUrl(remote);
      repositories.push({ name: remote, url: url.trim() });
    } catch (error) {
      console.warn(`Warning: Could not get URL for remote ${remote}: ${error.message}`);
    }
  }

  return repositories;
}

/**
 * Check if a remote exists
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<boolean>} - Whether the remote exists
 */
async function remoteExists(remoteName) {
  const remotes = await getRemotes();
  return remotes.includes(remoteName);
}

/**
 * Add a new remote
 * @param {string} remoteName - Name for the remote
 * @param {string} remoteUrl - URL of the remote
 * @returns {Promise<void>}
 */
async function addRemote(remoteName, remoteUrl) {
  return execGit(
    ['remote', 'add', remoteName, remoteUrl],
    `Failed to add remote ${remoteName}`
  );
}

/**
 * Update a remote URL
 * @param {string} remoteName - Name of the remote
 * @param {string} remoteUrl - New URL for the remote
 * @returns {Promise<void>}
 */
async function updateRemoteUrl(remoteName, remoteUrl) {
  return execGit(
    ['remote', 'set-url', remoteName, remoteUrl],
    `Failed to update URL for remote ${remoteName}`
  );
}

/**
 * Remove a remote
 * @param {string} remoteName - Name of the remote to remove
 * @returns {Promise<void>}
 */
async function removeRemote(remoteName) {
  return execGit(
    ['remote', 'remove', remoteName],
    `Failed to remove remote ${remoteName}`
  );
}

/**
 * Fetch from a remote
 * @param {string} remoteName - Name of the remote
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.prune=false] - Whether to prune deleted branches
 * @param {boolean} [options.tags=false] - Whether to fetch tags
 * @param {string} [options.branch] - Specific branch to fetch
 * @returns {Promise<void>}
 */
async function fetchRemote(remoteName, { prune = false, tags = false, branch = null } = {}) {
  const args = ['fetch', remoteName];
  
  if (prune) {
    args.push('--prune');
  }
  
  if (tags) {
    args.push('--tags');
  }
  
  if (branch) {
    args.push(branch);
  }
  
  return execGit(args, `Failed to fetch from ${remoteName}`);
}

/**
 * Get the appropriate base repository remote
 * This will return 'hyperfy' if origin is not pointing to the canonical repository
 * @param {string} [canonicalRepo] - The canonical repository URL to check against
 * @returns {Promise<string>} - The remote name to use
 */
async function getBaseRemote(canonicalRepo = null) {
  const remotes = await getRemotes();
  
  // If there's no origin, use hyperfy if available
  if (!remotes.includes(GIT.REMOTES.ORIGIN)) {
    return remotes.includes(GIT.REMOTES.HYPERFY) 
      ? GIT.REMOTES.HYPERFY 
      : null;
  }
  
  // If origin exists and canonical repo is specified, check if origin points to it
  if (canonicalRepo) {
    const originUrl = await getRemoteUrl(GIT.REMOTES.ORIGIN);
    
    // If origin is not pointing to canonical repo but hyperfy remote exists, use hyperfy
    if (originUrl.trim() !== canonicalRepo && remotes.includes(GIT.REMOTES.HYPERFY)) {
      return GIT.REMOTES.HYPERFY;
    }
  }
  
  // Default to origin
  return GIT.REMOTES.ORIGIN;
}

/**
 * Set up a patches remote
 * @param {string} patchesRepo - URL of the patches repository
 * @param {string} patchesRemote - Name for the patches remote
 * @returns {Promise<void>}
 */
async function setupPatchesRemote(patchesRepo, patchesRemote) {
  const remotes = await getRemotes();
  
  if (!remotes.includes(patchesRemote)) {
    await addRemote(patchesRemote, patchesRepo);
  }
  
  return fetchRemote(patchesRemote);
}

/**
 * Verify that the current repository matches the expected repository
 * @param {string} targetRepo - Expected repository URL
 * @returns {Promise<void>}
 * @throws {RepositoryError} - If not in the correct repository
 */
async function verifyRepo(targetRepo) {
  const origin = await getRemoteUrl(GIT.REMOTES.ORIGIN);
  
  if (!origin.includes(targetRepo.replace('.git', ''))) {
    throw new RepositoryError(
      `Not in the correct repository. Expected origin to be ${targetRepo}`
    );
  }
}

module.exports = {
  getRemotes,
  getRemoteUrl,
  getRegisteredRepositories,
  remoteExists,
  addRemote,
  updateRemoteUrl,
  removeRemote,
  fetchRemote,
  getBaseRemote,
  setupPatchesRemote,
  verifyRepo
}; 