/**
 * Git state management utilities
 * Provides functions for saving and restoring Git state (stashing changes, etc.)
 */
const { execGit } = require('./commands');
const { getCurrentBranch } = require('./branch');
const { reset, hasUncommittedChanges } = require('./commands');

/**
 * Generate a unique stash name based on timestamp
 * @param {string} [prefix='backup'] - Prefix for the stash name
 * @returns {string} - Unique stash name
 */
function generateStashName(prefix = 'backup') {
  return `${prefix}-${Date.now()}`;
}

/**
 * Save the current Git state for later restoration
 * @returns {Promise<Object>} - Object containing the saved state
 */
async function saveGitState() {
  const currentBranch = await getCurrentBranch();
  const stashName = generateStashName();
  const hasChanges = await hasUncommittedChanges();

  if (hasChanges) {
    await execGit(
      ['stash', 'push', '-m', stashName],
      'Failed to stash changes'
    );
  }

  const commit = await execGit(
    ['rev-parse', 'HEAD'],
    'Failed to get current commit'
  );

  return {
    branch: currentBranch,
    stashName: hasChanges ? stashName : null,
    commit,
    timestamp: Date.now()
  };
}

/**
 * Find the index of a stash by name
 * @param {string} stashName - Name of the stash to find
 * @returns {Promise<number>} - Index of the stash, or -1 if not found
 */
async function findStashIndex(stashName) {
  const stashList = await execGit(['stash', 'list'], 'Failed to list stashes');
  
  if (!stashList) {
    return -1;
  }
  
  const lines = stashList.split('\n');
  return lines.findIndex(line => line.includes(stashName));
}

/**
 * Restore a previously saved Git state
 * @param {Object} state - State object returned by saveGitState
 * @returns {Promise<void>}
 */
async function restoreGitState(state) {
  // Reset any changes
  await reset('HEAD', '--hard');
  
  // Return to the original branch
  await execGit(
    ['checkout', state.branch],
    'Failed to restore original branch'
  );
  
  // Reset to the original commit
  await execGit(
    ['reset', '--hard', state.commit],
    'Failed to reset to original commit'
  );

  // Restore stashed changes if any
  if (state.stashName) {
    const stashIndex = await findStashIndex(state.stashName);
    
    if (stashIndex !== -1) {
      await execGit(
        ['stash', 'pop', `stash@{${stashIndex}}`],
        'Failed to restore stashed changes'
      );
    } else {
      console.warn(`Warning: Could not find stash with name ${state.stashName}`);
    }
  }
}

/**
 * Stash any uncommitted changes
 * @param {string} [message] - Optional message for the stash
 * @returns {Promise<boolean>} - True if changes were stashed, false otherwise
 */
async function stashChanges(message = 'Auto-stashed changes') {
  if (await hasUncommittedChanges()) {
    await execGit(
      ['stash', 'push', '-m', message],
      'Failed to stash changes'
    );
    return true;
  }
  return false;
}

/**
 * Pop the most recent stash
 * @returns {Promise<boolean>} - True if a stash was popped, false if no stashes
 */
async function popStashedChanges() {
  try {
    // Check if there are any stashes
    const stashList = await execGit(['stash', 'list'], 'Failed to list stashes');
    
    if (!stashList) {
      return false;
    }
    
    await execGit(['stash', 'pop'], 'Failed to pop stashed changes');
    return true;
  } catch (error) {
    console.warn(`Warning: Failed to pop stashed changes: ${error.message}`);
    return false;
  }
}

module.exports = {
  saveGitState,
  restoreGitState,
  stashChanges,
  popStashedChanges,
  findStashIndex,
  generateStashName
}; 