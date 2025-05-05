/**
 * Package management utilities
 * Functions for handling package.json and dependencies
 */
const execa = require('execa');
const fs = require('fs').promises;
const { execGit } = require('./commands');

/**
 * Handle package.json and package-lock.json conflicts and updates
 * @returns {Promise<boolean>} - Whether the package-lock.json was regenerated
 */
async function handlePackageChanges() {
  try {
    const hasLockConflict = await execGit(
      ['diff', '--name-only', '--diff-filter=U'],
      'Failed to check conflicts'
    ).then((output) =>
      output.split('\n').some((file) => file === 'package-lock.json')
    );

    if (hasLockConflict) {
      // Delete conflicted package-lock.json
      await fs.unlink('package-lock.json').catch(() => {
        // If file doesn't exist, that's fine
      });

      // Regenerate package-lock.json
      try {
        await execa(
          'npm',
          ['install', '--package-lock-only'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
      } catch (e) {
        throw new Error(`Failed to regenerate package-lock.json: ${e.message}`);
      }

      await execGit(
        ['add', 'package-lock.json'],
        'Failed to stage regenerated package-lock.json'
      );

      return true;
    }

    const packageLockExists = await fs
      .access('package-lock.json')
      .then(() => true)
      .catch(() => false);

    if (!packageLockExists) {
      try {
        await execa('npm', ['install'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        throw new Error(`Failed to install dependencies: ${e.message}`);
      }
    }

    return false;
  } catch (error) {
    throw error;
  }
}

module.exports = {
  handlePackageChanges
}; 