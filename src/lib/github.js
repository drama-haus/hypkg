const https = require('https');
const { URL } = require('url');

class GitHubAPI {
  constructor() {
    this.baseURL = 'https://api.github.com';
    this.rateLimitRemaining = 60;
    this.rateLimitReset = null;
    this.userAgent = 'hypkg-mod-manager/1.0';
  }

  /**
   * Make a request to the GitHub API
   * @param {string} endpoint - API endpoint (e.g., '/repos/owner/repo')
   * @param {object} options - Request options
   * @returns {Promise<object>} - API response
   */
  async request(endpoint, options = {}) {
    const url = new URL(endpoint, this.baseURL);
    
    // Add query parameters
    if (options.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, value);
        }
      });
    }

    const requestOptions = {
      method: options.method || 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'application/vnd.github.v3+json',
        ...options.headers
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, requestOptions, (res) => {
        let data = '';

        // Update rate limit info from headers
        this.rateLimitRemaining = parseInt(res.headers['x-ratelimit-remaining']) || 0;
        this.rateLimitReset = parseInt(res.headers['x-ratelimit-reset']) || null;

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const error = new Error(parsed.message || `HTTP ${res.statusCode}`);
              error.status = res.statusCode;
              error.response = parsed;
              reject(error);
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse JSON response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }

      req.end();
    });
  }

  /**
   * Check if we're approaching rate limits
   * @returns {boolean} - True if we should be cautious about requests
   */
  isRateLimited() {
    return this.rateLimitRemaining < 10;
  }

  /**
   * Get time until rate limit resets
   * @returns {number} - Minutes until reset
   */
  getRateLimitResetTime() {
    if (!this.rateLimitReset) return 0;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, Math.ceil((this.rateLimitReset - now) / 60));
  }

  /**
   * Search repositories on GitHub
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @returns {Promise<Array>} - Array of repository objects
   */
  async searchRepositories(query, options = {}) {
    const params = {
      q: query,
      sort: options.sort || 'updated',
      order: options.order || 'desc',
      per_page: options.perPage || 30,
      page: options.page || 1
    };

    try {
      const response = await this.request('/search/repositories', { params });
      return {
        repositories: response.items || [],
        totalCount: response.total_count || 0,
        hasMore: response.items && response.items.length === params.per_page
      };
    } catch (error) {
      if (error.status === 403 && error.response?.message?.includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded. Try again in ${this.getRateLimitResetTime()} minutes.`);
      }
      throw error;
    }
  }

  /**
   * Get forks of a repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {object} options - Options
   * @returns {Promise<Array>} - Array of fork objects
   */
  async getForks(owner, repo, options = {}) {
    const params = {
      sort: options.sort || 'newest',
      per_page: options.perPage || 50,
      page: options.page || 1
    };

    try {
      const forks = await this.request(`/repos/${owner}/${repo}/forks`, { params });
      return forks || [];
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found`);
      }
      if (error.status === 403 && error.response?.message?.includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded. Try again in ${this.getRateLimitResetTime()} minutes.`);
      }
      throw error;
    }
  }

  /**
   * Get branch count for a repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<number>} - Number of branches
   */
  async getBranchCount(owner, repo) {
    try {
      const branches = await this.request(`/repos/${owner}/${repo}/branches`, { 
        params: { per_page: 100 } 
      });
      return branches.length;
    } catch (error) {
      // If we can't get branches, return 0 to avoid breaking the display
      return 0;
    }
  }

  /**
   * Get repository information
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<object>} - Repository object
   */
  async getRepository(owner, repo) {
    try {
      return await this.request(`/repos/${owner}/${repo}`);
    } catch (error) {
      if (error.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found`);
      }
      if (error.status === 403 && error.response?.message?.includes('rate limit')) {
        throw new Error(`GitHub API rate limit exceeded. Try again in ${this.getRateLimitResetTime()} minutes.`);
      }
      throw error;
    }
  }

  /**
   * Get multiple repositories information
   * @param {Array<{owner: string, repo: string}>} repositories - Array of repo identifiers
   * @returns {Promise<Array>} - Array of repository objects
   */
  async getRepositories(repositories) {
    const results = [];
    
    for (const { owner, repo } of repositories) {
      try {
        const repoInfo = await this.getRepository(owner, repo);
        results.push(repoInfo);
        
        // Add small delay to be respectful to API
        if (repositories.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        // Continue with other repositories if one fails
        console.warn(`Failed to fetch ${owner}/${repo}: ${error.message}`);
        results.push({
          owner: { login: owner },
          name: repo,
          full_name: `${owner}/${repo}`,
          error: error.message
        });
      }
    }
    
    return results;
  }

  /**
   * Format repository for display
   * @param {object} repo - Repository object from API
   * @returns {object} - Formatted repository info
   */
  formatRepository(repo) {
    return {
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description || 'No description',
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      language: repo.language || 'Unknown',
      updatedAt: repo.updated_at,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch || 'main',
      isPrivate: repo.private || false,
      topics: repo.topics || []
    };
  }

  /**
   * Format relative time for display
   * @param {string} dateString - ISO date string
   * @returns {string} - Human readable relative time
   */
  formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
    if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
    return `${Math.floor(diffInSeconds / 31536000)} years ago`;
  }
}

module.exports = { GitHubAPI };