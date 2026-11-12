import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';

try {
  const server = createMcpServer(await loadConfig());
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void server.close(); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
