import TurndownService from 'turndown';
import { setTimeout } from 'timers/promises';

/**
 * Logger utility with verbose mode support
 */
class Logger {
  constructor() {
    this.verbose = false;
  }

  setVerbose(verbose) {
    this.verbose = verbose;
  }

  info(message) {
    console.log(`ℹ️  ${message}`);
  }

  warn(message) {
    console.warn(`⚠️  ${message}`);
  }

  error(message) {
    console.error(`❌ ${message}`);
  }

  debug(message) {
    if (this.verbose) {
      console.log(`🐛 ${message}`);
    }
  }

  success(message) {
    console.log(`✅ ${message}`);
  }
}

export const logger = new Logger();

/**
 * Rate limiting and retry utility
 */
export class RateLimiter {
  constructor(maxRetries = 3, baseDelay = 1000) {
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
  }

  /**
   * Execute a function with exponential backoff retry
   * @param {Function} fn Function to execute
   * @param {string} operation Description of the operation for logging
   * @returns {Promise} Result of the function
   */
  async executeWithRetry(fn, operation = 'operation') {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === this.maxRetries) {
          break;
        }

        // Check if it's a rate limit error
        const isRateLimit =
          error.response?.status === 429 ||
          error.message?.includes('rate limit') ||
          error.message?.includes('too many requests');

        if (!isRateLimit && error.response?.status < 500) {
          // Don't retry client errors (4xx) except rate limits
          break;
        }

        const delay = this.baseDelay * Math.pow(2, attempt);
        logger.warn(
          `${operation} failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}`
        );
        logger.debug(`Retrying in ${delay}ms...`);

        await setTimeout(delay);
      }
    }

    throw lastError;
  }
}

/**
 * Markdown conversion utility
 */
export class MarkdownConverter {
  constructor() {
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced'
    });

    // Custom rules for Jira-specific formatting
    this.turndownService.addRule('jiraCode', {
      filter: ['tt'],
      replacement(content) {
        return `\`${content}\``;
      }
    });

    this.turndownService.addRule('jiraPanel', {
      filter(node) {
        return node.nodeName === 'DIV' && node.className.includes('panel');
      },
      replacement(content) {
        const safeContent = typeof content === 'string' ? content : String(content || '');
        return `\n> ${safeContent.replace(/\n/g, '\n> ')}\n`;
      }
    });
  }

  /**
   * Extract text content from Atlassian Document Format (ADF)
   * @param {Object} adfContent ADF content object
   * @returns {string} Extracted text content
   */
  extractTextFromADF(adfContent) {
    if (!adfContent || typeof adfContent !== 'object') {
      return '';
    }

    let text = '';

    // Handle different ADF node types
    if (adfContent.type === 'text') {
      text += adfContent.text || '';
    } else if (adfContent.type === 'hardBreak') {
      text += '\n';
    } else if (adfContent.type === 'paragraph') {
      if (adfContent.content) {
        text += adfContent.content.map(node => this.extractTextFromADF(node)).join('');
        text += '\n\n';
      }
    } else if (adfContent.type === 'orderedList' || adfContent.type === 'bulletList') {
      if (adfContent.content) {
        adfContent.content.forEach((item, index) => {
          const prefix = adfContent.type === 'orderedList' ? `${index + 1}. ` : '- ';
          text += `${prefix + this.extractTextFromADF(item).trim()}\n`;
        });
        text += '\n';
      }
    } else if (adfContent.type === 'listItem') {
      if (adfContent.content) {
        text += adfContent.content.map(node => this.extractTextFromADF(node)).join('').trim();
      }
    } else if (adfContent.type === 'codeBlock') {
      if (adfContent.content) {
        text += '```\n';
        text += adfContent.content.map(node => this.extractTextFromADF(node)).join('');
        text += '\n```\n\n';
      }
    } else if (adfContent.type === 'heading') {
      const level = adfContent.attrs?.level || 1;
      const headingPrefix = `${'#'.repeat(level)} `;
      if (adfContent.content) {
        text += `${headingPrefix + adfContent.content.map(node => this.extractTextFromADF(node)).join('')}\n\n`;
      }
    } else if (adfContent.type === 'media' || adfContent.type === 'mediaSingle' || adfContent.type === 'mediaGroup') {
      // Handle media attachments
      const alt = adfContent.attrs?.alt || 'attachment';
      text += `[${alt}]`;
    } else if (adfContent.content && Array.isArray(adfContent.content)) {
      // Recursively process content array
      text += adfContent.content.map(node => this.extractTextFromADF(node)).join('');
    }

    return text;
  }

  /**
   * Convert Jira wiki markup or HTML to Markdown
   * @param {string} content Content to convert
   * @returns {string} Markdown content
   */
  toMarkdown(content) {
    if (!content) return '';
    
    // Handle Atlassian Document Format (ADF)
    if (typeof content === 'object' && content !== null) {
      if (content.type === 'doc' && content.content) {
        // This is ADF format
        return this.extractTextFromADF(content);
      } else if (content.content || content.body || content.text || content.value) {
        // Try to extract meaningful content from object
        content = content.content || content.body || content.text || content.value || String(content);
      } else {
        content = String(content);
      }
    }
    
    // Ensure content is a string
    if (typeof content !== 'string') {
      content = String(content);
    }

    // First convert common Jira wiki markup to HTML
    const processed = content
      // Bold text
      .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
      // Italic text
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      // Code blocks
      .replace(/\{code(?::([^}]+))?\}([\s\S]*?)\{code\}/g, '<pre><code class="$1">$2</code></pre>')
      // Inline code
      .replace(/\{\{([^}]+)\}\}/g, '<code>$1</code>')
      // Links
      .replace(/\[([^|]+)\|([^\]]+)\]/g, '<a href="$2">$1</a>')
      // Simple links
      .replace(/\[([^\]]+)\]/g, '<a href="$1">$1</a>')
      // Headers
      .replace(/^h([1-6])\.\s*(.+)$/gm, '<h$1>$2</h$1>')
      // Line breaks
      .replace(/\r\n|\r/g, '\n');

    // Convert HTML to Markdown
    return this.turndownService.turndown(processed);
  }
}

