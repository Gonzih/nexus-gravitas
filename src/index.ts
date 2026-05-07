import { runMigrations } from './db.js';
import { startMcpServer } from './mcp.js';

async function main(): Promise<void> {
  try {
    await runMigrations();
  } catch (err) {
    console.error('Failed to run database migrations:', err);
    process.exit(1);
  }

  try {
    await startMcpServer();
  } catch (err) {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
