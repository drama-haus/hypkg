const { GitHubAPI } = require('../src/lib/github');
const { addRepository, listRepositories } = require('./repository');
const inquirer = require('inquirer');
const ora = require('ora');
const chalk = require('chalk');

const github = new GitHubAPI();

/**
 * Get origin remote URL and parse it to owner/repo format
 * @returns {Promise<string|null>} - Repository path in "owner/repo" format or null if not found
 */
async function getOriginRepository() {
  try {
    const { execSync } = require('child_process');
    const originUrl = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim();
    
    // Parse GitHub URLs
    const githubMatch = originUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
    if (githubMatch) {
      return `${githubMatch[1]}/${githubMatch[2]}`;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Browse forks of a repository
 * @param {string} repositoryPath - Repository in format "owner/repo" (optional if in git repo)
 * @param {object} options - Command options (all, list, refresh)
 */
async function browseForks(repositoryPath, options = {}) {
  const spinner = ora('Fetching repository forks...').start();
  
  try {
    let owner, repo;
    
    // If no repository path provided, try to get from origin remote
    if (!repositoryPath) {
      const originRepo = await getOriginRepository();
      if (!originRepo) {
        throw new Error('No repository specified and not in a git repository with GitHub origin');
      }
      repositoryPath = originRepo;
      spinner.text = `Using origin repository: ${repositoryPath}`;
    }
    
    // Parse repository path
    [owner, repo] = repositoryPath.split('/');
    if (!owner || !repo) {
      throw new Error('Repository must be in format "owner/repo"');
    }

    // Get the main repository info first
    spinner.text = `Fetching information for ${repositoryPath}...`;
    const mainRepo = await github.getRepository(owner, repo);
    const formattedMain = github.formatRepository(mainRepo);

    // Get forks with filtering enabled by default (unless --all flag is used)
    if (options.refresh) {
      spinner.text = 'Refreshing repository data...';
    } else if (options.all) {
      spinner.text = 'Fetching all forks...';
    } else {
      spinner.text = 'Fetching forks with mod branches...';
    }
    
    const forks = await github.getForks(owner, repo, { 
      perPage: 100,
      filterByModBranches: !options.all,  // Filter unless --all flag is used
      refresh: options.refresh  // Pass refresh option to bypass cache
    });
    
    if (forks.length === 0) {
      if (options.all) {
        spinner.info(`No forks found for ${repositoryPath}`);
      } else {
        spinner.info(`No forks found with mod branches (cow_* prefixed branches) for ${repositoryPath}`);
        console.log('💡 Use --all flag to see all forks, including those without mod branches');
      }
      return;
    }
    
    // Show cache status if not refreshing
    if (!options.refresh) {
      const cacheStatus = await github.getCacheStatus();
      if (cacheStatus.hasCache) {
        if (options.all) {
          spinner.succeed(`Found ${forks.length} forks (cached ${cacheStatus.ageFormatted})`);
        } else {
          spinner.succeed(`Found ${forks.length} forks with mod branches (cached ${cacheStatus.ageFormatted})`);
        }
        if (cacheStatus.isExpired) {
          console.log('💡 Cache is older than 24 hours. Use --refresh to get latest data');
        }
      } else {
        if (options.all) {
          spinner.succeed(`Found ${forks.length} forks`);
        } else {
          spinner.succeed(`Found ${forks.length} forks with mod branches`);
        }
      }
    } else {
      if (options.all) {
        spinner.succeed(`Found ${forks.length} forks (refreshed)`);
      } else {
        spinner.succeed(`Found ${forks.length} forks with mod branches (refreshed)`);
      }
    }

    // Format forks for display
    const formattedForks = forks.map(fork => {
      const formatted = github.formatRepository(fork);
      
      return {
        ...formatted,
        lastUpdated: github.formatRelativeTime(formatted.updatedAt),
        // Use mod branch count if available (filtered), otherwise total branch count
        modBranchCount: fork._modBranches ? fork._modBranches.modBranchCount : 0,
        totalBranchCount: fork._modBranches ? fork._modBranches.modBranchCount : 0 // For --all mode, we'd need to get this separately
      };
    });

    // Sort by stars descending, then by last updated
    formattedForks.sort((a, b) => {
      if (b.stars !== a.stars) return b.stars - a.stars;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    console.log(`\n${chalk.blue('Original Repository:')}`);
    console.log(`  ${formattedMain.fullName}`);
    console.log(`  ${formattedMain.description}`);
    console.log(`  ⭐ ${formattedMain.stars} stars, 🍴 ${formattedMain.forks} forks`);
    console.log(`  Updated: ${github.formatRelativeTime(formattedMain.updatedAt)}\n`);

    if (options.list) {
      // Just list the forks
      console.log(chalk.blue('Forks:'));
      formattedForks.forEach((fork, index) => {
        console.log(`  ${index + 1}. ${fork.fullName}`);
        console.log(`     ${fork.description}`);
        if (options.all) {
          // In --all mode, show total branches and mod count
          console.log(`     ⭐ ${fork.stars} stars, 🚀 ${fork.modBranchCount} mods, updated ${fork.lastUpdated}`);
        } else {
          // In filtered mode, show mod count only
          console.log(`     ⭐ ${fork.stars} stars, 🚀 ${fork.modBranchCount} mods, updated ${fork.lastUpdated}`);
        }
        if (fork.language) console.log(`     Language: ${fork.language}`);
        console.log();
      });
      return;
    }

    // Interactive selection
    const choices = formattedForks.map(fork => ({
      name: `${fork.fullName} (⭐${fork.stars}, 🚀${fork.modBranchCount} mods, updated ${fork.lastUpdated})`,
      short: fork.fullName,
      value: fork
    }));

    choices.unshift(new inquirer.Separator('--- Select a fork to add as repository ---'));

    const { selectedFork } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedFork',
        message: 'Select a fork to add as a mod repository:',
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: '❌ Cancel', value: null }
        ],
        pageSize: 15
      }
    ]);

    if (!selectedFork) {
      console.log('Operation cancelled.');
      return;
    }

    // Add the selected fork as a repository
    await addForkAsRepository(selectedFork);

  } catch (error) {
    spinner.fail(`Failed to browse forks: ${error.message}`);
    throw error;
  }
}


