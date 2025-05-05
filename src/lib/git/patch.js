/**
 * Git patch management operations
 * Focused on operations related to patches/mods
 */
const { execGit } = require('./commands');
const { getBaseBranch, getCurrentBranch } = require('./branch');
const { getBaseRemote, getRegisteredRepositories } = require('./remote');
const { GIT } = require('../constants');
const { PatchNotFoundError } = require('../errors');

/**
 * Convert a potentially namespaced patch name to a tag-compatible format
 * @param {string} patchName - The patch name (potentially with repo prefix)
 * @returns {string} - The tag-compatible format replacing / with -
 */
function getTagCompatibleName(patchName) {
  // Replace any forward slashes with hyphens for git tag compatibility
  return patchName.replace(/\//g, '-');
}

/**
 * Get all applied patches
 * @returns {Promise<Array<{name: string, version: string|null, originalCommitHash: string|null, modBaseBranchHash: string|null, currentBaseBranchHash: string|null}>>} 
 */
async function getAppliedPatches() {
  const baseBranch = await getBaseBranch();
  
  try {
    // Get all commits between base branch and HEAD with the cow prefix
    const commits = await execGit(
      ['log', `${baseBranch}..HEAD`, `--grep=^${GIT.COMMIT_PREFIX}`, '--format=%s'],
      'Failed to get patch commits'
    );

    if (!commits) {
      return [];
    }
    
    return commits
      .split('\n')
      .filter(Boolean)
      .map(commit => {
        // Parse the commit message to extract patch name
        const prefixMatch = commit.match(new RegExp(`^${GIT.COMMIT_PREFIX}\\s+(.+)$`));
        
        if (!prefixMatch) {
          return null;
        }
        
        // Extract version information if available
        const patchContent = prefixMatch[1];
        const versionMatch = patchContent.match(/\sv(\d+\.\d+\.\d+)/);
        
        const name = versionMatch
          ? patchContent.substring(0, patchContent.lastIndexOf(' v'))
          : patchContent;
          
        const version = versionMatch ? versionMatch[1] : null;
        
        return { name, version, originalCommitHash: null, modBaseBranchHash: null, currentBaseBranchHash: null };
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * Get the full commit message for a specific commit
 * @param {string} commitHash - Commit hash or reference
 * @returns {Promise<string>} - Full commit message
 */
async function getCommitMessage(commitHash) {
  return execGit(
    ['log', '-1', '--format=%B', commitHash],
    `Failed to get commit message for ${commitHash}`
  );
}

/**
 * Parse an enhanced commit message to extract metadata
 * @param {string} commitMessage - The commit message to parse
 * @returns {Object} - The parsed metadata
 */
function parseEnhancedCommitMessage(commitMessage) {
  // Handle both multiline and single-line formats
  const lines = commitMessage.trim().split('\n');

  const patchInfo = {
    name: null,
    version: null,
    originalCommitHash: null,
    modBaseBranchHash: null,
    currentBaseBranchHash: null,
  };

  // First try to parse the first line for patch name and version
  const firstLine = lines[0] || '';
  const prefixMatch = firstLine.match(new RegExp(`^${GIT.COMMIT_PREFIX}\\s+(.+)$`));
  
  if (prefixMatch) {
    // Check if the metadata is on the same line (single-line format)
    if (firstLine.includes(` ${GIT.METADATA_SEPARATOR} `)) {
      // Single-line format: "cow: name v1.0.0 --- mod-hash: abc mod-base: def current-base: ghi"
      const parts = firstLine.split(` ${GIT.METADATA_SEPARATOR} `);
      const nameVersionPart = parts[0].substring(GIT.COMMIT_PREFIX.length + 1).trim();

      // Extract name and version from the first part
      const versionMatch = nameVersionPart.match(/ v([0-9.]+)/);
      if (versionMatch) {
        patchInfo.name = nameVersionPart.substring(0, nameVersionPart.lastIndexOf(' v'));
        patchInfo.version = versionMatch[1];
      } else {
        patchInfo.name = nameVersionPart;
      }

      // Extract metadata from the rest of the line
      if (parts.length > 1) {
        const metadataPart = parts[1];
        const metadataItems = metadataPart.split(' ');

        for (let i = 0; i < metadataItems.length; i++) {
          if (metadataItems[i] === `${GIT.METADATA.MOD_HASH}:` && i + 1 < metadataItems.length) {
            patchInfo.originalCommitHash = metadataItems[i + 1];
          } else if (metadataItems[i] === `${GIT.METADATA.MOD_BASE}:` && i + 1 < metadataItems.length) {
            patchInfo.modBaseBranchHash = metadataItems[i + 1];
          } else if (metadataItems[i] === `${GIT.METADATA.CURRENT_BASE}:` && i + 1 < metadataItems.length) {
            patchInfo.currentBaseBranchHash = metadataItems[i + 1];
          }
        }
      }
    } else {
      // Multi-line format: traditional format with --- separator on its own line
      const patchNameWithVersion = prefixMatch[1].trim();
      const versionMatch = patchNameWithVersion.match(/ v([0-9.]+)/);

      if (versionMatch) {
        patchInfo.name = patchNameWithVersion.substring(0, patchNameWithVersion.lastIndexOf(' v'));
        patchInfo.version = versionMatch[1];
      } else {
        patchInfo.name = patchNameWithVersion;
      }

      // Parse metadata section from subsequent lines
      let inMetadataSection = false;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line === GIT.METADATA_SEPARATOR) {
          inMetadataSection = true;
          continue;
        }

        if (!inMetadataSection) continue;

        if (line.startsWith(`${GIT.METADATA.MOD_HASH}: `)) {
          patchInfo.originalCommitHash = line.substring(GIT.METADATA.MOD_HASH.length + 2);
        } else if (line.startsWith(`${GIT.METADATA.MOD_BASE}: `)) {
          patchInfo.modBaseBranchHash = line.substring(GIT.METADATA.MOD_BASE.length + 2);
        } else if (line.startsWith(`${GIT.METADATA.CURRENT_BASE}: `)) {
          patchInfo.currentBaseBranchHash = line.substring(GIT.METADATA.CURRENT_BASE.length + 2);
        }
      }
    }
  }

  return patchInfo;
}

/**
 * Generates an enhanced commit message with metadata
 * @param {string} patchName - Name of the patch
 * @param {string} [version] - Version of the patch (optional)
 * @param {string} [originalCommitHash] - Original commit hash of the mod release
 * @param {string} [modBaseBranchHash] - Base branch commit hash when the mod was created
 * @param {string} [currentBaseBranchHash] - Current base branch commit hash
 * @returns {Promise<string>} - The enhanced commit message
 */
async function generateEnhancedCommitMessage(
  patchName,
  version = null,
  originalCommitHash = null,
  modBaseBranchHash = null,
  currentBaseBranchHash = null
) {
  // Get required hashes if not provided
  if (!currentBaseBranchHash) {
    const baseBranch = await getBaseBranch();
    const baseRemote = await getBaseRemote();
    try {
      currentBaseBranchHash = await execGit(
        ['rev-parse', `${baseRemote}/${baseBranch}`],
        'Failed to get current base branch commit hash'
      );
    } catch (e) {
      currentBaseBranchHash = 'unknown';
    }
  }

  // Format the commit message with additional metadata
  const versionInfo = version ? ` v${version}` : '';
  let message = `${GIT.COMMIT_PREFIX} ${patchName}${versionInfo}\n`;

  // Add metadata section
  message += `${GIT.METADATA_SEPARATOR}\n`;
  message += `${GIT.METADATA.MOD_HASH}: ${originalCommitHash || 'unknown'}\n`;
  message += `${GIT.METADATA.MOD_BASE}: ${modBaseBranchHash || 'unknown'}\n`;
  message += `${GIT.METADATA.CURRENT_BASE}: ${currentBaseBranchHash}\n`;

  return message;
}

/**
 * Get the branch name for a patch (always with cow_ prefix)
 * @param {string} patchName - Patch name
 * @returns {string} - Branch name with cow_ prefix
 */
function getPatchBranchName(patchName) {
  // Ensure the patch name doesn't already have the prefix
  const cleanPatchName = patchName.replace(new RegExp(`^${GIT.BRANCH_PREFIX}`), '');
  return `${GIT.BRANCH_PREFIX}${cleanPatchName}`;
}

/**
 * Check if a specific patch is applied
 * @param {string} patchName - Name of the patch to check
 * @returns {Promise<boolean>} - Whether the patch is applied
 */
async function isPatchApplied(patchName) {
  const appliedPatches = await getAppliedPatches();
  return appliedPatches.some(patch => patch.name === patchName);
}

/**
 * Find the commit that introduced a specific patch
 * @param {string} patchName - Name of the patch
 * @returns {Promise<string>} - Commit hash
 * @throws {PatchNotFoundError} - If the patch is not found
 */
async function findPatchCommit(patchName) {
  const baseBranch = await getBaseBranch();
  
  try {
    // Try to find the commit with the exact patch name
    const commitHash = await execGit(
      ['log', `${baseBranch}..HEAD`, '--grep', `^${GIT.COMMIT_PREFIX} ${patchName}`, '--format=%H'],
      `Failed to find commit for patch ${patchName}`
    );
    
    if (!commitHash) {
      throw new PatchNotFoundError(patchName);
    }
    
    // Take the first line in case multiple commits match
    return commitHash.split('\n')[0];
  } catch (error) {
    throw new PatchNotFoundError(patchName, error);
  }
}

/**
 * Get all available versions of a patch
 * @param {string} patchName - Name of the patch
 * @returns {Promise<string[]>} - List of available versions, newest first
 */
async function getAvailableVersions(patchName) {
  const tagCompatibleName = getTagCompatibleName(patchName);
  
  try {
    // Ensure we have the latest tags
    await execGit(['fetch', '--all', '--tags'], 'Failed to fetch tags');
    
    // Get all version tags for this patch
    const tags = await execGit(
      ['tag', '-l', `${tagCompatibleName}-v*`],
      'Failed to list versions'
    );
    
    if (!tags) {
      return [];
    }
    
    // Parse and sort versions
    const versions = tags
      .split('\n')
      .map(tag => tag.replace(`${tagCompatibleName}-v`, ''))
      .filter(Boolean)
      .map(version => {
        const [major, minor, patch] = version.split('.').map(Number);
        return { major, minor, patch, original: version };
      })
      .sort((a, b) => {
        if (a.major !== b.major) return b.major - a.major;
        if (a.minor !== b.minor) return b.minor - a.minor;
        return b.patch - a.patch;
      });
    
    // Return sorted version strings
    return versions.map(v => v.original);
  } catch (error) {
    console.warn(`Error getting versions for ${patchName}: ${error.message}`);
    return [];
  }
}

/**
 * Get the next version number for a patch
 * @param {string} patchName - Name of the patch
 * @returns {Promise<string>} - Next version number (e.g., "1.0.0")
 */
async function getNextPatchVersion(patchName) {
  const versions = await getAvailableVersions(patchName);
  
  if (versions.length === 0) {
    return '1.0.0';
  }
  
  const latest = versions[0];
  const [major, minor, patch] = latest.split('.').map(Number);
  
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Get the associated patch name for a branch
 * This first checks git config to see if a mapping exists,
 * then falls back to naming conventions
 *
 * @param {string} branchName - Name of the branch
 * @returns {Promise<string>} - The patch name associated with this branch
 */
async function getPatchNameForBranch(branchName) {
  try {
    // First check if there's a stored mapping in git config
    try {
      const configKey = `hyperfy.mod.${branchName}.patchName`;
      const configuredPatchName = await execGit(
        ["config", "--get", configKey],
        "Failed to get patch name from git config"
      );

      if (configuredPatchName && configuredPatchName.trim()) {
        return configuredPatchName.trim();
      }
    } catch (error) {
      // Git config not set, continue to convention-based approach
    }

    // Check for legacy naming conventions
    if (branchName.startsWith(GIT.BRANCH_PREFIX)) {
      return branchName.replace(GIT.BRANCH_PREFIX, "");
    }

    // Fallback to using the branch name itself
    return branchName;
  } catch (error) {
    console.warn(
      `Warning: Failed to determine patch name from branch: ${error.message}`
    );
    // Return branch name as fallback
    return branchName;
  }
}

/**
 * Determines if a branch name is a base/protected branch
 *
 * @param {string} branchName - Name of the branch to check
 * @returns {Promise<boolean>} - True if this is a base/protected branch
 */
async function isBaseBranch(branchName) {
  const baseBranch = await getBaseBranch();
  
  return (
    branchName === baseBranch ||
    GIT.COMMON_BASE_BRANCHES.includes(branchName)
  );
}

/**
 * Check if a patch name is namespaced (contains a forward slash)
 * @param {string} patchName - Name of the patch to check
 * @returns {boolean} - Whether the patch name is namespaced
 */
function isNamespacedPatch(patchName) {
  return patchName.includes('/');
}

/**
 * Parse a fully qualified patch name into components
 * @param {string} fullPatchName - Full patch name potentially with namespace
 * @returns {Promise<Object>} - Object with repo and patchName properties
 */
async function parsePatchName(fullPatchName) {
  // Check if it's a namespaced patch
  if (isNamespacedPatch(fullPatchName)) {
    const parts = fullPatchName.split('/');
    const repoName = parts[0];
    const patchName = parts.slice(1).join('/');
    
    return { repoName, patchName };
  }
  
  return { repoName: null, patchName: fullPatchName };
}

/**
 * Get the preferred repository for a patch
 * @param {string} patchName - Name of the patch
 * @param {boolean} interactive - Whether to allow interactive selection
 * @returns {Promise<string>} - The repository name to use
 */
async function getRepositoryForPatch(patchName, interactive = true) {
  try {
    // First try to get repository from git config
    try {
      const configKey = `hyperfy.mod.${patchName}.repository`;
      const configuredRepo = await execGit(
        ["config", "--get", configKey],
        "Failed to get repository from git config"
      );

      if (configuredRepo && configuredRepo.trim()) {
        // Verify the repository exists
        const repositories = await getRegisteredRepositories();
        if (repositories.some((repo) => repo.name === configuredRepo.trim())) {
          return configuredRepo.trim();
        }
      }
    } catch (error) {
      // Git config not set, continue to default
    }

    if (interactive) {
      // This would be implemented in cli.js as it requires user interaction
      return null;
    }
  } catch (error) {
    console.warn(`Warning: Failed to determine repository: ${error.message}`);
  }
  
  return null;
}

module.exports = {
  getTagCompatibleName,
  getAppliedPatches,
  getCommitMessage,
  parseEnhancedCommitMessage,
  generateEnhancedCommitMessage,
  getPatchBranchName,
  isPatchApplied,
  findPatchCommit,
  getAvailableVersions,
  getNextPatchVersion,
  getPatchNameForBranch,
  isBaseBranch,
  isNamespacedPatch,
  parsePatchName,
  getRepositoryForPatch
}; 