const git = require("../src/lib/git");

/**
 * Fetch verified repositories from GitHub
 * @returns {Promise<Array<{url: string, name: string, owner: string}>>}
 */

async function fetchVerifiedRepositories() {
  return [
    {
      "name": "drama-haus",
      "url": "https://github.com/drama-haus/hyperfy"
    }
  ]
}
exports.fetchVerifiedRepositories = fetchVerifiedRepositories;

/**
 * Check if a repository is verified
 * @param {string} repoName - Name of the repository
 * @returns {Promise<boolean>} - Whether the repository is verified
 */

async function isVerifiedRepository(repoName) {
  const verifiedRepos = await fetchVerifiedRepositories();
  const repositories = await git.getRegisteredRepositories();
  const repo = repositories.find((r) => r.name === repoName);

  if (!repo) return false;

  return verifiedRepos.some((vr) => vr.url === repo.url);
}
exports.isVerifiedRepository = isVerifiedRepository;
