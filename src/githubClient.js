import { Octokit } from '@octokit/rest';
import { logger, RateLimiter } from './utils.js';

/**
 * GitHub API client using Octokit
 */
export class GitHubClient {
  constructor(config) {
    this.config = config;
    this.rateLimiter = new RateLimiter();

    // Parse owner and repo from config
    const [owner, repo] = config.repo.split('/');
    this.owner = owner;
    this.repo = repo;

    // Create Octokit instance
    this.octokit = new Octokit({
      auth: config.token,
      userAgent: 'gitporter/1.0.0',
      timeZone: 'UTC'
    });

    // Add request/response logging
    this.octokit.hook.before('request', options => {
      logger.debug(`GitHub API: ${options.method} ${options.url}`);
    });

    this.octokit.hook.after('request', (response, options) => {
      logger.debug(`GitHub API: ${options.method} ${options.url} - ${response.status}`);
    });

    this.octokit.hook.error('request', (error, options) => {
      const status = error.response?.status;
      logger.debug(
        `GitHub API Error: ${options.method} ${options.url} - ${status}: ${error.message}`
      );
      throw error;
    });
  }

  /**
   * Test authentication with GitHub
   * @returns {Promise<Object>} User information
   */
  async testAuthentication() {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug('Testing GitHub authentication...');
      const response = await this.octokit.rest.users.getAuthenticated();
      logger.debug(`Authenticated as: ${response.data.login} (${response.data.name})`);
      return response.data;
    }, 'GitHub authentication test');
  }

  /**
   * Test repository access
   * @returns {Promise<Object>} Repository information
   */
  async testRepositoryAccess() {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Testing access to repository: ${this.owner}/${this.repo}`);
      const response = await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo
      });
      logger.debug(`Repository access confirmed: ${response.data.full_name}`);
      return response.data;
    }, 'GitHub repository access test');
  }

  /**
   * Create a new GitHub issue
   * @param {Object} issueData Issue data
   * @param {string} issueData.title Issue title
   * @param {string} issueData.body Issue body
   * @param {Array<string>} issueData.labels Array of label names
   * @param {string} issueData.state Issue state ('open' or 'closed')
   * @param {string} issueData.assignee GitHub username to assign
   * @returns {Promise<Object>} Created issue data
   */
  async createIssue(issueData) {
    return this.rateLimiter.executeWithRetry(async () => {
      const { title, body, labels = [], state = 'open', assignee } = issueData;

      logger.debug(`Creating GitHub issue: ${title}`);

      const createData = {
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        labels
      };

      if (assignee) {
        createData.assignee = assignee;
      }

      const response = await this.octokit.rest.issues.create(createData);
      const issue = response.data;

      // Update state if needed (issues are created as 'open' by default)
      if (state === 'closed') {
        await this.updateIssueState(issue.number, 'closed');
      }

      logger.success(`Created GitHub issue #${issue.number}: ${title}`);
      return issue;
    }, `create issue: ${issueData.title}`);
  }

  /**
   * Update issue state
   * @param {number} issueNumber Issue number
   * @param {string} state New state ('open' or 'closed')
   * @returns {Promise<Object>} Updated issue data
   */
  async updateIssueState(issueNumber, state) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Updating issue #${issueNumber} state to: ${state}`);

      const response = await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state
      });

      return response.data;
    }, `update issue #${issueNumber} state`);
  }

  /**
   * Add a comment to an issue
   * @param {number} issueNumber Issue number
   * @param {string} body Comment body
   * @returns {Promise<Object>} Created comment data
   */
  async createComment(issueNumber, body) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Adding comment to issue #${issueNumber}`);

      const response = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body
      });

      logger.debug(`Added comment to issue #${issueNumber}`);
      return response.data;
    }, `create comment on issue #${issueNumber}`);
  }

  /**
   * Get all labels in the repository
   * @returns {Promise<Array>} Array of label objects
   */
  async getLabels() {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug('Fetching repository labels...');

      const response = await this.octokit.rest.issues.listLabelsForRepo({
        owner: this.owner,
        repo: this.repo,
        per_page: 100
      });

      return response.data;
    }, 'fetch repository labels');
  }

  /**
   * Create a label if it doesn't exist
   * @param {string} name Label name
   * @param {string} color Label color (hex without #)
   * @param {string} description Label description
   * @returns {Promise<Object>} Label object
   */
  async createLabel(name, color = 'd73a4a', description = '') {
    return this.rateLimiter.executeWithRetry(async () => {
      try {
        // Try to get existing label first
        const response = await this.octokit.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name
        });
        return response.data;
      } catch (error) {
        if (error.status === 404) {
          // Label doesn't exist, create it
          logger.debug(`Creating label: ${name}`);
          const response = await this.octokit.rest.issues.createLabel({
            owner: this.owner,
            repo: this.repo,
            name,
            color,
            description
          });
          return response.data;
        }
        throw error;
      }
    }, `create label: ${name}`);
  }

  /**
   * Upload file as a release asset (alternative approach for attachments)
   * @param {string} tagName Release tag name
   * @param {Buffer} fileContent File content buffer
   * @param {string} fileName File name
   * @param {string} contentType MIME content type
   * @returns {Promise<Object>} Upload result
   */
  async uploadReleaseAsset(
    tagName,
    fileContent,
    fileName,
    contentType = 'application/octet-stream'
  ) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Uploading attachment as release asset: ${fileName}`);

      // First, try to get or create the release
      let release;
      try {
        const response = await this.octokit.rest.repos.getReleaseByTag({
          owner: this.owner,
          repo: this.repo,
          tag: tagName
        });
        release = response.data;
      } catch (error) {
        if (error.status === 404) {
          // Create release
          const response = await this.octokit.rest.repos.createRelease({
            owner: this.owner,
            repo: this.repo,
            tag_name: tagName,
            name: `Jira Migration Attachments - ${tagName}`,
            body: 'Release created automatically for Jira migration attachments',
            draft: false,
            prerelease: true
          });
          release = response.data;
          logger.debug(`Created release: ${tagName}`);
        } else {
          throw error;
        }
      }

      // Upload the asset
      const response = await this.octokit.rest.repos.uploadReleaseAsset({
        owner: this.owner,
        repo: this.repo,
        release_id: release.id,
        name: fileName,
        data: fileContent,
        headers: {
          'content-type': contentType,
          'content-length': fileContent.length
        }
      });

      logger.debug(`Uploaded attachment: ${fileName}`);
      return response.data;
    }, `upload attachment: ${fileName}`);
  }

  /**
   * Handle attachments based on strategy
   * @param {Array} attachments Array of Jira attachments
   * @param {string} jiraKey Jira issue key for reference
   * @param {string} strategy 'link' or 'upload'
   * @param {Object} jiraClient Jira client for downloading
   * @returns {Promise<string>} Markdown text for attachments
   */
  async handleAttachments(attachments, jiraKey, strategy = 'link', jiraClient = null) {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    let attachmentText = '\n\n## Attachments\n\n';

    for (const attachment of attachments) {
      const { filename, content: downloadUrl, size, mimeType } = attachment;

      try {
        if (strategy === 'upload' && jiraClient) {
          // Download and re-upload strategy
          logger.debug(`Downloading and re-uploading attachment: ${filename}`);

          const fileContent = await jiraClient.downloadAttachment(downloadUrl, filename);
          const releaseTag = `attachments-${jiraKey.toLowerCase()}`;

          const uploadResult = await this.uploadReleaseAsset(
            releaseTag,
            fileContent,
            filename,
            mimeType
          );

          attachmentText += `- [${filename}](${uploadResult.browser_download_url}) (${this.formatFileSize(size)})\n`;
        } else {
          // Link strategy (default)
          attachmentText += `- [${filename}](${downloadUrl}) (${this.formatFileSize(size)}) - *From Jira*\n`;
        }
      } catch (error) {
        logger.warn(`Failed to handle attachment ${filename}: ${error.message}`);
        // Fallback to link
        attachmentText += `- [${filename}](${downloadUrl}) (${this.formatFileSize(size)}) - *From Jira (upload failed)*\n`;
      }
    }

    return attachmentText;
  }

  /**
   * Format file size in human readable format
   * @param {number} bytes File size in bytes
   * @returns {string} Formatted file size
   */
  formatFileSize(bytes) {
    if (!bytes) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * Search for existing issues with specific criteria
   * @param {string} query Search query
   * @returns {Promise<Array>} Array of matching issues
   */
  async searchIssues(query) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Searching GitHub issues: ${query}`);

      const response = await this.octokit.rest.search.issuesAndPullRequests({
        q: `${query} repo:${this.owner}/${this.repo}`,
        sort: 'created',
        order: 'desc',
        per_page: 50
      });

      return response.data.items;
    }, `search issues: ${query}`);
  }

  /**
   * Check if an issue with Jira key already exists
   * @param {string} jiraKey Jira issue key
   * @returns {Promise<Object|null>} Existing issue or null
   */
  async findExistingIssue(jiraKey) {
    try {
      // Search for issues containing the Jira key
      const issues = await this.searchIssues(`"${jiraKey}" in:title,body`);

      // Look for exact match in title or body
      const exactMatch = issues.find(
        issue => issue.title.includes(jiraKey) || issue.body?.includes(jiraKey)
      );

      if (exactMatch) {
        logger.debug(`Found existing issue for ${jiraKey}: #${exactMatch.number}`);
        return exactMatch;
      }

      return null;
    } catch (error) {
      logger.warn(`Error searching for existing issue ${jiraKey}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get rate limit status
   * @returns {Promise<Object>} Rate limit information
   */
  async getRateLimit() {
    return this.rateLimiter.executeWithRetry(async () => {
      const response = await this.octokit.rest.rateLimit.get();
      return response.data;
    }, 'get rate limit status');
  }

  /**
   * Ensure required labels exist in the repository
   * @param {Array<string>} labelNames Array of label names to ensure exist
   * @returns {Promise<void>}
   */
  async ensureLabelsExist(labelNames) {
    const labelColors = {
      'migrated-from-jira': '1f77b4',
      bug: 'd73a4a',
      enhancement: 'a2eeef',
      feature: '0075ca',
      epic: '7057ff',
      task: '008672',
      story: '0052cc'
    };

    for (const labelName of labelNames) {
      try {
        const color = labelColors[labelName] || 'd1ecf1';
        const description =
          labelName === 'migrated-from-jira'
            ? 'Issue migrated from Jira'
            : `Issue type: ${labelName}`;

        await this.createLabel(labelName, color, description);
      } catch (error) {
        logger.warn(`Failed to create label ${labelName}: ${error.message}`);
      }
    }
  }
}

/**
 * Create and configure GitHub client
 * @param {Object} config GitHub configuration
 * @returns {GitHubClient} Configured GitHub client instance
 */
export function createGitHubClient(config) {
  const client = new GitHubClient(config);
  return client;
}
