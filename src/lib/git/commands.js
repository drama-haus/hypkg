/**
 * Git command execution module
 * Provides utilities for executing Git commands with proper error handling
 */
const execa = require('execa');
const { GitCommandError } = require('../errors');
const { DEBUG } = process.env.DEBUG === 'true' || false;

/**
 * Execute a Git command with proper error handling
 * @param {string[]} args - Git command arguments
 * @param {string} [errorMessage] - Error message prefix for failures
 * @param {Object} [options] - Additional options for execa
 * @returns {Promise<string>} - Command output
 * @throws {GitCommandError} - If the command fails
 */
async function execGit(args, errorMessage = 'Git command failed', options = {}) {
  const command = `git ${args.join(' ')}`;
  
  if (DEBUG) {
    console.log(`Executing: ${command}`);
  }

  try {
    const result = await execa('git', args, options);
    
    if (DEBUG && result.stdout.trim()) {
      console.log(`Output: ${result.stdout.trim()}`);
    }
    
    return result.stdout.trim();
  } catch (error) {
    throw new GitCommandError(
      command,
      error,
      { args, errorMessage }
    );
  }
}

/**
 * Check if a Git repository exists in the current directory
 * @returns {Promise<boolean>} - Whether a Git repository exists
 */
async function isGitRepository() {
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], 'Not a Git repository');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Abort an in-progress Git operation
 * @param {string} operation - Operation to abort (cherry-pick, rebase, merge, etc.)
 * @returns {Promise<void>}
 */
async function abortOperation(operation) {
  try {
    await execGit([operation, '--abort'], `Failed to abort ${operation}`);
  } catch (error) {
    // Silently ignore errors if no operation in progress
    if (!error.message.includes('no cherry-pick') && 
        !error.message.includes('no rebase') && 
        !error.message.includes('no merge')) {
      throw error;
    }
  }
}

/**
 * Get the status of the working directory
 * @param {boolean} [porcelain=true] - Whether to use porcelain format
 * @returns {Promise<string>} - Git status output
 */
async function getStatus(porcelain = true) {
  const args = ['status'];
  if (porcelain) {
    args.push('--porcelain');
  }
  return execGit(args, 'Failed to check git status');
}

/**
 * Check if the working directory has uncommitted changes
 * @returns {Promise<boolean>} - Whether there are uncommitted changes
 */
async function hasUncommittedChanges() {
  const status = await getStatus();
  return status.length > 0;
}

/**
 * Reset the working directory to a specific ref
 * @param {string} ref - Reference to reset to (HEAD, commit hash, etc.)
 * @param {string} [mode='--hard'] - Reset mode (--hard, --soft, --mixed)
 * @returns {Promise<string>} - Command output
 */
async function reset(ref = 'HEAD', mode = '--hard') {
  return execGit(['reset', mode, ref], `Failed to reset to ${ref}`);
}

module.exports = {
  execGit,
  isGitRepository,
  abortOperation,
  getStatus,
  hasUncommittedChanges,
  reset
}; 