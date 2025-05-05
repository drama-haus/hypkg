const { GIT } = require("../src/lib/constants");
const git = require("../src/lib/git");

/**
 * Get all applied patches with enhanced metadata from commit messages
 * @returns {Promise<Array>} Array of applied patches with metadata
 */


async function getAppliedPatches() {
  const baseBranch = await git.getBaseBranch();
  const currentBranch = await git.getCurrentBranch();

  // Get all commits between base branch and current branch with full commit messages
  const output = await git.execGit(
    [
      "log",
      `${baseBranch}..${currentBranch}`,
      "--pretty=format:%s%n%b%n---COMMIT_SEPARATOR---",
    ],
    "Failed to get commit history"
  );

  // Split by commit separator
  const commitMessages = output.split(GIT.COMMIT_SEPARATOR).filter(Boolean);

  // Extract mod information from commit messages
  const appliedPatches = [];

  for (const commitMessage of commitMessages) {
    // Check if this is a cow commit
    if (commitMessage.trim().startsWith(GIT.COMMIT_PREFIX)) {
      // Parse the enhanced commit message
      const patchInfo = git.parseEnhancedCommitMessage(commitMessage);

      if (patchInfo && patchInfo.name) {
        appliedPatches.push({
          name: patchInfo.name,
          version: patchInfo.version,
          originalCommitHash: patchInfo.originalCommitHash,
          modBaseBranchHash: patchInfo.modBaseBranchHash,
          currentBaseBranchHash: patchInfo.currentBaseBranchHash,
        });
      }
    }
  }

  return appliedPatches.reverse(); // Reverse to get them in application order
}
exports.getAppliedPatches = getAppliedPatches;
