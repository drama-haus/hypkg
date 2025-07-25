# hypkg - Hyperfy Mod Manager

## Project Overview

hypkg is a command-line tool for managing modifications (mods) for the Hyperfy game engine. It allows users to discover, install, remove, and synchronize mods from various repositories while maintaining a clean development workflow. The tool operates as a Git-based patch management system that can apply code changes from remote repositories to local Hyperfy projects.

## Architecture

### Core Concept
- **Patch-based system**: Mods are distributed as Git branches with the `cow_` prefix
- **Repository namespacing**: All patches must be namespaced as `repository/patch_name`
- **Version tagging**: Supports semantic versioning with Git tags
- **Git integration**: Heavy reliance on Git operations for state management

### Key Components
- **CLI Interface**: Commander.js-based command structure with grouped commands
- **Git Wrapper**: Comprehensive Git operations abstraction in `src/lib/git/`
- **Patch Management**: Branch creation, merging, and conflict resolution
- **Repository Management**: Multi-repository support with verification system
- **State Management**: Git state preservation and restoration for safe operations

## Development Setup

### Prerequisites
- Node.js and npm
- Git repository (specifically a Hyperfy project)
- Must be run within a valid Git repository

### Installation
```bash
# Global installation
npm install -g hypkg

# Or run via npx from within a Hyperfy project
npx hypkg
```

### Project Structure
```
hypkg/
├── bin/                    # Core CLI functionality
│   ├── cli.js             # Main CLI entry point
│   ├── wrapper.js         # NPX/local detection wrapper
│   ├── applyPatchFromRepo.js  # Patch application logic
│   ├── searchPatches.js   # Repository searching
│   └── repository.js      # Repository management
├── src/
│   ├── lib/
│   │   ├── git/           # Git operations (modular)
│   │   │   ├── commands.js    # Core Git commands
│   │   │   ├── branch.js      # Branch operations
│   │   │   ├── state.js       # State management
│   │   │   ├── remote.js      # Remote operations
│   │   │   ├── patch.js       # Patch operations
│   │   │   └── package.js     # Package.json handling
│   │   ├── constants.js   # Application constants
│   │   ├── errors.js      # Custom error classes
│   │   └── prompts.js     # Interactive CLI prompts
│   ├── utils.js          # Legacy utilities (deprecated)
│   └── config.json       # Default configuration
└── tests/
    ├── e2e/              # End-to-end tests
    └── mods/             # Example mod structure
```

## Key Patterns

### Error Handling
- Custom error classes: `GitOperationError`, `GitCommandError`, `PatchNotFoundError`, `RepositoryError`
- Consistent error propagation with original error preservation
- State restoration on failure using `saveGitState()` and `restoreGitState()`

### Git Operations
- All Git commands wrapped through `execGit()` for consistent error handling
- State management with automatic stash/restore for uncommitted changes
- Branch validation to prevent operations on base branches

### Patch Naming Convention
- Repository-namespaced: `repository/patch_name`
- Git branch format: `cow_patch_name`
- Tag format: `repository-patch-name-v1.0.0` (sanitized for Git tag compatibility)

### Command Structure
```javascript
// Grouped commands for better UX
const commandGroups = {
  mod: ["apply", "remove", "list", "reset", "search", "sync"],
  dev: ["init", "release", "update", "batch-update"],
  repo: ["repository add", "repository remove", "repository list"]
}
```

## Build & Deployment

### Package Configuration
- Entry point: `bin/wrapper.js` (handles NPX vs local execution)
- Main CLI: `bin/cli.js`
- Dependencies: commander, inquirer, execa, dotenv
- Target repositories configured in `package.json.config`

### Testing Strategy
- Jest test runner with 30-second timeout for e2e tests
- Coverage collection for `bin/` and utilities
- E2e tests for core Git workflows
- Mock mod structure for testing

### Git Integration Requirements
- Must run within a Hyperfy repository (validated by remote URL)
- Requires specific remote configurations (hyperfy, drama-haus)
- Branch validation prevents operations on base branches (main, dev, etc.)

## Common Operations

### Installing Mods
```bash
# Interactive installation
npx hypkg apply

# Specific mod installation
npx hypkg apply repository/mod-name

# Version-specific installation
npx hypkg apply repository/mod-name -v 1.2.0
```

### Managing Repositories
```bash
# List repositories
npx hypkg repository list

# Add repository
npx hypkg repository add name url

# Remove repository
npx hypkg repository remove name
```

### Development Workflow
```bash
# Create release from current branch
npx hypkg release

# Update development branch
npx hypkg update

# Sync all applied mods
npx hypkg sync
```

## Critical Implementation Details

### Repository Verification
- Verified repositories are fetched from remote source
- Verification badges shown in search results
- Security measure to identify trusted mod sources

### Enhanced Commit Messages
- Metadata embedded in commit messages for tracking
- Original commit hash, mod base hash, current base hash
- Enables precise patch tracking and updates

### Conflict Resolution
- Automatic package.json/package-lock.json conflict resolution
- Manual intervention required for code conflicts
- State restoration on unresolvable conflicts

### Version Management
- Semantic versioning with Git tags
- Automatic version bumping for releases
- Update detection and user prompts during sync

This tool represents a sophisticated Git-based mod management system designed specifically for the Hyperfy ecosystem, with robust error handling, state management, and user experience considerations.