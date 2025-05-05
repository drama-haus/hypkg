const chalk = require("chalk");
const { CLI } = require("../src/lib/constants");

// Utility function for consistent logging
function log(message, type = "info") {
  const prefix = {
    info: chalk.blue(CLI.LOG_PREFIXES.INFO),
    success: chalk.green(CLI.LOG_PREFIXES.SUCCESS),
    warning: chalk.yellow(CLI.LOG_PREFIXES.WARNING),
    error: chalk.red(CLI.LOG_PREFIXES.ERROR),
    step: chalk.cyan(CLI.LOG_PREFIXES.STEP),
  }[type];

  console.log(`${prefix} ${message}`);
}

exports.log = log;
