/**
 * Package management utilities
 * Functions for handling package.json and dependencies
 */
const execa = require('execa');
const fs = require('fs').promises;
const { execGit } = require('./commands');

/**
 * Handle package.json and package-lock.json conflicts and updates
 * @param {string} [commit] - Original commit hash being cherry-picked (optional)
 * @returns {Promise<boolean>} - Whether the package-lock.json was regenerated
 */
async function handlePackageChanges(commit) {
  try {
    // Check for conflicts in package files
    const conflictedFiles = await execGit(
      ['diff', '--name-only', '--diff-filter=U'],
      'Failed to check conflicts'
    ).then((output) => output.split('\n').filter(Boolean));
    
    const hasPackageJsonConflict = conflictedFiles.includes('package.json');
    const hasLockConflict = conflictedFiles.includes('package-lock.json');
    const hasEnvExampleConflict = conflictedFiles.includes('.env.example');
    
    if (!hasPackageJsonConflict && !hasLockConflict && !hasEnvExampleConflict) {
      return false; // No relevant conflicts to handle
    }
    
    // Handle package.json conflicts if present
    if (hasPackageJsonConflict) {
      // Get the different versions of package.json
      const ourJson = JSON.parse(await execGit(['show', 'HEAD:package.json'], 'Failed to get our package.json'));
      
      // Try multiple approaches to get "their" version of package.json
      let theirJson;
      try {
        // First try CHERRY_PICK_HEAD
        theirJson = JSON.parse(await execGit(['show', 'CHERRY_PICK_HEAD:package.json'], 'Checking CHERRY_PICK_HEAD'));
      } catch (e1) {
        try {
          // Then try MERGE_HEAD
          theirJson = JSON.parse(await execGit(['show', 'MERGE_HEAD:package.json'], 'Checking MERGE_HEAD'));
        } catch (e2) {
          // Finally use the original commit if provided
          if (commit) {
            theirJson = JSON.parse(await execGit(['show', `${commit}:package.json`], 'Using original commit hash'));
          } else {
            throw new Error('Could not find "their" version of package.json');
          }
        }
      }
      
      // Get common ancestor - try multiple approaches
      let baseCommit;
      try {
        // First try with CHERRY_PICK_HEAD
        baseCommit = await execGit(['merge-base', 'HEAD', 'CHERRY_PICK_HEAD'], 'Checking merge base with CHERRY_PICK_HEAD');
      } catch (e1) {
        try {
          // Then try with MERGE_HEAD
          baseCommit = await execGit(['merge-base', 'HEAD', 'MERGE_HEAD'], 'Checking merge base with MERGE_HEAD');
        } catch (e2) {
          // If we have the commit hash, use it
          if (commit) {
            // Get the first parent of the commit as the base
            try {
              const parentInfo = await execGit(['rev-list', '--parents', '-n', '1', commit], 'Getting parent of commit');
              const parents = parentInfo.split(' ');
              if (parents.length > 1) {
                baseCommit = parents[1]; // Use first parent
              } else {
                throw new Error('Could not determine base commit');
              }
            } catch (e3) {
              throw new Error('Could not determine base commit');
            }
          } else {
            throw new Error('Could not determine base commit');
          }
        }
      }
      
      // Get the base JSON
      const baseJson = JSON.parse(await execGit(['show', `${baseCommit.trim()}:package.json`], 'Failed to get base package.json'));
      
      // Create the merged JSON
      const mergedJson = mergePackageJson(baseJson, ourJson, theirJson);
      
      // Write the merged JSON back to the file
      await fs.writeFile('package.json', JSON.stringify(mergedJson, null, 2) + '\n');
      
      await execGit(['add', 'package.json'], 'Failed to stage resolved package.json');
    }
    
    // Handle package-lock.json conflicts
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
      
      await execGit(['add', 'package-lock.json'], 'Failed to stage regenerated package-lock.json');
    }
    
    // Handle .env.example conflicts
    if (hasEnvExampleConflict) {
      await resolveEnvExampleConflict();
      await execGit(['add', '.env.example'], 'Failed to stage resolved .env.example');
    }
    
    return true;
  } catch (error) {
    throw error;
  }
}

