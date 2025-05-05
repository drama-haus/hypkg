/**
 * Custom error class for Git operation failures
 * Preserves the original error information while adding context
 */
class GitOperationError extends Error {
  /**
   * Create a new GitOperationError
   * @param {string} message - Contextual error message
   * @param {Error} [originalError] - The original error that was thrown
   * @param {Object} [metadata] - Additional metadata about the error context
   */
  constructor(message, originalError = null, metadata = {}) {
    // Include original error message in our message if available
    const fullMessage = originalError 
      ? `${message}: ${originalError.message}` 
      : message;
    
    super(fullMessage);
    
    this.name = 'GitOperationError';
    this.originalError = originalError;
    this.metadata = metadata;
    
    // Preserve the original stack trace if available
    if (originalError && originalError.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

/**
 * Error when a Git command returns a non-zero exit code
 */
class GitCommandError extends GitOperationError {
  /**
   * Create a new GitCommandError
   * @param {string} command - The Git command that failed
   * @param {Error} originalError - The original error from execa
   * @param {Object} [metadata] - Additional command context
   */
  constructor(command, originalError, metadata = {}) {
    super(`Git command failed: ${command}`, originalError, {
      command,
      ...metadata
    });
    this.name = 'GitCommandError';
  }
}

/**
 * Error when a patch/mod cannot be found
 */
class PatchNotFoundError extends GitOperationError {
  /**
   * Create a new PatchNotFoundError
   * @param {string} patchName - Name of the patch that wasn't found
   * @param {string} [repository] - Repository where the patch was expected
   */
  constructor(patchName, repository = null) {
    super(
      repository 
        ? `Patch "${patchName}" not found in repository "${repository}"` 
        : `Patch "${patchName}" not found`
    );
    this.name = 'PatchNotFoundError';
    this.patchName = patchName;
    this.repository = repository;
  }
}

/**
 * Error when a repository operation fails
 */
class RepositoryError extends GitOperationError {
  /**
   * Create a new RepositoryError
   * @param {string} message - Error message
   * @param {string} [repository] - Repository name
   * @param {Error} [originalError] - Original error
   */
  constructor(message, repository = null, originalError = null) {
    super(message, originalError);
    this.name = 'RepositoryError';
    this.repository = repository;
  }
}

module.exports = {
  GitOperationError,
  GitCommandError,
  PatchNotFoundError,
  RepositoryError
}; 