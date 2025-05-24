import axios from 'axios';
import { logger, RateLimiter } from './utils.js';

/**
 * Jira Cloud API client
 */
export class JiraClient {
  constructor(config) {
    this.config = config;
    this.rateLimiter = new RateLimiter();

    // Create axios instance with basic auth
    this.api = axios.create({
      baseURL: config.url,
      auth: {
        username: config.email,
        password: config.apiToken
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Add response interceptor for debugging
    this.api.interceptors.response.use(
      response => {
        logger.debug(
          `Jira API: ${response.config.method?.toUpperCase()} ${response.config.url} - ${response.status}`
        );
        return response;
      },
      error => {
        const status = error.response?.status;
        const method = error.config?.method?.toUpperCase();
        const url = error.config?.url;
        logger.debug(`Jira API Error: ${method} ${url} - ${status}: ${error.message}`);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Test authentication with Jira
   * @returns {Promise<Object>} User profile information
   */
  async testAuthentication() {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug('Testing Jira authentication...');
      const response = await this.api.get('/rest/api/3/myself');
      logger.debug(
        `Authenticated as: ${response.data.displayName} (${response.data.emailAddress})`
      );
      return response.data;
    }, 'authentication test');
  }

  /**
   * Search for issues using JQL with pagination
   * @param {string} jql JQL query string
   * @param {Object} options Search options
   * @returns {Promise<Array>} Array of issues
   */
  async searchIssues(jql, options = {}) {
    const {
      maxResults = 50,
      startAt = 0
    } = options;

    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Searching issues with JQL: ${jql}`);

      const payload = {
        jql,
        startAt,
        maxResults,
        fields: ['key', 'summary', 'description', 'status', 'assignee', 'reporter', 'created', 'updated', 'priority', 'issuetype', 'components', 'fixVersions', 'labels', 'parent', 'subtasks', 'attachment', 'comment', 'customfield_10100', 'customfield_10000']
      };
      
      logger.debug(`Request payload: ${JSON.stringify(payload, null, 2)}`);

      try {
        const response = await this.api.post('/rest/api/3/search', payload);

        const {
          issues,
          total,
          startAt: responseStartAt,
          maxResults: responseMaxResults
        } = response.data;

        logger.debug(
          `Found ${issues.length} issues (${responseStartAt + 1}-${responseStartAt + issues.length} of ${total})`
        );

        return {
          issues,
          total,
          startAt: responseStartAt,
          maxResults: responseMaxResults,
          hasMore: responseStartAt + issues.length < total
        };
      } catch (error) {
        // Enhanced error reporting for Jira API errors
        if (error.response) {
          const { status, data } = error.response;
          let errorMessage = `Jira API Error: POST /rest/api/3/search - ${status}`;
          
          if (data) {
            if (data.errorMessages && data.errorMessages.length > 0) {
              errorMessage += `\nError Messages: ${data.errorMessages.join(', ')}`;
            }
            if (data.errors) {
              const errorDetails = Object.entries(data.errors)
                .map(([field, message]) => `${field}: ${message}`)
                .join(', ');
              errorMessage += `\nField Errors: ${errorDetails}`;
            }
            if (data.warningMessages && data.warningMessages.length > 0) {
              errorMessage += `\nWarnings: ${data.warningMessages.join(', ')}`;
            }
          }
          
          logger.error(errorMessage);
          logger.error(`JQL Query: ${jql}`);
          logger.error(`Request payload: ${JSON.stringify(payload, null, 2)}`);
          
          // Create a more informative error
          const enhancedError = new Error(errorMessage);
          enhancedError.originalError = error;
          enhancedError.jql = jql;
          throw enhancedError;
        }
        
        throw error;
      }
    }, 'issue search');
  }

  /**
   * Get all issues matching JQL query with automatic pagination
   * @param {string} jql JQL query string
   * @param {Object} options Search options
   * @returns {Promise<Array>} Array of all matching issues
   */
  async getAllIssues(jql, options = {}) {
    const allIssues = [];
    let startAt = 0;
    const maxResults = options.batchSize || 50;
    let hasMore = true;

    logger.info(`Fetching all issues matching: ${jql}`);

    while (hasMore) {
      const result = await this.searchIssues(jql, {
        ...options,
        startAt,
        maxResults
      });

      allIssues.push(...result.issues);
      startAt += result.maxResults;

      logger.info(`Fetched ${allIssues.length}/${result.total} issues`);

      hasMore = result.hasMore;
    }

    return allIssues;
  }

  /**
   * Get detailed issue information including comments and attachments
   * @param {string} issueKey Issue key (e.g., 'PROJ-123')
   * @returns {Promise<Object>} Detailed issue information
   */
  async getIssue(issueKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching detailed issue: ${issueKey}`);

      const response = await this.api.get(`/rest/api/3/issue/${issueKey}`, {
        params: {
          expand:
            'names,schema,operations,versionedRepresentations,editmeta,changelog,renderedFields,comment,attachment'
        }
      });

      return response.data;
    }, `fetch issue ${issueKey}`);
  }

  /**
   * Get comments for an issue
   * @param {string} issueKey Issue key
   * @returns {Promise<Array>} Array of comments
   */
  async getComments(issueKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching comments for issue: ${issueKey}`);

      const response = await this.api.get(`/rest/api/3/issue/${issueKey}/comment`, {
        params: {
          expand: 'renderedBody'
        }
      });

      return response.data.comments || [];
    }, `fetch comments for ${issueKey}`);
  }

  /**
   * Get attachments for an issue
   * @param {string} issueKey Issue key
   * @returns {Promise<Array>} Array of attachments
   */
  async getAttachments(issueKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching attachments for issue: ${issueKey}`);

      const issue = await this.getIssue(issueKey);
      return issue.fields.attachment || [];
    }, `fetch attachments for ${issueKey}`);
  }

  /**
   * Download attachment content
   * @param {string} attachmentUrl Attachment URL
   * @param {string} filename Attachment filename
   * @returns {Promise<Buffer>} Attachment content as buffer
   */
  async downloadAttachment(attachmentUrl, filename) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Downloading attachment: ${filename}`);

      const response = await this.api.get(attachmentUrl, {
        responseType: 'arraybuffer',
        timeout: 60000 // Longer timeout for file downloads
      });

      return Buffer.from(response.data);
    }, `download attachment ${filename}`);
  }

  /**
   * Get subtasks for an issue, optionally filtered by status
   * @param {string} parentKey Parent issue key
   * @param {Array<string>} statusFilter Array of statuses to include
   * @returns {Promise<Array>} Array of subtask issues
   */
  async getSubtasks(parentKey, statusFilter = []) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching subtasks for parent: ${parentKey}`);

      // First get the parent issue to find subtasks
      const parentIssue = await this.getIssue(parentKey);
      const subtaskIds = parentIssue.fields.subtasks?.map(st => st.key) || [];

      if (subtaskIds.length === 0) {
        logger.debug(`No subtasks found for ${parentKey}`);
        return [];
      }

      // Build JQL to fetch subtasks
      let jql = `key IN (${subtaskIds.map(id => `"${id}"`).join(',')})`;

      // Add status filter if provided
      if (statusFilter.length > 0) {
        const statusList = statusFilter.map(status => `"${status}"`).join(',');
        jql += ` AND status IN (${statusList})`;
      }

      const result = await this.searchIssues(jql, {
        maxResults: 100 // Most issues don't have more than 100 subtasks
      });

      logger.debug(`Found ${result.issues.length} subtasks for ${parentKey}`);
      return result.issues;
    }, `fetch subtasks for ${parentKey}`);
  }

  /**
   * Get issue transitions
   * @param {string} issueKey Issue key
   * @returns {Promise<Array>} Array of available transitions
   */
  async getTransitions(issueKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching transitions for issue: ${issueKey}`);

      const response = await this.api.get(`/rest/api/3/issue/${issueKey}/transitions`);
      return response.data.transitions || [];
    }, `fetch transitions for ${issueKey}`);
  }

  /**
   * Get issue changelog
   * @param {string} issueKey Issue key
   * @returns {Promise<Array>} Array of changelog entries
   */
  async getChangelog(issueKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching changelog for issue: ${issueKey}`);

      const response = await this.api.get(`/rest/api/3/issue/${issueKey}/changelog`);
      return response.data.values || [];
    }, `fetch changelog for ${issueKey}`);
  }

  /**
   * Get project information
   * @param {string} projectKey Project key
   * @returns {Promise<Object>} Project information
   */
  async getProject(projectKey) {
    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug(`Fetching project information: ${projectKey}`);

      const response = await this.api.get(`/rest/api/3/project/${projectKey}`);
      return response.data;
    }, `fetch project ${projectKey}`);
  }

  /**
   * Build JQL query for issues with subtasks
   * @param {Object} config Migration configuration
   * @returns {string} JQL query string
   */
  buildJqlQuery(config) {
    // Just return the base JQL query
    // The subtask filtering will be handled by the filterIssuesByType method
    return config.jira.jql;
  }

  /**
   * Filter subtasks by status configuration
   * @param {Array} issues Array of issues (may include subtasks)
   * @param {Object} config Migration configuration
   * @returns {Object} Object with separated issues and subtasks
   */
  filterIssuesByType(issues, config) {
    const parentIssues = [];
    const subtasks = [];

    for (const issue of issues) {
      if (issue.fields.issuetype?.subtask) {
        // This is a subtask
        if (config.jira.subtasks?.enabled) {
          const statusFilter = config.jira.subtasks.filterByStatus;
          const currentStatus = issue.fields.status?.name;

          if (!statusFilter || statusFilter.length === 0 || statusFilter.includes(currentStatus)) {
            subtasks.push(issue);
          } else {
            logger.debug(`Skipping subtask ${issue.key} due to status filter (${currentStatus})`);
          }
        } else {
          // If subtasks are disabled but the JQL directly returns subtasks,
          // treat them as regular issues to migrate
          logger.debug(`Treating subtask ${issue.key} as a regular issue since it was directly queried`);
          parentIssues.push(issue);
        }
      } else {
        // This is a parent issue
        parentIssues.push(issue);
      }
    }

    logger.info(
      `Filtered issues: ${parentIssues.length} parent issues, ${subtasks.length} subtasks`
    );

    return {
      parentIssues,
      subtasks,
      allIssues: [...parentIssues, ...subtasks]
    };
  }
}

/**
 * Create and configure Jira client
 * @param {Object} config Jira configuration
 * @returns {JiraClient} Configured Jira client instance
 */
export function createJiraClient(config) {
  const client = new JiraClient(config);
  return client;
}
