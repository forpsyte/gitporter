import ora from 'ora';
import { createJiraClient } from './jiraClient.js';
import { createGitHubClient } from './githubClient.js';
import { createSummarizer } from './summarizer.js';
import {
  logger,
  MarkdownConverter,
  StatusMapper,
  LabelMapper,
  fileUtils,
  dateUtils,
  textUtils
} from './utils.js';

/**
 * Main migration orchestrator
 */
export class Migrator {
  constructor(config) {
    this.config = config;
    this.jiraClient = createJiraClient(config.jira);
    this.githubClient = createGitHubClient(config.github);
    this.summarizer = createSummarizer(config.openai);
    this.markdownConverter = new MarkdownConverter();
    this.statusMapper = new StatusMapper(config.migration.statusMapping);
    this.labelMapper = new LabelMapper(config.migration.labelMapping);

    // State management
    this.mapping = {};
    this.mappingFile = 'mapping.json';
    this.stats = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      comments: 0,
      attachments: 0
    };
  }

  /**
   * Execute the full migration process
   * @returns {Promise<Object>} Migration results
   */
  async migrate() {
    const spinner = ora('Starting migration...').start();

    try {
      // Test connections
      await this.testConnections(spinner);

      // Load existing mapping for idempotency
      await this.loadMapping(spinner);

      // Fetch issues from Jira
      const jiraIssues = await this.fetchJiraIssues(spinner);

      if (jiraIssues.length === 0) {
        spinner.succeed('No issues found to migrate');
        return this.stats;
      }

      // Generate AI summaries in batch
      const summaries = await this.generateSummaries(jiraIssues, spinner);

      // Process issues in batches
      await this.processIssuesBatch(jiraIssues, summaries, spinner);

      // Save final mapping
      await this.saveMapping(spinner);

      spinner.succeed('Migration completed successfully');
      this.printStats();

      return this.stats;
    } catch (error) {
      spinner.fail(`Migration failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Test all API connections
   * @param {Object} spinner Ora spinner instance
   */
  async testConnections(spinner) {
    spinner.text = 'Testing API connections...';

    // Test Jira connection
    await this.jiraClient.testAuthentication();
    logger.debug('✓ Jira connection successful');

    // Test GitHub connection
    await this.githubClient.testAuthentication();
    await this.githubClient.testRepositoryAccess();
    logger.debug('✓ GitHub connection successful');

    // Test OpenAI connection (optional)
    if (this.config.migration.includeSummary) {
      const openaiWorking = await this.summarizer.testConnection();
      if (!openaiWorking) {
        logger.warn('OpenAI connection failed - summaries will be disabled');
        this.config.migration.includeSummary = false;
      } else {
        logger.debug('✓ OpenAI connection successful');
      }
    }
  }

  /**
   * Load existing mapping file for idempotency
   * @param {Object} spinner Ora spinner instance
   */
  async loadMapping(spinner) {
    spinner.text = 'Loading existing mappings...';

    const existingMapping = await fileUtils.readJsonFile(this.mappingFile);
    if (existingMapping) {
      this.mapping = existingMapping;
      const issueCount = Object.keys(this.mapping).length;
      logger.info(`Loaded existing mappings for ${issueCount} issues`);
    } else {
      logger.info('No existing mapping file found - starting fresh migration');
    }
  }

  /**
   * Save mapping file
   * @param {Object} spinner Ora spinner instance
   */
  async saveMapping(spinner) {
    spinner.text = 'Saving mappings...';

    await fileUtils.writeJsonFile(this.mappingFile, this.mapping);
    logger.debug(`Saved mappings to ${this.mappingFile}`);
  }

  /**
   * Fetch all issues from Jira
   * @param {Object} spinner Ora spinner instance
   * @returns {Promise<Array>} Array of Jira issues
   */
  async fetchJiraIssues(spinner) {
    spinner.text = 'Fetching issues from Jira...';

    const jql = this.jiraClient.buildJqlQuery(this.config);
    logger.debug(`Using JQL query: ${jql}`);

    const allIssues = await this.jiraClient.getAllIssues(jql, {
      batchSize: this.config.migration.batchSize
    });

    // Filter and separate issues by type
    const { allIssues: filteredIssues } = this.jiraClient.filterIssuesByType(
      allIssues,
      this.config
    );

    logger.info(`Found ${filteredIssues.length} issues to migrate`);
    return filteredIssues;
  }

  /**
   * Generate AI summaries for all issues
   * @param {Array} jiraIssues Array of Jira issues
   * @param {Object} spinner Ora spinner instance
   * @returns {Promise<Object>} Map of issue keys to summaries
   */
  async generateSummaries(jiraIssues, spinner) {
    if (!this.config.migration.includeSummary || !this.summarizer.isAvailable()) {
      return {};
    }

    spinner.text = 'Generating AI summaries...';

    // Filter out issues that already have mappings (already migrated)
    const issuesToSummarize = jiraIssues.filter(issue => !this.mapping[issue.key]);

    if (issuesToSummarize.length === 0) {
      logger.debug('No new issues to summarize');
      return {};
    }

    const summaries = await this.summarizer.summarizeIssuesBatch(issuesToSummarize, {
      concurrency: 2, // Be conservative with OpenAI rate limits
      delay: 1500
    });

    return summaries;
  }

  /**
   * Process issues in batches
   * @param {Array} jiraIssues Array of Jira issues
   * @param {Object} summaries Map of issue keys to AI summaries
   * @param {Object} spinner Ora spinner instance
   */
  async processIssuesBatch(jiraIssues, summaries, spinner) {
    const batchSize = this.config.migration.batchSize;
    const batches = this.chunkArray(jiraIssues, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchNum = i + 1;

      spinner.text = `Processing batch ${batchNum}/${batches.length} (${batch.length} issues)...`;

      // Process batch sequentially to avoid rate limits
      for (const jiraIssue of batch) {
        await this.processIssue(jiraIssue, summaries[jiraIssue.key]);
      }

      // Save mapping after each batch
      await this.saveMapping(spinner);

      logger.info(`Completed batch ${batchNum}/${batches.length}`);
    }
  }

  /**
   * Process a single Jira issue
   * @param {Object} jiraIssue Jira issue object
   * @param {string} aiSummary AI-generated summary
   */
  async processIssue(jiraIssue, aiSummary = null) {
    const jiraKey = jiraIssue.key;

    try {
      this.stats.processed++;

      // Check if already migrated successfully
      if (this.mapping[jiraKey] && this.mapping[jiraKey].status === 'migrated') {
        logger.debug(
          `Skipping ${jiraKey} - already migrated to #${this.mapping[jiraKey].githubNumber}`
        );
        this.stats.skipped++;
        return;
      }
      
      // Check if already exists as existing issue
      if (this.mapping[jiraKey] && this.mapping[jiraKey].status === 'existing') {
        logger.debug(
          `Skipping ${jiraKey} - already exists as #${this.mapping[jiraKey].githubNumber}`
        );
        this.stats.skipped++;
        return;
      }
      
      // If it was an error, log that we're retrying
      if (this.mapping[jiraKey] && this.mapping[jiraKey].status === 'error') {
        logger.info(`Retrying ${jiraKey} after previous error: ${this.mapping[jiraKey].error}`);
      }

      // Check for existing GitHub issue
      const existingIssue = await this.githubClient.findExistingIssue(jiraKey);
      if (existingIssue) {
        logger.info(`Found existing GitHub issue for ${jiraKey}: #${existingIssue.number}`);
        this.mapping[jiraKey] = {
          githubNumber: existingIssue.number,
          githubUrl: existingIssue.html_url,
          migratedAt: new Date().toISOString(),
          status: 'existing'
        };
        this.stats.skipped++;
        return;
      }

      if (this.config.migration.dryRun) {
        logger.info(`[DRY RUN] Would migrate ${jiraKey}: ${jiraIssue.fields.summary}`);
        this.stats.created++;
        return;
      }

      // Convert and create the issue
      const githubIssue = await this.convertAndCreateIssue(jiraIssue, aiSummary);

      // Record the mapping
      this.mapping[jiraKey] = {
        githubNumber: githubIssue.number,
        githubUrl: githubIssue.html_url,
        migratedAt: new Date().toISOString(),
        status: 'migrated'
      };

      // Process comments
      await this.migrateComments(jiraIssue, githubIssue.number);

      this.stats.created++;
      logger.success(`Migrated ${jiraKey} → GitHub #${githubIssue.number}`);
    } catch (error) {
      this.stats.errors++;
      logger.error(`Failed to migrate ${jiraKey}: ${error.message}`);
      logger.error(`Stack trace: ${error.stack}`);

      // Record the error in mapping
      this.mapping[jiraKey] = {
        error: error.message,
        stack: error.stack,
        migratedAt: new Date().toISOString(),
        status: 'error'
      };
    }
  }

  /**
   * Convert Jira issue to GitHub issue and create it
   * @param {Object} jiraIssue Jira issue object
   * @param {string} aiSummary AI-generated summary
   * @returns {Promise<Object>} Created GitHub issue
   */
  async convertAndCreateIssue(jiraIssue, aiSummary = null) {
    const fields = jiraIssue.fields;
    const title = this.buildGitHubTitle(jiraIssue);
    const body = await this.buildGitHubBody(jiraIssue, aiSummary);
    const labels = this.labelMapper.mapLabels(jiraIssue);
    const state = this.statusMapper.mapStatus(fields.status?.name);

    // Ensure labels exist in the repository
    await this.githubClient.ensureLabelsExist(labels);

    const issueData = {
      title,
      body,
      labels,
      state
    };

    return await this.githubClient.createIssue(issueData);
  }

  /**
   * Build GitHub issue title
   * @param {Object} jiraIssue Jira issue object
   * @returns {string} GitHub issue title
   */
  buildGitHubTitle(jiraIssue) {
    const title = jiraIssue.fields.summary || 'Untitled Issue';
    const sanitized = textUtils.sanitizeTitle(title);

    // Include Jira key for reference
    return `[${jiraIssue.key}] ${sanitized}`;
  }

  /**
   * Build GitHub issue body
   * @param {Object} jiraIssue Jira issue object
   * @param {string} aiSummary AI-generated summary
   * @returns {Promise<string>} GitHub issue body
   */
  async buildGitHubBody(jiraIssue, aiSummary = null) {
    const fields = jiraIssue.fields;
    let body = '';

    // Add AI summary if available
    if (aiSummary && this.config.migration.includeSummary) {
      body += this.summarizer.formatSummaryForGitHub(aiSummary, jiraIssue.key);
    }

    // Add issue metadata
    body += this.buildIssueMetadata(jiraIssue);

    // Add description
    const description = fields.description || jiraIssue.renderedFields?.description || '';

    if (description) {
      body += '## Description\n\n';
      body += this.markdownConverter.toMarkdown(description);
      body += '\n\n';
    }

    // Add acceptance criteria if available
    const acceptanceCriteria =
      fields.customfield_10100 || // Common AC field
      fields.customfield_10000; // Alternative AC field
    if (acceptanceCriteria) {
      body += '## Acceptance Criteria\n\n';
      body += this.markdownConverter.toMarkdown(acceptanceCriteria);
      body += '\n\n';
    }

    // Handle attachments
    const attachments = fields.attachment || [];
    if (attachments.length > 0) {
      const attachmentText = await this.githubClient.handleAttachments(
        attachments,
        jiraIssue.key,
        this.config.migration.attachmentStrategy,
        this.jiraClient
      );
      body += attachmentText;
      this.stats.attachments += attachments.length;
    }

    // Add footer with migration info
    body += this.buildMigrationFooter(jiraIssue);

    return body;
  }

  /**
   * Build issue metadata section
   * @param {Object} jiraIssue Jira issue object
   * @returns {string} Metadata markdown
   */
  buildIssueMetadata(jiraIssue) {
    const fields = jiraIssue.fields;
    let metadata = '## Issue Details\n\n';

    metadata += '| Field | Value |\n';
    metadata += '|-------|-------|\n';
    metadata += `| **Jira Key** | [${jiraIssue.key}](${this.config.jira.url}/browse/${jiraIssue.key}) |\n`;
    metadata += `| **Issue Type** | ${fields.issuetype?.name || 'Unknown'} |\n`;
    metadata += `| **Status** | ${fields.status?.name || 'Unknown'} |\n`;
    metadata += `| **Priority** | ${fields.priority?.name || 'Unknown'} |\n`;
    metadata += `| **Reporter** | ${fields.reporter?.displayName || 'Unknown'} |\n`;
    metadata += `| **Assignee** | ${fields.assignee?.displayName || 'Unassigned'} |\n`;
    metadata += `| **Created** | ${dateUtils.formatJiraDate(fields.created)} |\n`;
    metadata += `| **Updated** | ${dateUtils.formatJiraDate(fields.updated)} |\n`;

    // Add components
    const components = fields.components || [];
    if (components.length > 0) {
      const componentNames = components.map(c => c.name).join(', ');
      metadata += `| **Components** | ${componentNames} |\n`;
    }

    // Add fix versions
    const fixVersions = fields.fixVersions || [];
    if (fixVersions.length > 0) {
      const versionNames = fixVersions.map(v => v.name).join(', ');
      metadata += `| **Fix Versions** | ${versionNames} |\n`;
    }

    metadata += '\n---\n\n';
    return metadata;
  }

  /**
   * Build migration footer
   * @param {Object} jiraIssue Jira issue object
   * @returns {string} Footer markdown
   */
  buildMigrationFooter(jiraIssue) {
    return `\n---\n\n*This issue was migrated from [${jiraIssue.key}](${this.config.jira.url}/browse/${jiraIssue.key}) on ${new Date().toLocaleDateString()}*`;
  }

  /**
   * Migrate comments from Jira to GitHub
   * @param {Object} jiraIssue Jira issue object
   * @param {number} githubIssueNumber GitHub issue number
   */
  async migrateComments(jiraIssue, githubIssueNumber) {
    try {
      const comments = await this.jiraClient.getComments(jiraIssue.key);

      if (comments.length === 0) {
        return;
      }

      logger.debug(`Migrating ${comments.length} comments for ${jiraIssue.key}`);

      for (const comment of comments) {
        await this.migrateComment(comment, githubIssueNumber);
        this.stats.comments++;
      }
    } catch (error) {
      logger.warn(`Failed to migrate comments for ${jiraIssue.key}: ${error.message}`);
    }
  }

  /**
   * Migrate a single comment
   * @param {Object} jiraComment Jira comment object
   * @param {number} githubIssueNumber GitHub issue number
   */
  async migrateComment(jiraComment, githubIssueNumber) {
    const author = jiraComment.author?.displayName || 'Unknown User';
    const created = dateUtils.formatJiraDate(jiraComment.created);
    const updated = jiraComment.updated ? dateUtils.formatJiraDate(jiraComment.updated) : null;

    // Convert comment body
    const originalBody = jiraComment.body || jiraComment.renderedBody || '';
    const convertedBody = this.markdownConverter.toMarkdown(originalBody);

    // Build GitHub comment
    let githubCommentBody = `**${author}** commented on ${created}`;
    if (updated && updated !== created) {
      githubCommentBody += ` (updated ${updated})`;
    }
    githubCommentBody += ':\n\n';
    githubCommentBody += convertedBody;

    await this.githubClient.createComment(githubIssueNumber, githubCommentBody);
  }

  /**
   * Split array into chunks
   * @param {Array} array Array to chunk
   * @param {number} size Chunk size
   * @returns {Array} Array of chunks
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Print migration statistics
   */
  printStats() {
    logger.info('\n📊 Migration Statistics:');
    logger.info(`  Total Processed: ${this.stats.processed}`);
    logger.info(`  Successfully Created: ${this.stats.created}`);
    logger.info(`  Skipped (already exists): ${this.stats.skipped}`);
    logger.info(`  Errors: ${this.stats.errors}`);
    logger.info(`  Comments Migrated: ${this.stats.comments}`);
    logger.info(`  Attachments Processed: ${this.stats.attachments}`);

    if (this.stats.errors > 0) {
      logger.warn('\n⚠️  Some issues failed to migrate. Check the mapping.json file for details.');
    }
  }
}

/**
 * Create and configure migrator
 * @param {Object} config Full configuration object
 * @returns {Migrator} Configured migrator instance
 */
export function createMigrator(config) {
  return new Migrator(config);
}

// Export for CLI usage
export const migrator = {
  /**
   * Execute migration with the given configuration
   * @param {Object} config Migration configuration
   * @returns {Promise<Object>} Migration results
   */
  async migrate(config) {
    const migratorInstance = createMigrator(config);
    return await migratorInstance.migrate();
  }
};
