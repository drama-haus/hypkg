const git = require("../src/lib/git");
const utils = require("../src/utils");
const { fetchVerifiedRepositories } = require("./fetchVerifiedRepositories");


/**
 * Search for patches across all registered repositories
 * @param {string} searchTerm - Optional search term to filter patches
 * @returns {Promise<Array<{name: string, remote: string}>>} Array of patch objects with remote info
 */

async function searchPatches(searchTerm = "") {
  // Get all registered repositories
  const repositories = await git.getRegisteredRepositories();
  const verifiedRepos = await fetchVerifiedRepositories();
  const verifiedRepoMap = new Map(verifiedRepos.map((r) => [r.url, r]));

  const results = [];

  for (const repo of repositories) {
    try {
      // Update the remote
      await utils.execGit(["remote", "update", repo.name, "--prune"]);

      // Get branches from this remote
      const branches = await utils.execGit(
        ["branch", "-a"],
        `Failed to list branches from ${repo.name}`
      );

      // Filter remote branches that follow the patch pattern (cow_*)
      // MODIFIED: Updated to exclude our new backup branch format (cow_repoName_patchName_v*)
      const remoteBranches = branches
        .split("\n")
        .map((b) => b.trim())
        .filter(
          (b) => b.startsWith(`remotes/${repo.name}/cow_`) &&
            !b.includes("backup") &&
            // Exclude our new backup branch format
            !b.match(/remotes\/.*\/cow_.*_.*_v\d/)
        )
        .map((b) => b.replace(`remotes/${repo.name}/`, ""))
        .map((b) => b.replace(`cow_`, "")); // Remove package prefix


      // Add to results with remote info
      remoteBranches.forEach((branch) => {
        if (!searchTerm || branch.includes(searchTerm)) {
          const isVerified = verifiedRepoMap.has(repo.url);
          results.push({
            name: branch,
            remote: repo.name,
            isVerified,
          });
        }
      });
    } catch (error) {
      console.warn(
        `Warning: Failed to search in repository ${repo.name}: ${error.message}`
      );
    }
  }

  return results;
}
exports.searchPatches = searchPatches;
