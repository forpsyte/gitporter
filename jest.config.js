export default {
  testEnvironment: 'node',
  verbose: true,
  collectCoverage: false,
  testMatch: ['**/tests/**/*.test.js'],
  moduleFileExtensions: ['js'],
  transform: {},
  setupFilesAfterEnv: [],
  testTimeout: 30000,
  maxWorkers: 1,
  forceExit: true
}; 