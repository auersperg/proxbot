#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.ts";
import { createProxbotServer } from "./server.ts";

async function main(): Promise<void> {
  const server = createProxbotServer(loadConfig());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[proxbot-mcp] ${message}\n`);
  process.exitCode = 1;
});
