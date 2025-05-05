const utils = require("../src/utils");

/**
 * Get information about a patch
 * @param {string} branchName - Name of the patch
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<{author: string, relativeTime: string}>} Patch info
 */

async function getPatchInfo(branchName, remoteName) {
  const fullBranchName = `${remoteName}/cow_${branchName}`;
  try {
    const commitInfo = await utils.execGit(
      ["log", "-1", "--format=%an|%at", fullBranchName],
      `Failed to get commit info for ${branchName} from ${remoteName}`
    );

    const [author, timestamp] = commitInfo.split("|");
    const relativeTime = utils.getRelativeTime(parseInt(timestamp) * 1000);

    return {
      author,
      relativeTime,
    };
  } catch (error) {
    console.warn(
      `Warning: Could not get info for ${branchName} from ${remoteName}: ${error.message}`
    );
    return {
      author: "Unknown",
      relativeTime: "Unknown",
    };
  }
}
exports.getPatchInfo = getPatchInfo;
