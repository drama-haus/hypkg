const ora = require("ora");
const git = require("../src/lib/git");
const utils = require("../src/utils");
const { log } = require("./log");

// Extract version from commit message if it exists
function extractVersionFromMessage(message) {
  const versionMatch = message.match(/v(\d+\.\d+\.\d+)/);
  if (versionMatch) {
    return versionMatch[1];
  }
  return null;
}

/**
 * Applies a patch from a specific repository with mandatory namespacing
 * @param {string} patchName - Name of the patch
 * @param {string} remoteName - Name of the remote
 * @returns {Promise<void>}
 */

async function applyPatchFromRepo(patchName, remoteName) {
  const spinner = ora(`Applying mod: ${patchName} from ${remoteName}`).start();
  const appliedPatches = await utils.getAppliedPatches();

  // Clean up the patch name (remove cow_ prefix if present)
  const cleanPatchName = patchName.replace(/^cow_/, "");

  // Always namespace the patch with the remote name
  const namespacedPatchName = `${remoteName}/${cleanPatchName}`;

  // Check if patch is already applied (considering namespace)
  if (
    appliedPatches.some((p) => {
      const name = typeof p === "string" ? p : p.name;
      return name === namespacedPatchName;
    })
  ) {
    spinner.info(`Patch ${namespacedPatchName} is already applied`);
    return;
  }

  const initialState = await utils.saveGitState();

  try {
    spinner.text = "Finding mod commit...";

    // Format the branch name correctly for this remote
    const remoteBranchName = `cow_${cleanPatchName}`;

    // Get the original commit hash and message from the remote branch
    const originalCommitHash = await utils.execGit(
      ["rev-parse", `${remoteName}/${remoteBranchName}`],
      `Failed to find commit hash for mod ${cleanPatchName} from ${remoteName}`
    );

    const commitMessage = await utils.execGit(
      ["log", "-1", "--format=%B", originalCommitHash],
      `Failed to get commit message for mod ${cleanPatchName} from ${remoteName}`
    );

    // Get current base branch hash
    const baseBranch = await utils.getBaseBranch();
    const baseRemote = await git.getBaseRemote();
    const currentBaseBranchHash = await utils.execGit(
      ["rev-parse", `${baseRemote}/${baseBranch}`],
      "Failed to get current base branch commit hash"
    );

    // Try to extract mod base branch hash from the original commit message
    let modBaseBranchHash = null;
    const parsedMessage = git.parseEnhancedCommitMessage(commitMessage);

    if (
      parsedMessage &&
      parsedMessage.currentBaseBranchHash &&
      parsedMessage.currentBaseBranchHash !== "unknown"
    ) {
      // If the original commit has metadata, use its current-base as our mod-base
      modBaseBranchHash = parsedMessage.currentBaseBranchHash;
    } else if (
      parsedMessage &&
      parsedMessage.modBaseBranchHash &&
      parsedMessage.modBaseBranchHash !== "unknown"
    ) {
      // Or use mod-base if available
      modBaseBranchHash = parsedMessage.modBaseBranchHash;
    } else {
      // For patches without enhanced metadata, we'll use the commit's parent
      try {
        // Try to find the parent commit that the mod was based on
        const parentHash = await utils.execGit(
          ["rev-list", "--parents", "-n", "1", originalCommitHash],
          "Failed to get parent commit"
        );

        // The format is: <commit> <parent1> <parent2> ...
        const parents = parentHash.split(" ");
        if (parents.length > 1) {
          // Use the first parent as the base hash
          modBaseBranchHash = parents[1];
        } else {
          // Fallback to current base branch hash if we can't determine
          modBaseBranchHash = currentBaseBranchHash;
        }
      } catch (e) {
        // If all else fails, use current base branch hash
        modBaseBranchHash = currentBaseBranchHash;
      }
    }

    // Get the version if it's in the commit message
    const version = extractVersionFromMessage(commitMessage);

    const commit = await utils.execGit(
      ["rev-list", "-n", "1", `${remoteName}/${remoteBranchName}`, "^HEAD"],
      `Failed to find commit for mod ${cleanPatchName} from ${remoteName}`
    );

    if (!commit) {
      spinner.fail(
        `No unique commits found in ${cleanPatchName} from ${remoteName}`
      );
      throw new Error(
        `No unique commits found in ${cleanPatchName} from ${remoteName}`
      );
    }

    try {
      spinner.text = "Applying mod changes...";
      await utils.execGit(
        ["cherry-pick", commit],
        "Failed to cherry-pick commit"
      );

      // Generate enhanced commit message with metadata
      const enhancedCommitMessage = await git.generateEnhancedCommitMessage(
        namespacedPatchName,
        version,
        originalCommitHash,
        modBaseBranchHash,
        currentBaseBranchHash
      );

      // Update commit message with enhanced metadata
      await utils.execGit(
        ["commit", "--amend", "-m", enhancedCommitMessage],
        "Failed to update commit message"
      );

      spinner.succeed(`Successfully applied mod: ${namespacedPatchName}`);
    } catch (cherryPickError) {
      spinner.warn("Cherry-pick failed, attempting alternative approach...");

      await utils.execGit(
        ["cherry-pick", "--abort"],
        "Failed to abort cherry-pick"
      );

      try {
        await utils.execGit(
          ["cherry-pick", "-n", commit],
          "Failed to cherry-pick commit"
        );
      } catch (noCommitError) {
        // This is expected - cherry-pick -n will still show conflicts
      }

      spinner.text = "Handling package dependencies...";
      const handledLockConflict = await utils.handlePackageChanges(commit);

      if (!handledLockConflict) {
        const hasOtherConflicts = await utils.execGit(
          ["diff", "--name-only", "--diff-filter=U"],
          "Failed to check conflicts"
        );

        if (hasOtherConflicts) {
          spinner.fail("Merge conflicts detected");
          throw new Error(
            "Merge conflicts detected in files other than package-lock.json"
          );
        }
      }

      spinner.text = "Committing changes...";
      await utils.execGit(["add", "."], "Failed to stage changes");

      // Generate enhanced commit message with metadata
      const enhancedCommitMessage = await git.generateEnhancedCommitMessage(
        namespacedPatchName,
        version,
        originalCommitHash,
        modBaseBranchHash,
        currentBaseBranchHash
      );

      await utils.execGit(
        ["commit", "-m", enhancedCommitMessage],
        "Failed to commit changes"
      );
    }
  } catch (error) {
    spinner.fail(`Failed to apply mod: ${error.message}`);
    log("Rolling back to initial state...", "warning");
    await utils.restoreGitState(initialState);
    throw error;
  }
}
exports.applyPatchFromRepo = applyPatchFromRepo;
