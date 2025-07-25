/**
 * Cache management utilities
 */
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class Cache {
  constructor() {
    this.cacheDir = path.join(os.homedir(), '.hypkg');
    this.cacheFile = path.join(this.cacheDir, 'repositories.json');
    this.maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  }

  /**
   * Ensure cache directory exists
   * @returns {Promise<void>}
   */
  async ensureCacheDir() {
    try {
      await fs.access(this.cacheDir);
    } catch (error) {
      await fs.mkdir(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Get cached repository data
   * @returns {Promise<Object|null>} - Cached data or null if not found/expired
   */
  async getRepositories() {
    try {
      await this.ensureCacheDir();
      const data = await fs.readFile(this.cacheFile, 'utf8');
      const cached = JSON.parse(data);
      
      // Check if cache is still valid
      const now = Date.now();
      if (now - cached.timestamp < this.maxAge) {
        return cached.repositories;
      }
      
      // Cache expired
      return null;
    } catch (error) {
      // Cache file doesn't exist or is corrupted
      return null;
    }
  }

  /**
   * Save repository data to cache
   * @param {Array} repositories - Repository data to cache
   * @returns {Promise<void>}
   */
  async saveRepositories(repositories) {
    try {
      await this.ensureCacheDir();
      const cacheData = {
        timestamp: Date.now(),
        repositories: repositories
      };
      await fs.writeFile(this.cacheFile, JSON.stringify(cacheData, null, 2));
    } catch (error) {
      console.warn(`Failed to save cache: ${error.message}`);
    }
  }

  /**
   * Clear the cache
   * @returns {Promise<void>}
   */
  async clearCache() {
    try {
      await fs.unlink(this.cacheFile);
    } catch (error) {
      // Cache file doesn't exist, that's fine
    }
  }

  /**
   * Get cache age in minutes
   * @returns {Promise<number>} - Age in minutes, or -1 if no cache
   */
  async getCacheAge() {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf8');
      const cached = JSON.parse(data);
      const ageMs = Date.now() - cached.timestamp;
      return Math.floor(ageMs / (60 * 1000));
    } catch (error) {
      return -1;
    }
  }
}

module.exports = { Cache };