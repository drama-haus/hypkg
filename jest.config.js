module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000, // Increase default timeout for e2e tests
  verbose: true,
  testMatch: [
    "**/tests/**/*.test.js"
  ],
  // Collect coverage information
  collectCoverage: true,
  collectCoverageFrom: [
    "bin/**/*.js",
    "utils.js",
    "!**/node_modules/**"
  ],
  coverageReporters: ["text", "lcov"],
  // Setup files if needed
  // setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
}; 