// Helper function to merge package.json objects
function mergePackageJson(base, ours, theirs) {
  const merged = { ...base };
  
  // Process all keys from both versions
  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs)
  ]);
  
  for (const key of allKeys) {
    if (key === 'dependencies' || key === 'devDependencies' || key === 'peerDependencies' || key === 'optionalDependencies') {
      // For dependency objects, merge the values
      merged[key] = mergeDependencies(
        base[key] || {},
        ours[key] || {},
        theirs[key] || {}
      );
    } else if (Array.isArray(ours[key]) && Array.isArray(theirs[key])) {
      // For arrays, combine them and deduplicate
      merged[key] = [...new Set([...(ours[key] || []), ...(theirs[key] || [])])];
    } else if (typeof ours[key] === 'object' && typeof theirs[key] === 'object' && 
              !Array.isArray(ours[key]) && !Array.isArray(theirs[key]) &&
              ours[key] !== null && theirs[key] !== null) {
      // Recursively merge nested objects
      merged[key] = {
        ...(base[key] || {}),
        ...ours[key],
        ...theirs[key]
      };
    } else {
      // Prefer "theirs" (the cherry-picked commit) for scalar values
      // but keep "ours" if "theirs" doesn't change from base
      if (theirs[key] !== undefined && JSON.stringify(theirs[key]) !== JSON.stringify(base[key])) {
        merged[key] = theirs[key];
      } else if (ours[key] !== undefined) {
        merged[key] = ours[key];
      }
    }
  }
  
  return merged;
}

// Helper function to merge dependency objects
function mergeDependencies(base, ours, theirs) {
  const merged = { ...base, ...ours };
  
  // Apply changes from theirs, with conflict resolution
  for (const [pkg, version] of Object.entries(theirs)) {
    // If the package doesn't exist in ours or has the same version as in base,
    // or the version in theirs is newer, prefer theirs
    if (
      !(pkg in ours) || 
      (base[pkg] === ours[pkg] && base[pkg] !== version) ||
      (isNewerVersion(version, ours[pkg]))
    ) {
      merged[pkg] = version;
    }
  }
  
  return merged;
}

// Helper function to check if a version is newer
function isNewerVersion(v1, v2) {
  if (!v1 || !v2) return false;
  
  // Handle special versions
  if (v1.startsWith('^') || v1.startsWith('~')) v1 = v1.substring(1);
  if (v2.startsWith('^') || v2.startsWith('~')) v2 = v2.substring(1);
  
  // If versions have a range or special format, just do string comparison
  if (v1.includes(' ') || v1.includes('-') || v1.includes('||') || 
      v2.includes(' ') || v2.includes('-') || v2.includes('||') || 
      v1.includes('*') || v2.includes('*')) {
    return false; // Can't easily determine, so don't change
  }
  
  // Simple version comparison
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const part1 = v1Parts[i] || 0;
    const part2 = v2Parts[i] || 0;
    
    if (part1 > part2) return true;
    if (part1 < part2) return false;
  }
  
  return false; // Versions are equal
}

// Function to resolve .env.example conflicts - accept both changes
async function resolveEnvExampleConflict() {
  try {
    // Extract the conflicting sections
    const content = await fs.readFile('.env.example', 'utf8');
    
    // Process content to remove conflict markers and keep both sides
    let mergedContent = '';
    let inConflict = false;
    let ourChanges = '';
    let theirChanges = '';
    
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('<<<<<<<')) {
        inConflict = true;
        continue;
      }
      
      if (inConflict && line.startsWith('=======')) {
        // Switch from ours to theirs
        continue;
      }
      
      if (inConflict && line.startsWith('>>>>>>>')) {
        inConflict = false;
        
        // Process and add both changes
        const ourLines = ourChanges.trim().split('\n');
        const theirLines = theirChanges.trim().split('\n');
        
        // Add both sets of changes (deduplicating if needed)
        const mergedLines = [...new Set([...ourLines, ...theirLines])];
        mergedContent += mergedLines.join('\n') + '\n';
        
        // Reset for next conflict
        ourChanges = '';
        theirChanges = '';
        continue;
      }
      
      if (inConflict) {
        // Collect changes from both sides
        if (line.startsWith('=======')) {
          continue;
        } else if (line.startsWith('>>>>>>>')) {
          inConflict = false;
          mergedContent += ourChanges + '\n';
          ourChanges = '';
          continue;
        } else if (theirChanges !== '') {
          theirChanges += line + '\n';
        } else {
          ourChanges += line + '\n';
        }
      } else {
        // Outside of conflict, just add the line
        mergedContent += line + '\n';
      }
    }
    
    // Write the merged content back
    await fs.writeFile('.env.example', mergedContent);
    return true;
  } catch (error) {
    throw new Error(`Error resolving .env.example conflicts: ${error.message}`);
  }
}

module.exports = {
  handlePackageChanges
}; 