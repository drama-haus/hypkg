/**
 * Git-related constants
 */
exports.GIT = {
  // Branch and commit prefixes
  BRANCH_PREFIX: 'cow_',
  COMMIT_PREFIX: 'cow:',
  TAG_PREFIX: '',
  
  // Commit message formats and separators
  COMMIT_SEPARATOR: '---COMMIT_SEPARATOR---',
  METADATA_SEPARATOR: '---',
  
  // Metadata keys in commit messages
  METADATA: {
    MOD_HASH: 'mod-hash',
    MOD_BASE: 'mod-base',
    CURRENT_BASE: 'current-base'
  },
  
  // Common branch names
  COMMON_BASE_BRANCHES: ['main', 'master', 'dev', 'develop', 'development'],
  
  // Default remote names
  REMOTES: {
    ORIGIN: 'origin',
    HYPERFY: 'hyperfy',
    PATCHES: 'patches'
  },
  
  // Error message prefixes
  ERROR_PREFIXES: {
    CHECKOUT: 'Failed to checkout',
    BRANCH: 'Failed to create branch',
    FETCH: 'Failed to fetch',
    PULL: 'Failed to pull',
    STATUS: 'Failed to check git status',
    COMMIT: 'Failed to commit changes',
    STASH: 'Failed to stash changes',
    CHERRY_PICK: 'Failed to cherry-pick commit'
  }
};

/**
 * CLI and log-related constants
 */
exports.CLI = {
  LOG_PREFIXES: {
    INFO: 'ℹ',
    SUCCESS: '✓',
    WARNING: '⚠',
    ERROR: '✖',
    STEP: '→'
  }
}; 