/**
 * Add a GitHub repository directly
 * @param {string} repositoryPath - Repository in format "owner/repo"
 */
async function addGitHubRepository(repositoryPath) {
  const spinner = ora(`Fetching repository information for ${repositoryPath}...`).start();
  
  try {
    // Parse repository path
    const [owner, repo] = repositoryPath.split('/');
    if (!owner || !repo) {
      throw new Error('Repository must be in format "owner/repo"');
    }

    // Get repository information
    const repoInfo = await github.getRepository(owner, repo);
    const formatted = github.formatRepository(repoInfo);

    spinner.succeed('Repository information fetched');

    // Show repository details
    console.log(`\n${chalk.blue('Repository Details:')}`);
    console.log(`  Name: ${formatted.fullName}`);
    console.log(`  Description: ${formatted.description}`);
    console.log(`  ⭐ ${formatted.stars} stars, 🍴 ${formatted.forks} forks`);
    console.log(`  Language: ${formatted.language}`);
    console.log(`  Updated: ${github.formatRelativeTime(formatted.updatedAt)}`);
    if (formatted.topics.length > 0) {
      console.log(`  Topics: ${formatted.topics.join(', ')}`);
    }
    console.log(`  URL: ${formatted.htmlUrl}\n`);

    // Confirm addition
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Add this repository to your mod repositories?',
        default: true
      }
    ]);

    if (!confirm) {
      console.log('Operation cancelled.');
      return;
    }

    await addForkAsRepository(formatted);

  } catch (error) {
    spinner.fail(`Failed to add repository: ${error.message}`);
    throw error;
  }
}

/**
 * Add a fork/repository as a mod repository
 * @param {object} repo - Formatted repository object
 */
async function addForkAsRepository(repo) {
  const spinner = ora('Adding repository...').start();
  
  try {
    // Generate a clean repository name
    let repoName = repo.owner.toLowerCase();
    
    // If the repo name is different from 'hyperfy', include it
    if (repo.name.toLowerCase() !== 'hyperfy') {
      repoName += `-${repo.name.toLowerCase()}`;
    }
    
    // Clean up the name (remove special characters, replace with dashes)
    repoName = repoName.replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-');

    const repoUrl = repo.cloneUrl;

    spinner.text = `Adding repository as '${repoName}'...`;
    
    const success = await addRepository(repoName, repoUrl);
    
    if (success) {
      spinner.succeed(`Repository '${repoName}' added successfully`);
      
      console.log(`\n${chalk.green('✅ Repository Added:')}`);
      console.log(`  Name: ${repoName}`);
      console.log(`  URL:  ${repoUrl}`);
      console.log(`  Original: ${repo.fullName}`);
      console.log(`\n💡 You can now use mods from this repository with:`);
      console.log(`   ${chalk.cyan(`hypkg apply ${repoName}/mod-name`)}`);
      console.log(`   ${chalk.cyan(`hypkg search ${repoName}/`)}`);
      
      // Show updated repository list
      console.log(`\n${chalk.blue('Updated Repository List:')}`);
      await listRepositories();
    }
  } catch (error) {
    spinner.fail(`Failed to add repository: ${error.message}`);
    throw error;
  }
}

/**
 * Enhance existing repository list with GitHub metadata
 * @param {Array} repositories - Existing repositories
 * @returns {Promise<Array>} - Enhanced repositories with GitHub data
 */
