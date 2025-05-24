# GitPorter

A powerful CLI tool to migrate Jira Cloud issues to GitHub issues with AI-powered summaries, full attachment support, and comprehensive retry logic.

## Features

✨ **Complete Migration**: Migrates issues, comments, attachments, and metadata  
🤖 **AI Summaries**: Optional OpenAI-powered summaries for better GitHub readability  
📎 **Attachment Handling**: Download & re-upload or link to original Jira attachments  
🔄 **Retry Logic**: Robust error handling with exponential backoff  
📊 **Progress Tracking**: Real-time progress with detailed statistics  
🎯 **Idempotent**: Safe to re-run - skips already migrated issues  
🌵 **Dry Run Mode**: Test your migration without making changes  
🏷️ **Smart Mapping**: Configurable status and label mapping  
📈 **Subtask Support**: Optional subtask migration with status filtering

## Installation

### Global Installation (Recommended)

```bash
npm install -g gitporter
```

After installation, you can run `gitporter` from anywhere in your terminal.

### Local Development

```bash
git clone https://github.com/yourusername/gitporter.git
cd gitporter
npm install
npm link  # Makes the command available globally during development
```

## Quick Start

1. **Create configuration file**:

```bash
# Copy the example configuration
cp config.example.json config.json

# Edit config.json with your credentials
```

2. **Run a dry-run to test**:

```bash
gitporter --dry-run --verbose
```

3. **Execute the migration**:

```bash
gitporter
```

## Authentication Setup

### Jira Cloud API Token

