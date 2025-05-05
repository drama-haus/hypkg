/**
 * E2E tests for the Git utility functions
 * 
 * These tests directly exercise the Git utility functions that were migrated
 * from utils.js to the src/lib/git modules during Phase 1 of the CLI migration.
 * 
 * They ensure that:
 *  - Base branch detection works
 *  - Branch synchronization functions correctly
 *  - Patch name parsing and branch naming follows conventions
 *  - Package dependency management works properly
 * 
 * Important notes:
 *  - Avoid using 'package' as a variable name (it's a reserved word)
 *  - Be careful with name conflicts between functions and local variables
 */
const { dir: getTempDir } = require('tmp-promise');
const execa = require('execa');
const path = require('path');
const fs = require('fs').promises;

// Import git utilities directly for testing
const git = require('../../src/lib/git');

describe('Git Utility Functions', () => {
  let tempDir;
  let originalCwd;
  const HYPERFY_REPO = 'https://github.com/hyperfy-xyz/hyperfy';

  beforeAll(async () => {
    // Store original working directory
    originalCwd = process.cwd();
  });

  beforeEach(async () => {
    // Create temporary directory for test
    tempDir = await getTempDir({ unsafeCleanup: true });
    // Change to temp directory
    process.chdir(tempDir.path);
    
    // Clone Hyperfy repository
    console.log('Cloning Hyperfy repository...');
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

  test('should determine base branch correctly', async () => {
    const baseBranch = await git.getBaseBranch();
    expect(baseBranch).toBe('dev');
  });

  test('should identify if current branch is a base branch', async () => {
    // First check non-base branch
    let isBase = await git.isOnBaseBranch();
    expect(isBase).toBe(false);
    
    // Switch to base branch and check again
    await execa('git', ['checkout', 'dev']);
    isBase = await git.isOnBaseBranch();
    expect(isBase).toBe(true);
  });

  test('should sync branches with remote', async () => {
    // Set up remote as origin to make test consistent
    const syncedBranch = await git.syncBranches('origin');
    expect(syncedBranch).toBe('dev');
    
    // Verify we're on the correct branch
    const currentBranch = await git.getCurrentBranch();
    expect(currentBranch).toBe('dev');
  });

  test('should parse namespaced patch names correctly', async () => {
    // Test non-namespaced patch
    let result = await git.parsePatchName('simple-patch');
    expect(result.repoName).toBeNull();
    expect(result.patchName).toBe('simple-patch');
    
    // Test namespaced patch
    result = await git.parsePatchName('drama-haus/ai');
    expect(result.repoName).toBe('drama-haus');
    expect(result.patchName).toBe('ai');
    
    // Test deeper nesting
    result = await git.parsePatchName('drama-haus/ai/v2');
    expect(result.repoName).toBe('drama-haus');
    expect(result.patchName).toBe('ai/v2');
  });

  test('should get patch name for branch', async () => {
    // Test branch with standard name
    let patchName = await git.getPatchNameForBranch('feature-branch');
    expect(patchName).toBe('feature-branch');
    
    // Test branch with cow_ prefix
    patchName = await git.getPatchNameForBranch('cow_cool-feature');
    expect(patchName).toBe('cool-feature');
  });

  test('should create and ensure patch branch', async () => {
    const patchBranchName = 'cow_test-patch';
    
    // Check if branch exists first
    const exists = await git.branchExists(patchBranchName);
    if (exists) {
      await execa('git', ['branch', '-D', patchBranchName]);
    }
    
    // Test creating a new patch branch
    await git.ensurePatchBranch(patchBranchName, null);
    let currentBranch = await git.getCurrentBranch();
    expect(currentBranch).toBe(patchBranchName);
    
    // Test switching back to existing patch branch
    await execa('git', ['checkout', 'test-feature']);
    await git.ensurePatchBranch(patchBranchName, null);
    currentBranch = await git.getCurrentBranch();
    expect(currentBranch).toBe(patchBranchName);
  });

  test('should handle package changes', async () => {
    // Create a simple package.json
    await fs.writeFile('package.json', JSON.stringify({
      name: "test-package",
      version: "1.0.0"
    }));
    
    // Test handling package changes when no lock file exists
    const result = await git.handlePackageChanges();
    expect(result).toBe(false);
    
    // Verify package-lock.json was created
    const lockExists = await fs.access('package-lock.json')
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  });
}); 