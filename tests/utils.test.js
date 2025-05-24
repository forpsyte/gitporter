import { jest } from '@jest/globals';
import {
  logger,
  RateLimiter,
  MarkdownConverter,
  StatusMapper,
  LabelMapper,
  dateUtils,
  textUtils
} from '../src/utils.js';

describe('Logger', () => {
  beforeEach(() => {
    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should log info messages', () => {
    logger.info('Test message');
    expect(console.log).toHaveBeenCalledWith('ℹ️  Test message');
  });

  test('should log debug messages when verbose is enabled', () => {
    logger.setVerbose(true);
    logger.debug('Debug message');
    expect(console.log).toHaveBeenCalledWith('🐛 Debug message');
  });

  test('should not log debug messages when verbose is disabled', () => {
    logger.setVerbose(false);
    logger.debug('Debug message');
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('RateLimiter', () => {
  test('should execute function successfully on first try', async () => {
    const rateLimiter = new RateLimiter(3, 100);
    const mockFn = jest.fn().mockResolvedValue('success');

    const result = await rateLimiter.executeWithRetry(mockFn, 'test operation');

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test('should retry on rate limit error', async () => {
    const rateLimiter = new RateLimiter(2, 50);
    const mockFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValue('success');

    const result = await rateLimiter.executeWithRetry(mockFn, 'test operation');

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  test('should fail after max retries', async () => {
    const rateLimiter = new RateLimiter(1, 10);
    const mockFn = jest.fn().mockRejectedValue(new Error('persistent error'));

    await expect(rateLimiter.executeWithRetry(mockFn, 'test operation')).rejects.toThrow(
      'persistent error'
    );

    expect(mockFn).toHaveBeenCalledTimes(2); // Initial + 1 retry
  });
});

describe('MarkdownConverter', () => {
  let converter;

  beforeEach(() => {
    converter = new MarkdownConverter();
  });

  test('should convert Jira wiki bold text', () => {
    const result = converter.toMarkdown('*bold text*');
    expect(result).toContain('**bold text**');
  });

  test('should convert Jira wiki italic text', () => {
    const result = converter.toMarkdown('_italic text_');
    expect(result).toContain('_italic text_');
  });

  test('should convert Jira code blocks', () => {
    const input = '{code:java}System.out.println("Hello");{code}';
    const result = converter.toMarkdown(input);
    expect(result).toContain('```');
    expect(result).toContain('System.out.println("Hello");');
  });

  test('should convert Jira inline code', () => {
    const result = converter.toMarkdown('{{inline code}}');
    expect(result).toContain('`inline code`');
  });

  test('should handle empty content', () => {
    expect(converter.toMarkdown('')).toBe('');
    expect(converter.toMarkdown(null)).toBe('');
    expect(converter.toMarkdown(undefined)).toBe('');
  });
});

describe('StatusMapper', () => {
  test('should map status using custom mapping', () => {
    const mapper = new StatusMapper({
      'In Progress': 'open',
      Done: 'closed'
    });

    expect(mapper.mapStatus('In Progress')).toBe('open');
    expect(mapper.mapStatus('Done')).toBe('closed');
  });

  test('should use default mapping for unmapped statuses', () => {
    const mapper = new StatusMapper({});

    expect(mapper.mapStatus('Closed')).toBe('closed');
    expect(mapper.mapStatus('Resolved')).toBe('closed');
    expect(mapper.mapStatus('Complete')).toBe('closed');
    expect(mapper.mapStatus('To Do')).toBe('open');
    expect(mapper.mapStatus('In Progress')).toBe('open');
  });
});

describe('LabelMapper', () => {
  test('should map issue type to label', () => {
    const mapper = new LabelMapper({
      Bug: 'bug',
      Story: 'feature'
    });

    const jiraIssue = {
      fields: {
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        components: [{ name: 'Frontend' }],
        status: { name: 'In Progress' }
      }
    };

    const labels = mapper.mapLabels(jiraIssue);

    expect(labels).toContain('bug');
    expect(labels).toContain('priority:high');
    expect(labels).toContain('component:frontend');
    expect(labels).toContain('jira-status:in-progress');
    expect(labels).toContain('migrated-from-jira');
  });

  test('should handle missing fields gracefully', () => {
    const mapper = new LabelMapper({});

    const jiraIssue = {
      fields: {}
    };

    const labels = mapper.mapLabels(jiraIssue);
    expect(labels).toContain('migrated-from-jira');
  });
});

describe('dateUtils', () => {
  test('should format Jira date correctly', () => {
    const jiraDate = '2023-10-15T14:30:00.000+0000';
    const formatted = dateUtils.formatJiraDate(jiraDate);

    expect(formatted).toMatch(/October 15, 2023/);
  });

  test('should handle empty date', () => {
    expect(dateUtils.formatJiraDate('')).toBe('');
    expect(dateUtils.formatJiraDate(null)).toBe('');
  });

  test('should calculate relative time', () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const result = dateUtils.getRelativeTime(yesterday.toISOString());
    expect(result).toBe('yesterday');
  });
});

describe('textUtils', () => {
  test('should truncate text correctly', () => {
    const longText = 'This is a very long text that should be truncated';
    const result = textUtils.truncate(longText, 20);

    expect(result).toBe('This is a very lo...');
    expect(result.length).toBe(20);
  });

  test('should not truncate short text', () => {
    const shortText = 'Short';
    const result = textUtils.truncate(shortText, 20);

    expect(result).toBe('Short');
  });

  test('should sanitize title for GitHub', () => {
    const title = 'Multi\nLine\nTitle\twith\ttabs';
    const result = textUtils.sanitizeTitle(title);

    expect(result).toBe('Multi Line Title with tabs');
  });

  test('should extract Jira key from text', () => {
    const text = 'This is related to PROJ-123 and TEAM-456';
    const result = textUtils.extractJiraKey(text);

    expect(result).toBe('PROJ-123');
  });

  test('should return null if no Jira key found', () => {
    const text = 'No Jira key here';
    const result = textUtils.extractJiraKey(text);

    expect(result).toBeNull();
  });
});
