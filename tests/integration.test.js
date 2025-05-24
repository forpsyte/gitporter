import { jest } from '@jest/globals';

// Mock ora spinner
jest.unstable_mockModule('ora', () => ({
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: ''
  }))
}));

// Mock the clients before importing the migrator
const mockJiraClientInstance = {
  testAuthentication: jest
    .fn()
    .mockResolvedValue({ displayName: 'Test User', emailAddress: 'test@example.com' }),
  buildJqlQuery: jest.fn().mockReturnValue('project = "TEST" ORDER BY created DESC'),
  getAllIssues: jest.fn().mockResolvedValue([]),
  filterIssuesByType: jest.fn((issues, config) => {
    // Simulate the actual filterIssuesByType logic for testing
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
          }
        }
      } else {
        // This is a parent issue
        parentIssues.push(issue);
      }
    }

    return {
      parentIssues,
      subtasks,
      allIssues: [...parentIssues, ...subtasks]
    };
  }),
  searchIssues: jest.fn(),
  getComments: jest.fn().mockResolvedValue([])
};

const mockGitHubClientInstance = {
  testAuthentication: jest.fn().mockResolvedValue({ login: 'testuser', name: 'Test User' }),
  testRepositoryAccess: jest.fn().mockResolvedValue({ full_name: 'testowner/testrepo' }),
  findExistingIssue: jest.fn().mockResolvedValue(null),
  createIssue: jest
    .fn()
    .mockResolvedValue({ number: 1, html_url: 'https://github.com/testowner/testrepo/issues/1' }),
  createComment: jest.fn().mockResolvedValue({ id: 1 }),
  ensureLabelsExist: jest.fn().mockResolvedValue(),
  handleAttachments: jest.fn().mockResolvedValue('')
};

jest.unstable_mockModule('../src/jiraClient.js', () => ({
  createJiraClient: jest.fn(() => mockJiraClientInstance)
}));

jest.unstable_mockModule('../src/githubClient.js', () => ({
  createGitHubClient: jest.fn(() => mockGitHubClientInstance)
}));

// Mock file utilities and other dependencies
jest.unstable_mockModule('../src/utils.js', () => {
  return {
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      success: jest.fn()
    },
    MarkdownConverter: jest.fn().mockImplementation(() => ({
      toMarkdown: jest.fn().mockReturnValue('converted markdown')
    })),
    StatusMapper: jest.fn().mockImplementation(() => ({
      mapStatus: jest.fn().mockReturnValue('open')
    })),
    LabelMapper: jest.fn().mockImplementation(() => ({
      mapLabels: jest.fn().mockReturnValue(['bug'])
    })),
    fileUtils: {
      readJsonFile: jest.fn().mockResolvedValue(null),
      writeJsonFile: jest.fn().mockResolvedValue()
    },
    dateUtils: {
      formatJiraDate: jest.fn().mockReturnValue('2023-10-01T10:00:00Z')
    },
    textUtils: {
      sanitizeTitle: jest.fn().mockImplementation(title => title)
    }
  };
});

// Mock summarizer
jest.unstable_mockModule('../src/summarizer.js', () => ({
  createSummarizer: jest.fn(() => ({
    isAvailable: jest.fn().mockReturnValue(false),
    testConnection: jest.fn().mockResolvedValue(false),
    summarizeIssuesBatch: jest.fn().mockResolvedValue({}),
    formatSummaryForGitHub: jest.fn().mockReturnValue('')
  }))
}));

const { migrator } = await import('../src/migrator.js');

// Mock environment variables
process.env.JIRA_URL = 'https://test.atlassian.net';
process.env.JIRA_EMAIL = 'test@example.com';
process.env.JIRA_API_TOKEN = 'test-token';
process.env.GH_TOKEN = 'test-gh-token';
process.env.GH_REPO = 'testowner/testrepo';

