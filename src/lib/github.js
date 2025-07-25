const https = require('https');
const { URL } = require('url');
const { Cache } = require('./cache');

class GitHubAPI {
  constructor() {
    this.baseURL = 'https://api.github.com';
    this.rateLimitRemaining = 60;
    this.rateLimitReset = null;
    this.userAgent = 'hypkg-mod-manager/1.0';
    this.cache = new Cache();
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
   * @param {object} options - Options (refresh, filterByModBranches, etc.)
   * @returns {Promise<Array>} - Array of fork objects
   */
  async getForks(owner, repo, options = {}) {
    const cacheKey = `forks-${owner}-${repo}`;
    
    // Check cache unless refresh is requested
    if (!options.refresh) {
      const cached = await this.cache.getRepositories();
      if (cached && cached[cacheKey]) {
        return cached[cacheKey];
      }
    }

    const params = {
      sort: options.sort || 'newest',
      per_page: options.perPage || 50,
      page: options.page || 1
    };

    try {
      const forks = await this.request(`/repos/${owner}/${repo}/forks`, { params });
      
      // Filter by mod branches by default (unless explicitly disabled)
      if (options.filterByModBranches !== false) {
        const validForks = [];
        
        for (const fork of forks) {
          const branchInfo = await this.hasValidModBranches(fork.owner.login, fork.name);
          
          if (branchInfo.hasModBranches) {
            // Attach mod branch information to the fork object
            fork._modBranches = branchInfo;
            validForks.push(fork);
          }
          
          // Rate limiting delay to be respectful to GitHub API
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Cache the filtered results
        const cached = await this.cache.getRepositories() || {};
        cached[cacheKey] = validForks;
        await this.cache.saveRepositories(cached);
        
        return validForks;
      }
      
      // Cache unfiltered results
      const cached = await this.cache.getRepositories() || {};
      cached[cacheKey] = forks || [];
      await this.cache.saveRepositories(cached);
      
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
   * Check if repository has valid mod branches (cow_ prefix)
   * Filters out versioned duplicates (e.g., cow_mod-name_v1.0.0)
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<{hasModBranches: boolean, modBranchCount: number, modBranches: string[], uniqueMods: string[]}>}
   */
  async hasValidModBranches(owner, repo) {
    try {
      const branches = await this.request(`/repos/${owner}/${repo}/branches`, { 
        params: { per_page: 100 } 
      });
      
      const modBranches = branches.filter(branch => 
        branch.name.startsWith('cow_')
      );
      
      // Extract unique mod names (remove version suffixes)
      const uniqueMods = new Set();
      const allModBranches = modBranches.map(b => b.name);
      
      for (const branch of allModBranches) {
        // Remove cow_ prefix
        let modName = branch.replace('cow_', '');
        
        // Remove various version suffix patterns
        // Standard semantic versioning: _v1.0.0, _version_1.0.0, etc.
        modName = modName.replace(/_v\d+\.\d+\.\d+[\w\-\.]*$/, '');
        modName = modName.replace(/_version_\d+\.\d+\.\d+[\w\-\.]*$/, '');
        modName = modName.replace(/_\d+\.\d+\.\d+[\w\-\.]*$/, '');
        
        // Alternative version patterns: _v1.0, _v1, etc.
        modName = modName.replace(/_v\d+\.\d+[\w\-\.]*$/, '');
        modName = modName.replace(/_v\d+[\w\-\.]*$/, '');
        
        // Date-based versions: _20231201, _2023-12-01, etc.
        modName = modName.replace(/_\d{8}$/, '');
        modName = modName.replace(/_\d{4}-\d{2}-\d{2}$/, '');
        
        // Backup/repo branch patterns: _repo_name_v1.0.0, _backup_v1.0.0
        modName = modName.replace(/_[^_]+_v\d+\.\d+\.\d+[\w\-\.]*$/, '');
        modName = modName.replace(/_backup_.*$/, '');
        modName = modName.replace(/_old_.*$/, '');
        
        // Hash suffixes: _abc123def, _git_hash
        modName = modName.replace(/_[a-f0-9]{6,}$/, '');
        
        // Final cleanup: remove trailing underscores and ensure valid mod name
        modName = modName.replace(/_+$/, '');
        
        if (modName && modName.length > 0 && !modName.startsWith('_')) {
          uniqueMods.add(modName);
        }
      }
      
      const uniqueModArray = Array.from(uniqueMods);
      
      return {
        hasModBranches: uniqueModArray.length > 0,
        modBranchCount: uniqueModArray.length, // Count unique mods, not total branches
        modBranches: allModBranches,
        uniqueMods: uniqueModArray
      };
    } catch (error) {
      // If we can't get branches, return no mods found
      return { 
        hasModBranches: false, 
        modBranchCount: 0, 
        modBranches: [],
        uniqueMods: []
      };
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

  /**
   * Get cache status information
   * @returns {Promise<object>} - Cache status info
   */
  async getCacheStatus() {
    const cacheAge = await this.cache.getCacheAge();
    const hasCache = cacheAge >= 0;
    
    return {
      hasCache,
      ageMinutes: cacheAge,
      ageFormatted: hasCache ? `${Math.floor(cacheAge / 60)}h ${cacheAge % 60}m ago` : 'No cache',
      isExpired: hasCache && cacheAge > (24 * 60) // 24 hours in minutes
    };
  }

  /**
   * Clear all cached data
   * @returns {Promise<void>}
   */
  async clearCache() {
    await this.cache.clearCache();
  }
}

module.exports = { GitHubAPI };