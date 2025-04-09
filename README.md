## Setup

hypkg is designed to be run with `npx` inside a Hyperfy repository:

```bash
# Navigate to your Hyperfy repository
cd path/to/your/hyperfy/repository

# Run interactive installation of mods
npx hypkg apply
```

## Basic Usage

### Managing Mods

```bash
# List installed mods
npx hypkg list

# Search available mods
npx hypkg search

# Install specific mods
npx hypkg apply repository/mod-name

# Remove installed mods
npx hypkg remove repository/mod-name

# Reset to base state (remove all mods)
npx hypkg reset
```

### Syncing Mods

The sync command is one of the most important features. It ensures all your installed mods are up-to-date and properly applied:

```bash
npx hypkg sync
```

This will:
1. Check for updates to all installed mods
2. Ensure all mods are compatible with the current Hyperfy version
3. Re-apply mods in the correct order
4. Handle any conflicts between mods

Run this command periodically to ensure your mods stay up-to-date.

### Repository Management

```bash
# List available mod repositories
npx hypkg repo list

# Add a new mod repository
npx hypkg repo add name url

# Remove a mod repository
npx hypkg repo remove name
```

## For Developers

If you're developing mods, hypkg provides additional commands to help with the development process


Important: When developing mods, your branch should have the latest commit of the Hyperfy canonical branch as a base. When updating your development branch, always use:

```bash
git rebase dev

# Release a new version of your mod
npx hypkg release
```

Do NOT use `git merge dev` as this will not work correctly with the mod system.

## Troubleshooting

If you encounter issues:

1. Make sure you're running the command in a valid Hyperfy repository
2. Try resetting your mod state: `npx hypkg reset`
3. Check for updates: `npx hypkg sync`
4. Reach out on the `hypkg` channel on [Hyperfy discord server](https://discord.gg/9EzdQk7CQe)

