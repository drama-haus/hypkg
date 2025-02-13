#!/usr/bin/env node

// Add at the top with other requires
const findUp = require('find-up');

async function findLocalCLI() {
    try {
        // First try to find nearest package.json
        const pkgPath = await findUp('package.json');
        if (!pkgPath) {
            throw new Error('Not in a Node.js project');
        }

        // Check if we're in the game engine repo by verifying git remote
        const { stdout } = await execa('git', ['remote', 'get-url', 'origin']);
        if (!stdout.trim().includes(TARGET_REPO.replace('.git', ''))) {
            throw new Error(`Not in the game engine repository`);
        }

        // Find the local hucow installation
        const cliPath = path.join(path.dirname(pkgPath), 'node_modules', 'hucow', 'bin', 'cli.js');
        if (!await fs.access(cliPath).then(() => true).catch(() => false)) {
            throw new Error('hucow is not installed in this project');
        }

        return cliPath;
    } catch (e) {
        throw new Error(`Failed to find local CLI: ${e.message}`);
    }
}


async function main() {
    try {
        const cliPath = await findLocalCLI();
        // Execute the actual CLI script
        require(cliPath);
    } catch (e) {
        console.error(`Error: ${e.message}`);
        console.error('Please ensure you are in the game engine repository and have run `npm install`');
        process.exit(1);
    }
}

main();
