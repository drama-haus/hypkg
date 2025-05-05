const { dir: getTempDir } = require('tmp-promise');
const execa = require('execa');
const path = require('path');
const fs = require('fs').promises;

describe('Mod Application and Removal Flow', () => {
  let tempDir;
  let originalCwd;
  let hypkgBin;
  const HYPERFY_REPO = 'https://github.com/hyperfy-xyz/hyperfy';

  // Helper function to find files
  const findFile = async (dir, filename) => {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        try {
          return await findFile(fullPath, filename);
        } catch (e) {
          // Continue searching if not found in this directory
        }
      } else if (file.name === filename) {
        return fullPath;
      } 
    }
    throw new Error(`File ${filename} not found`);
  };

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();
    // Get path to hypkg binary
    hypkgBin = path.join(originalCwd, 'bin', 'cli.js');
  });

  beforeEach(async () => {
    // Create temporary directory for test
    tempDir = await getTempDir({ unsafeCleanup: true });
    // Change to temp directory
    process.chdir(tempDir.path);
    
    // Clone Hyperfy repository
    const spinner = console.log('Cloning Hyperfy repository...');
    await execa('git', ['clone', HYPERFY_REPO, '.']);
    await execa('git', ['checkout', 'dev']);
    
    // Create a feature branch for testing
    await execa('git', ['checkout', '-b', 'test-feature']);
  });

  afterEach(async () => {
    // Clean up temp directory
    await tempDir.cleanup();
    // Restore original working directory
    process.chdir(originalCwd);
  });

  test('should apply and remove a mod successfully', async () => {
    // Create a test mod repository
    const modRepoDir = await getTempDir({ unsafeCleanup: true });
    // await execa('git', ['init'], { cwd: modRepoDir.path });
    
    // Apply the mod
    const applyResult = await execa(hypkgBin, ['apply', 'drama-haus/ai']);
    console.log(applyResult.stdout);
    expect(applyResult.exitCode).toBe(0);
    
    // Verify mod was applied
    const listResult = await execa(hypkgBin, ['list']);
    console.log(listResult.stdout);
    expect(listResult.stdout).toContain('drama-haus/ai');
    
    await expect(findFile('src/core/systems', 'AIClient.js')).resolves.toBeTruthy();
    await expect(findFile('src/core/systems', 'AIServer.js')).resolves.toBeTruthy();
    
    // Remove the mod
    const removeResult = await execa(hypkgBin, ['remove', 'drama-haus/ai']);
    expect(removeResult.exitCode).toBe(0);
    
    // Verify mod was removed
    const finalListResult = await execa(hypkgBin, ['list']);
    console.log(finalListResult.stdout);
    expect(finalListResult.stdout).not.toContain('drama-haus/ai');

    await expect(findFile('src/core/systems', 'AIServer.js')).rejects.toThrow();
    await expect(findFile('src/core/systems', 'AIClient.js')).rejects.toThrow();
    
    // Clean up mod repo
    await modRepoDir.cleanup();
  }, 30000);

  test('should manage repository and release a mod', async () => {
    // Create a test repository for the mod release
    const testRepoDir = await getTempDir({ unsafeCleanup: true });
    await execa('git', ['init'], { cwd: testRepoDir.path });
    
    // Add test repository to hypkg
    const addRepoResult = await execa(hypkgBin, ['repository', 'add', 'peezy', "https://github.com/peezy/hyperfy"]);
    expect(addRepoResult.exitCode).toBe(0);
    
    // Verify repository was added
    const repoListResult = await execa(hypkgBin, ['repository', 'list']);
    expect(repoListResult.stdout).toContain('peezy');
    
    // Copy the test mods folder to the src/mods directory
    const srcModsDir = path.join(tempDir.path, 'src', 'mods');
    const testModsDir = path.join(originalCwd, 'tests', 'mods');
    
    // Ensure the mods directory exists
    await fs.mkdir(srcModsDir, { recursive: true });
    
    // Recursive function to copy directory contents
    const copyDir = async (src, dest) => {
      const entries = await fs.readdir(src, { withFileTypes: true });
      
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
          await fs.mkdir(destPath, { recursive: true });
          await copyDir(srcPath, destPath);
        } else {
          await fs.copyFile(srcPath, destPath);
        }
      }
    };
    
    // Copy the test mods to the src/mods directory
    await copyDir(testModsDir, srcModsDir);
    
    // Commit the changes
    await execa('git', ['add', path.join('src', 'mods')]);
    await execa('git', ['commit', '-m', 'Add test mods for E2E testing']);
    
    // Run the release command
    const releaseResult = await execa(hypkgBin, ['release', '--repository', 'peezy']);
    expect(releaseResult.exitCode).toBe(0);
    
    // Verify release was created by searching for it
    const searchResult = await execa(hypkgBin, ['search']);
    expect(searchResult.stdout).toContain('test-feature');

    const branches = await execa('git', ['branch']);
    console.log(branches.stdout);

    // // remove branch and tag from local and remote
    // await execa('git', ['branch', '-D', '`cow_test-feature`']);
    // await execa('git', ['tag', '-d', 'peezy-test-feature-v1.0.0']);
    await execa('git', ['push', 'peezy', '--delete', 'cow_test-feature']);
    await execa('git', ['push', 'peezy', '--delete', 'peezy-test-feature-v1.0.0']);
    
    // Clean up
    await testRepoDir.cleanup();
  }, 60000); // Longer timeout for release process
}); 