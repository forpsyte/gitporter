#!/usr/bin/env node

import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { migrator } from './migrator.js';
import { logger } from './utils.js';

const program = new Command();

program
  .name('gitporter')
  .description('Migrate Jira Cloud issues to GitHub issues with AI-powered summaries')
  .version('1.0.0')
  .option('--dry-run', 'Run without making any API calls to GitHub')
  .option('--jql <query>', 'Override default JQL query for Jira search')
  .option('--batch-size <number>', 'Number of issues to process in each batch', '10')
  .option('--config <path>', 'Path to JSON config file')
  .option('-v, --verbose', 'Enable verbose logging')
  .parse();

const options = program.opts();

/**
 * Find configuration file in order of preference
 * @returns {string|null} Path to config file or null if not found
 */
async function findConfigFile() {
  const searchPaths = [];
  
  // 1. --config flag takes highest priority
  if (options.config) {
    searchPaths.push(path.resolve(options.config));
  }
  
  // 2. config.json in current working directory
  searchPaths.push(path.resolve('./config.json'));
  
  // 3. ~/.gitporter/config.json
  const homeConfigPath = path.join(os.homedir(), '.gitporter', 'config.json');
  searchPaths.push(homeConfigPath);
  
  for (const configPath of searchPaths) {
    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      // File doesn't exist, continue searching
    }
  }
  
  return null;
}

/**
 * Load configuration from file
 * @returns {Object} Configuration object
 */
async function loadConfig() {
  const configPath = await findConfigFile();
  
  if (!configPath) {
    logger.error('No configuration file found. Please create one of:');
    logger.error('  - ./config.json (current directory)');
    logger.error('  - ~/.gitporter/config.json (user config)');
    logger.error('  - Use --config <path> to specify a custom location');
    logger.error('\nSee README.md for configuration format examples.');
    process.exit(1);
  }

  try {
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Apply CLI overrides
    if (options.jql) {
      config.jira = config.jira || {};
      config.jira.jql = options.jql;
    }
    
    if (options.batchSize) {
      config.migration = config.migration || {};
      config.migration.batchSize = parseInt(options.batchSize, 10);
    }
    
    if (options.dryRun) {
      config.migration = config.migration || {};
      config.migration.dryRun = true;
    }
    
    if (options.verbose) {
      config.migration = config.migration || {};
      config.migration.verbose = true;
    }

    logger.info(`Loaded configuration from ${configPath}`);
    return config;
  } catch (error) {
    logger.error(`Failed to load config file ${configPath}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Validate required configuration
 * @param {Object} config Configuration object
 */
function validateConfig(config) {
  const required = [
    { path: 'jira.url', name: 'jira.url' },
    { path: 'jira.email', name: 'jira.email' },
    { path: 'jira.apiToken', name: 'jira.apiToken' },
    { path: 'github.token', name: 'github.token' },
    { path: 'github.repo', name: 'github.repo' }
  ];

  const missing = required.filter(req => {
    const value = req.path.split('.').reduce((obj, key) => obj?.[key], config);
    return !value;
  });

  if (missing.length > 0) {
    logger.error('Missing required configuration fields:');
    missing.forEach(req => {
      logger.error(`  - ${req.name}`);
    });
    logger.error('\nPlease add these fields to your config.json file.');
    process.exit(1);
  }

  // Validate GitHub repo format
  if (!config.github.repo.includes('/')) {
    logger.error('github.repo must be in format "owner/repo"');
    process.exit(1);
  }
}

/**
 * Main execution function
 */
async function main() {
  try {
    const spinner = ora('Loading configuration...').start();

    const config = await loadConfig();
    validateConfig(config);

    // Set logger verbosity
    logger.setVerbose(config.migration.verbose);

    spinner.succeed('Configuration loaded');

    if (config.migration.dryRun) {
      logger.info('🌵 Running in dry-run mode - no changes will be made to GitHub');
    }

    logger.info(`Starting migration from Jira to GitHub (${config.github.repo})`);
    logger.info(`Batch size: ${config.migration.batchSize}`);
    logger.info(`JQL: ${config.jira.jql}`);

    // Start migration
    await migrator.migrate(config);

    logger.info('✅ Migration completed successfully!');
  } catch (error) {
    ora().fail('Migration failed');
    logger.error(`Error: ${error.message}`);
    if (options.verbose) {
      logger.error(error.stack);
    }
    process.exit(1);
  }
}

// Handle unhandled rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Run the CLI
main();
