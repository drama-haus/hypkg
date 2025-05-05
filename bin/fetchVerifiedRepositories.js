const git = require("../src/lib/git");

/**
 * Fetch verified repositories from GitHub
 * @returns {Promise<Array<{url: string, name: string, owner: string}>>}
 */

async function fetchVerifiedRepositories() {
  try {
    // These values would need to be updated with actual GitHub repo details
    const owner = "drama-haus";
    const repo = "hyperfy_core_overwrites";
    const path = "repos.json";

    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,

      { timeout: 5000 }
    );

    if (!response.ok) {
      console.warn(`Failed to fetch verified repositories: ${response.status}`);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.warn(`Error fetching verified repositories: ${error.message}`);
    return [];
  }
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
