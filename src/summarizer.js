import OpenAI from 'openai';
import { logger, RateLimiter } from './utils.js';

/**
 * AI-powered summarizer using OpenAI
 */
export class Summarizer {
  constructor(config) {
    this.config = config;
    this.rateLimiter = new RateLimiter();

    // Initialize OpenAI client
    if (config.apiKey) {
      this.openai = new OpenAI({
        apiKey: config.apiKey
      });
    } else {
      logger.warn('OpenAI API key not provided. Summaries will be disabled.');
      this.openai = null;
    }
  }

  /**
   * Check if summarizer is available
   * @returns {boolean} True if OpenAI client is configured
   */
  isAvailable() {
    return this.openai !== null;
  }

  /**
   * Generate a concise summary of the given text
   * @param {string} text Text to summarize
   * @param {Object} options Summary options
   * @returns {Promise<string>} Generated summary
   */
  async generateSummary(text, options = {}) {
    if (!this.isAvailable()) {
      logger.debug('OpenAI not available, skipping summary generation');
      return null;
    }

    if (!text || text.trim().length === 0) {
      return null;
    }

    const {
      maxTokens = this.config.maxTokens || 200,
      model = this.config.model || 'gpt-3.5-turbo',
      temperature = 0.3
    } = options;

    return this.rateLimiter.executeWithRetry(async () => {
      logger.debug('Generating AI summary...');

      const prompt = this.buildSummaryPrompt(text);

      const response = await this.openai.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant that creates concise, clear summaries of Jira issues for GitHub migration. Focus on the key problem, solution, and important details.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: maxTokens,
        temperature,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
      });

      const summary = response.choices[0]?.message?.content?.trim();

      if (summary) {
        logger.debug(`Generated summary (${summary.length} chars)`);
        return summary;
      } else {
        logger.warn('OpenAI returned empty summary');
        return null;
      }
    }, 'generate AI summary');
  }

  /**
   * Build a prompt for summarizing Jira issue content
   * @param {string} text Original issue text
   * @returns {string} Formatted prompt
   */
  buildSummaryPrompt(text) {
    // Clean up the text for better summarization
    const cleanedText = this.cleanTextForSummary(text);

    return `Please provide a concise summary of this Jira issue in 2-3 sentences. Focus on:
1. What is the main problem or requirement?
2. What solution or approach is described?
3. Any important technical details or constraints

Issue content:
${cleanedText}

Summary:`;
  }

  /**
   * Clean and prepare text for summarization
   * @param {string} text Raw text from Jira
   * @returns {string} Cleaned text
   */
  cleanTextForSummary(text) {
    if (!text) return '';

    // Ensure text is a string
    const safeText = typeof text === 'string' ? text : String(text);

    return (
      safeText
        // Remove excessive whitespace
        .replace(/\s+/g, ' ')
        // Remove markdown artifacts that might confuse the AI
        .replace(/\*{2,}/g, '')
        .replace(/_{2,}/g, '')
        // Limit length to avoid token limits
        .substring(0, 4000)
        .trim()
    );
  }

  /**
   * Generate summary for a Jira issue
   * @param {Object} jiraIssue Jira issue object
   * @returns {Promise<string|null>} Generated summary or null
   */
  async summarizeJiraIssue(jiraIssue) {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      // Combine title and description for summarization
      const title = jiraIssue.fields.summary || '';
      const description =
        jiraIssue.fields.description || jiraIssue.renderedFields?.description || '';

      // If there's no substantial content, skip summarization
      if (title.length + description.length < 50) {
        logger.debug(`Skipping summary for ${jiraIssue.key} - insufficient content`);
        return null;
      }

      const combinedText = `Title: ${title}\n\nDescription: ${description}`;

      const summary = await this.generateSummary(combinedText, {
        maxTokens: this.config.maxTokens || 150
      });

      if (summary) {
        logger.debug(`Generated summary for ${jiraIssue.key}`);
      }

      return summary;
    } catch (error) {
      logger.warn(`Failed to generate summary for ${jiraIssue.key}: ${error.message}`);
      return null;
    }
  }

  /**
   * Generate summaries for multiple issues in batch
   * @param {Array} jiraIssues Array of Jira issues
   * @param {Object} options Batch options
   * @returns {Promise<Object>} Map of issue keys to summaries
   */
  async summarizeIssuesBatch(jiraIssues, options = {}) {
    if (!this.isAvailable()) {
      return {};
    }

    const {
      concurrency = 3, // Number of concurrent requests to OpenAI
      delay = 1000 // Delay between batches in ms
    } = options;

    const summaries = {};
    const chunks = this.chunkArray(jiraIssues, concurrency);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.debug(`Processing summary batch ${i + 1}/${chunks.length} (${chunk.length} issues)`);

      // Process chunk in parallel
      const chunkPromises = chunk.map(async issue => {
        const summary = await this.summarizeJiraIssue(issue);
        if (summary) {
          summaries[issue.key] = summary;
        }
      });

      await Promise.all(chunkPromises);

      // Add delay between batches to respect rate limits
      if (i < chunks.length - 1 && delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.info(
      `Generated ${Object.keys(summaries).length} summaries for ${jiraIssues.length} issues`
    );
    return summaries;
  }

  /**
   * Format summary for inclusion in GitHub issue
   * @param {string} summary Generated summary
   * @param {string} jiraKey Jira issue key
   * @returns {string} Formatted summary markdown
   */
  formatSummaryForGitHub(summary, jiraKey) {
    if (!summary) return '';

    // Ensure summary is a string
    const safeSummary = typeof summary === 'string' ? summary : String(summary);

    return `> **🤖 AI Summary**
> ${safeSummary.replace(/\n/g, '\n> ')}
> 
> *Generated summary for ${jiraKey}*

---

`;
  }

  /**
   * Test OpenAI connection and configuration
   * @returns {Promise<boolean>} True if connection is successful
   */
  async testConnection() {
    if (!this.isAvailable()) {
      logger.warn('OpenAI API key not configured');
      return false;
    }

    try {
      logger.debug('Testing OpenAI connection...');

      const testResponse = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: 'Test message - please respond with "OK"'
          }
        ],
        max_tokens: 10
      });

      const response = testResponse.choices[0]?.message?.content?.trim();

      if (response) {
        logger.debug('OpenAI connection test successful');
        return true;
      } else {
        logger.warn('OpenAI connection test failed - empty response');
        return false;
      }
    } catch (error) {
      logger.warn(`OpenAI connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get usage statistics from the last API call
   * @returns {Object|null} Usage statistics or null
   */
  getLastUsageStats() {
    // This would need to be implemented if you want to track token usage
    // The OpenAI response includes usage information
    return null;
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
}

/**
 * Create and configure summarizer
 * @param {Object} config OpenAI configuration
 * @returns {Summarizer} Configured summarizer instance
 */
export function createSummarizer(config) {
  return new Summarizer(config);
}