describe('Integration Test - Dry Run Migration', () => {
  let mockConfig;

  beforeEach(async () => {
    // Reset all mocks before each test
    jest.clearAllMocks();

    // Reset the mock implementations to their default state
    mockJiraClientInstance.testAuthentication.mockResolvedValue({
      displayName: 'Test User',
      emailAddress: 'test@example.com'
    });
    mockJiraClientInstance.getAllIssues.mockResolvedValue([]);
    mockGitHubClientInstance.findExistingIssue.mockResolvedValue(null);

    // Configure for dry run
    mockConfig = {
      jira: {
        url: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token',
        jql: 'project = "TEST" ORDER BY created DESC',
        subtasks: {
          enabled: true,
          filterByStatus: ['To Do', 'In Progress', 'Done']
        }
      },
      github: {
        token: 'test-gh-token',
        repo: 'testowner/testrepo'
      },
      openai: {
        apiKey: null // Disable AI for integration test
      },
      migration: {
        batchSize: 5,
        dryRun: true, // Important: dry run mode
        verbose: false,
        statusMapping: {
          'To Do': 'open',
          'In Progress': 'open',
          Done: 'closed'
        },
        labelMapping: {
          Bug: 'bug',
          Story: 'feature',
          Task: 'enhancement'
        },
        attachmentStrategy: 'link',
        includeSummary: false
      }
    };

    // Mock console methods to avoid noise in tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should perform complete dry run migration', async () => {
    // Mock Jira issue search
    const mockJiraIssues = [
      {
        key: 'TEST-1',
        fields: {
          summary: 'Test Bug Issue',
          description: 'This is a test bug description with *bold* text.',
          issuetype: { name: 'Bug', subtask: false },
          status: { name: 'To Do' },
          priority: { name: 'High' },
          reporter: { displayName: 'John Doe' },
          assignee: { displayName: 'Jane Smith' },
          created: '2023-10-01T10:00:00.000+0000',
          updated: '2023-10-02T11:00:00.000+0000',
          components: [{ name: 'Frontend' }],
          fixVersions: [{ name: '1.0.0' }],
          attachment: [],
          subtasks: []
        }
      },
      {
        key: 'TEST-2',
        fields: {
          summary: 'Test Story Issue',
          description: 'This is a test story with {code}some code{code}.',
          issuetype: { name: 'Story', subtask: false },
          status: { name: 'Done' },
          priority: { name: 'Medium' },
          reporter: { displayName: 'Alice Johnson' },
          assignee: null,
          created: '2023-10-03T09:00:00.000+0000',
          updated: '2023-10-04T10:00:00.000+0000',
          components: [],
          fixVersions: [],
          attachment: [
            {
              filename: 'test-document.pdf',
              content: 'https://test.atlassian.net/secure/attachment/12345/test-document.pdf',
              size: 102400,
              mimeType: 'application/pdf'
            }
          ],
          subtasks: []
        }
      }
    ];

    mockJiraClientInstance.getAllIssues.mockResolvedValue(mockJiraIssues);

    // Execute migration
    const result = await migrator.migrate(mockConfig);

    // Verify results
    expect(result).toBeDefined();
    expect(result.processed).toBe(2);
    expect(result.created).toBe(2); // In dry run, this counts "would create"
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    // Verify client methods were called
    expect(mockJiraClientInstance.testAuthentication).toHaveBeenCalled();
    expect(mockGitHubClientInstance.testAuthentication).toHaveBeenCalled();
    expect(mockJiraClientInstance.getAllIssues).toHaveBeenCalled();
  });

  test('should handle API errors gracefully', async () => {
    // Mock Jira authentication failure
    mockJiraClientInstance.testAuthentication.mockRejectedValue(new Error('Unauthorized'));

    // Execute migration and expect it to fail
    await expect(migrator.migrate(mockConfig)).rejects.toThrow();
  });

  test('should skip existing issues', async () => {
    // Mock Jira issue search
    mockJiraClientInstance.getAllIssues.mockResolvedValue([
      {
        key: 'TEST-1',
        fields: {
          summary: 'Existing Issue',
          description: 'This issue already exists',
          issuetype: { name: 'Bug', subtask: false },
          status: { name: 'To Do' },
          priority: { name: 'High' },
          reporter: { displayName: 'John Doe' },
          assignee: null,
          created: '2023-10-01T10:00:00.000+0000',
          updated: '2023-10-02T11:00:00.000+0000',
          components: [],
          fixVersions: [],
          attachment: [],
          subtasks: []
        }
      }
    ]);

    // Mock GitHub search returning existing issue
    mockGitHubClientInstance.findExistingIssue.mockResolvedValue({
      number: 42,
      title: '[TEST-1] Existing Issue',
      body: 'Issue body containing TEST-1',
      html_url: 'https://github.com/testowner/testrepo/issues/42'
    });

    // Execute migration
    const result = await migrator.migrate(mockConfig);

    // Verify results
    expect(result.processed).toBe(1);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('should handle subtask filtering', async () => {
    // Update config to test subtask filtering
    const subtaskConfig = {
      ...mockConfig,
      jira: {
        ...mockConfig.jira,
        subtasks: {
          enabled: true,
          filterByStatus: ['In Progress'] // Only process subtasks with this status
        }
      }
    };

    // Mock Jira search with parent and subtasks
    const mockIssuesWithSubtasks = [
      {
        key: 'TEST-1',
        fields: {
          summary: 'Parent Issue',
          description: 'Parent issue description',
          issuetype: { name: 'Epic', subtask: false },
          status: { name: 'In Progress' },
          priority: { name: 'High' },
          reporter: { displayName: 'John Doe' },
          assignee: null,
          created: '2023-10-01T10:00:00.000+0000',
          updated: '2023-10-02T11:00:00.000+0000',
          components: [],
          fixVersions: [],
          attachment: [],
          subtasks: []
        }
      },
      {
        key: 'TEST-2',
        fields: {
          summary: 'Subtask In Progress',
          description: 'Subtask that should be included',
          issuetype: { name: 'Sub-task', subtask: true },
          status: { name: 'In Progress' },
          priority: { name: 'Medium' },
          reporter: { displayName: 'Jane Smith' },
          assignee: null,
          created: '2023-10-01T11:00:00.000+0000',
          updated: '2023-10-02T12:00:00.000+0000',
          components: [],
          fixVersions: [],
          attachment: [],
          subtasks: []
        }
      },
      {
        key: 'TEST-3',
        fields: {
          summary: 'Subtask Done',
          description: 'Subtask that should be filtered out',
          issuetype: { name: 'Sub-task', subtask: true },
          status: { name: 'Done' },
          priority: { name: 'Low' },
          reporter: { displayName: 'Bob Wilson' },
          assignee: null,
          created: '2023-10-01T12:00:00.000+0000',
          updated: '2023-10-02T13:00:00.000+0000',
          components: [],
          fixVersions: [],
          attachment: [],
          subtasks: []
        }
      }
    ];

    mockJiraClientInstance.getAllIssues.mockResolvedValue(mockIssuesWithSubtasks);

    // Execute migration
    const result = await migrator.migrate(subtaskConfig);

    // Should process parent + 1 subtask (TEST-3 filtered out due to status)
    expect(result.processed).toBe(2);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe('Mock Data Validation', () => {
  test('should validate mock Jira issue structure', () => {
    const mockIssue = {
      key: 'TEST-1',
      fields: {
        summary: 'Test Issue',
        description: 'Test description',
        issuetype: { name: 'Bug', subtask: false },
        status: { name: 'To Do' },
        priority: { name: 'High' },
        reporter: { displayName: 'John Doe' },
        assignee: { displayName: 'Jane Smith' },
        created: '2023-10-01T10:00:00.000+0000',
        updated: '2023-10-02T11:00:00.000+0000',
        components: [],
        fixVersions: [],
        attachment: [],
        subtasks: []
      }
    };

    // Validate required fields
    expect(mockIssue.key).toBeDefined();
    expect(mockIssue.fields.summary).toBeDefined();
    expect(mockIssue.fields.issuetype).toBeDefined();
    expect(mockIssue.fields.status).toBeDefined();
    expect(mockIssue.fields.created).toBeDefined();
  });
});