async function enhanceRepositoriesWithGitHubData(repositories) {
  const spinner = ora('Fetching GitHub metadata...').start();
  
  try {
    const githubRepos = [];
    
    // Extract GitHub repositories
    for (const repo of repositories) {
      if (repo.url.includes('github.com')) {
        const match = repo.url.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
        if (match) {
          githubRepos.push({
            ...repo,
            owner: match[1],
            repoName: match[2]
          });
        }
      }
    }

    if (githubRepos.length === 0) {
      spinner.info('No GitHub repositories found');
      return repositories;
    }

    spinner.text = `Fetching data for ${githubRepos.length} GitHub repositories...`;
    
    // Fetch GitHub data for all repositories
    const githubData = await github.getRepositories(
      githubRepos.map(repo => ({ owner: repo.owner, repo: repo.repoName }))
    );

    // Merge GitHub data with existing repository data
    const enhanced = repositories.map(repo => {
      const githubRepo = githubRepos.find(gr => gr.name === repo.name);
      if (githubRepo) {
        const githubInfo = githubData.find(gd => 
          gd.owner.login === githubRepo.owner && gd.name === githubRepo.repoName
        );
        
        if (githubInfo && !githubInfo.error) {
          const formatted = github.formatRepository(githubInfo);
          return {
            ...repo,
            github: {
              stars: formatted.stars,
              forks: formatted.forks,
              description: formatted.description,
              language: formatted.language,
              lastUpdated: github.formatRelativeTime(formatted.updatedAt),
              topics: formatted.topics
            }
          };
        }
      }
      return repo;
    });

    spinner.succeed(`Enhanced ${githubRepos.length} repositories with GitHub data`);
    return enhanced;
    
  } catch (error) {
    spinner.warn(`Failed to fetch GitHub metadata: ${error.message}`);
    return repositories;
  }
}

/**
 * Setup custom repositories by browsing GitHub forks
 * @param {object} options - Options (refresh)
 * @returns {Promise<void>}
 */
async function setupCustomRepositories(options = {}) {
  const spinner = ora('Fetching available repositories...').start();
  
  try {
    // Get filtered forks (only those with cow_ branches)
    const availableForks = await github.getForks('hyperfy-xyz', 'hyperfy', {
      filterByModBranches: true,
      perPage: 100,
      refresh: options.refresh
    });
    
    if (availableForks.length === 0) {
      spinner.info('No forks found with available mods.');
      console.log('You can add repositories manually later with: hypkg repository add');
      return;
    }
    
    spinner.succeed(`Found ${availableForks.length} repositories with mods`);
    
    // Format forks for display
    const formattedForks = availableForks.map(fork => {
      const formatted = github.formatRepository(fork);
      return {
        ...formatted,
        lastUpdated: github.formatRelativeTime(formatted.updatedAt),
        modBranchCount: fork._modBranches.modBranchCount,
        modBranches: fork._modBranches.modBranches
      };
    });
    
    // Sort by mod count (descending), then by stars
    formattedForks.sort((a, b) => {
      if (b.modBranchCount !== a.modBranchCount) return b.modBranchCount - a.modBranchCount;
      return b.stars - a.stars;
    });
    
    // Multi-select interface
    const choices = formattedForks.map(fork => ({
      name: `${fork.fullName} (⭐${fork.stars}, 🚀${fork.modBranchCount} mods, updated ${fork.lastUpdated})`,
      short: fork.fullName,
      value: fork
    }));
    
    const { selectedRepos } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selectedRepos',
      message: 'Select repositories to add:',
      choices,
      pageSize: 15,
      validate: (selection) => {
        if (selection.length === 0) {
          return 'Please select at least one repository';
        }
        return true;
      }
    }]);
    
    // Add all selected repositories
    const addSpinner = ora('Adding selected repositories...').start();
    const results = [];
    
    for (const repo of selectedRepos) {
      try {
        await addForkAsRepository(repo);
        results.push({ repo: repo.fullName, success: true });
        addSpinner.text = `Added ${repo.fullName}...`;
      } catch (error) {
        results.push({ repo: repo.fullName, success: false, error: error.message });
      }
    }
    
    // Show summary
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    addSpinner.succeed(`Added ${successful.length} repositories`);
    
    if (failed.length > 0) {
      console.warn(`Failed to add ${failed.length} repositories:`);
      failed.forEach(f => console.warn(`  - ${f.repo}: ${f.error}`));
    }
    
  } catch (error) {
    spinner.fail(`Failed to setup repositories: ${error.message}`);
    throw error;
  }
}

module.exports = {
  browseForks,
  addGitHubRepository,
  enhanceRepositoriesWithGitHubData,
  setupCustomRepositories
};