1. Go to [Atlassian Account Settings](https://id.atlassian.com/manage/api-tokens)
2. Click "Create API token"
3. Copy the token and use it in your `config.json`

### GitHub Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Select scopes: `repo`, `write:discussion`
4. Copy the token and use it in your `config.json`

### OpenAI API Key (Optional)

1. Go to [OpenAI API Keys](https://platform.openai.com/api-keys)
2. Create a new secret key
3. Copy the key and use it in your `config.json`

## CLI Options

```bash
gitporter [options]

Options:
  --dry-run              Run without making any API calls to GitHub
  --jql <query>          Override default JQL query for Jira search
  --batch-size <number>  Number of issues to process in each batch (default: 10)
  --config <path>        Path to JSON config file
  -v, --verbose          Enable verbose logging
  -h, --help             Display help information
  --version              Show version number
```

## Configuration

GitPorter uses a JSON configuration file with the following search order:

1. `--config <path>` (if specified)
2. `./config.json` (current directory)
3. `~/.gitporter/config.json` (user's home directory)

### Configuration File

Create a `config.json` file to configure your migration:

```json
{
  "jira": {
    "url": "https://yourcompany.atlassian.net",
    "jql": "project = 'MYPROJ' AND created >= -30d ORDER BY created DESC",
    "subtasks": {
      "enabled": true,
      "filterByStatus": ["To Do", "In Progress", "Testing"]
    }
  },
  "github": {
    "repo": "your-org/your-repo"
  },
  "openai": {
    "model": "gpt-3.5-turbo",
    "maxTokens": 200
  },
  "migration": {
    "batchSize": 10,
    "dryRun": false,
    "verbose": true,
    "statusMapping": {
      "To Do": "open",
      "In Progress": "open",
      "Done": "closed"
    },
    "labelMapping": {
      "Bug": "bug",
      "Story": "feature",
      "Task": "enhancement"
    },
    "attachmentStrategy": "link",
    "includeSummary": true
  }
}
```

### Configuration Options

#### Jira Settings
- `jql`: JQL query to select issues for migration
- `subtasks.enabled`: Whether to include subtasks
- `subtasks.filterByStatus`: Array of statuses to include for subtasks

#### Migration Settings
- `batchSize`: Number of issues to process per batch
- `dryRun`: If true, no GitHub issues will be created
- `verbose`: Enable detailed logging
- `statusMapping`: Map Jira statuses to GitHub states (open/closed)
- `labelMapping`: Map Jira issue types to GitHub labels
- `attachmentStrategy`: How to handle attachments ("link" or "upload")
- `includeSummary`: Whether to generate AI summaries

## Usage Examples

### Basic Migration

```bash
# Migrate all issues from a project
gitporter --jql "project = 'MYPROJ' ORDER BY created DESC"
```

### Dry Run

```bash
# Test migration without making changes
gitporter --dry-run --verbose
```

### Custom Batch Size

```bash
# Process in smaller batches for better control
gitporter --batch-size 5
```

### Recent Issues Only

```bash
# Migrate only recent issues
gitporter --jql "project = 'MYPROJ' AND created >= -7d"
```

### Using Custom Config

```bash
# Use custom configuration file
gitporter --config ./my-migration-config.json
```

### Specific Issue Types

```bash
# Migrate only bugs and stories
gitporter --jql "project = 'MYPROJ' AND issuetype IN ('Bug', 'Story')"
```

## Output Files

GitPorter creates the following files during migration:

- `mapping.json` - Maps Jira issue keys to GitHub issue numbers (for idempotency)
- `.env` - Your environment configuration (if created)

## Troubleshooting

### Common Issues

**Authentication Errors**
```
Error: Request failed with status code 401
```
- Verify your Jira API token and email
- Check that your GitHub token has the correct permissions

**Rate Limiting**
```
Error: Request failed with status code 429
```
- GitPorter has built-in retry logic with exponential backoff
- Reduce batch size if you continue to hit rate limits

**Missing Issues**
- Check your JQL query syntax
- Verify you have permission to access the Jira project
- Use `--verbose` to see detailed API calls

### Debug Mode

Enable verbose logging to see detailed information:

```bash
gitporter --verbose --dry-run
```

### API Rate Limits

- **Jira Cloud**: 10 requests per second per app
- **GitHub**: 5,000 requests per hour for authenticated requests
- **OpenAI**: Varies by plan (free tier: 3 requests per minute)

GitPorter automatically handles rate limiting with exponential backoff retry logic.

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run integration tests only
npm test tests/integration.test.js
```

### Linting and Formatting

```bash
# Check code style
npm run lint

# Fix code style issues
npm run lint:fix

# Format code
npm run format
```

### Project Structure

```
src/
├── cli.js           # CLI entry point and argument parsing
├── jiraClient.js    # Jira API client
├── githubClient.js  # GitHub API client  
├── summarizer.js    # OpenAI integration for summaries
├── migrator.js      # Main migration orchestration
└── utils.js         # Utility functions and helpers

tests/
├── utils.test.js        # Unit tests for utilities
└── integration.test.js  # Integration tests with mocked APIs
```

## Migration Process

GitPorter follows this process for each issue:

1. **Fetch Issues**: Query Jira using your JQL
2. **Filter Subtasks**: Apply status filtering if enabled
3. **Check Existing**: Search GitHub for existing issues
4. **Generate Summary**: Create AI summary if enabled
5. **Convert Content**: Transform Jira markup to Markdown
6. **Create Issue**: Create GitHub issue with metadata
7. **Migrate Comments**: Copy all comments with attribution
8. **Handle Attachments**: Link or upload based on strategy
9. **Update Mapping**: Record the migration for idempotency

## Attachment Strategies

### Link Strategy (Default)
- Attachments remain in Jira
- GitHub issues contain links to original files
- Faster migration, no storage usage
- Requires Jira access to view files

### Upload Strategy
- Downloads attachments from Jira
- Re-uploads as GitHub release assets
- Self-contained in GitHub
- Uses GitHub storage quota

## Best Practices

### Before Migration

1. **Test with dry-run**: Always test your configuration first
2. **Backup data**: Export your Jira project as backup
3. **Plan JQL**: Carefully craft your JQL query to select the right issues
4. **Check permissions**: Ensure API tokens have necessary permissions

### During Migration

1. **Monitor progress**: Use verbose mode to track progress
2. **Handle errors**: Check `mapping.json` for failed migrations
3. **Avoid interruption**: Let the migration complete to maintain data integrity

### After Migration

1. **Verify results**: Spot-check migrated issues in GitHub
2. **Update links**: Replace Jira links in external documentation
3. **Train team**: Ensure team knows about the new GitHub workflow

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and add tests
4. Run tests: `npm test`
5. Commit your changes: `git commit -am 'Add feature'`
6. Push to the branch: `git push origin feature-name`
7. Create a Pull Request

## License

ISC License - see LICENSE file for details.

## Support

- 📖 **Documentation**: See this README and inline code comments
- 🐛 **Bug Reports**: Create an issue on GitHub
- 💬 **Questions**: Start a discussion on GitHub
- 🚀 **Feature Requests**: Create an issue with the "enhancement" label

---

**Happy migrating! 🚀** 