/**
 * Status mapping utility
 */
export class StatusMapper {
  constructor(mapping = {}) {
    this.mapping = mapping;
  }

  /**
   * Map Jira status to GitHub state
   * @param {string} jiraStatus Jira status name
   * @returns {string} GitHub state ('open' or 'closed')
   */
  mapStatus(jiraStatus) {
    const mapped = this.mapping[jiraStatus];
    if (mapped) {
      return mapped;
    }

    // Default mapping
    const lowerStatus = jiraStatus.toLowerCase();
    if (
      lowerStatus.includes('done') ||
      lowerStatus.includes('closed') ||
      lowerStatus.includes('resolved') ||
      lowerStatus.includes('complete')
    ) {
      return 'closed';
    }

    return 'open';
  }
}

/**
 * Label mapping utility
 */
export class LabelMapper {
  constructor(mapping = {}) {
    this.mapping = mapping;
  }

  /**
   * Map Jira issue type to GitHub labels
   * @param {Object} jiraIssue Jira issue object
   * @returns {Array<string>} Array of GitHub labels
   */
  mapLabels(jiraIssue) {
    const labels = [];

    // Map issue type
    const issueType = jiraIssue.fields.issuetype?.name;
    if (issueType && this.mapping[issueType]) {
      labels.push(this.mapping[issueType]);
    }

    // Add priority label
    const priority = jiraIssue.fields.priority?.name;
    if (priority) {
      const priorityStr = typeof priority === 'string' ? priority : String(priority);
      labels.push(`priority:${priorityStr.toLowerCase().replace(/\s+/g, '-')}`);
    }

    // Add component labels
    const components = jiraIssue.fields.components || [];
    components.forEach(component => {
      const componentName = typeof component.name === 'string' ? component.name : String(component.name || '');
      if (componentName) {
        labels.push(`component:${componentName.toLowerCase().replace(/\s+/g, '-')}`);
      }
    });

    // Add status label for tracking
    const status = jiraIssue.fields.status?.name;
    if (status) {
      const statusStr = typeof status === 'string' ? status : String(status);
      labels.push(`jira-status:${statusStr.toLowerCase().replace(/\s+/g, '-')}`);
    }

    // Add migration label
    labels.push('migrated-from-jira');

    return labels.filter(Boolean);
  }
}

/**
 * Utility functions for file operations
 */
export const fileUtils = {
  /**
   * Safely read JSON file
   * @param {string} filePath Path to JSON file
   * @returns {Object|null} Parsed JSON or null if file doesn't exist
   */
  async readJsonFile(filePath) {
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  },

  /**
   * Write JSON file with pretty formatting
   * @param {string} filePath Path to write JSON file
   * @param {Object} data Data to write
   */
  async writeJsonFile(filePath, data) {
    const { writeFile } = await import('fs/promises');
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
};

/**
 * Date formatting utilities
 */
export const dateUtils = {
  /**
   * Format Jira date to human readable format
   * @param {string} jiraDate Jira date string
   * @returns {string} Formatted date
   */
  formatJiraDate(jiraDate) {
    if (!jiraDate) return '';
    const date = new Date(jiraDate);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  },

  /**
   * Get relative time string
   * @param {string} dateString Date string
   * @returns {string} Relative time (e.g., "2 hours ago")
   */
  getRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  }
};

/**
 * Text processing utilities
 */
export const textUtils = {
  /**
   * Truncate text to specified length
   * @param {string} text Text to truncate
   * @param {number} maxLength Maximum length
   * @returns {string} Truncated text
   */
  truncate(text, maxLength = 50) {
    if (!text || text.length <= maxLength) return text;
    return `${text.substring(0, maxLength - 3)}...`;
  },

  /**
   * Sanitize text for use in GitHub issue titles
   * @param {string} text Text to sanitize
   * @returns {string} Sanitized text
   */
  sanitizeTitle(text) {
    if (!text) return '';
    return text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 255); // GitHub issue title limit
  },

  /**
   * Extract Jira issue key from text
   * @param {string} text Text that may contain Jira issue key
   * @returns {string|null} Extracted issue key or null
   */
  extractJiraKey(text) {
    const match = text.match(/([A-Z]{2,10}-\d+)/);
    return match ? match[1] : null;
  }
};
