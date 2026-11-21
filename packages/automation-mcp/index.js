#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createApiClient } from './client.js'
import { createServer } from './server.js'

try {
  const api = createApiClient({
    endpoint: process.env.RACCOON_AUTOMATION_API,
    token: process.env.RACCOON_AUTOMATION_TOKEN,
  })
  await createServer(api).connect(new StdioServerTransport())
} catch {
  // Configuration values may contain credentials. Keep stdout reserved for MCP.
  console.error(
    'Raccoon automation MCP could not start. Check its loopback API URL and desktop-issued token.',
  )
  process.exitCode = 1
}
