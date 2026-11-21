// SPDX-License-Identifier: MIT
// Automation tool names and Node MCP SDK structure adapted from
// ProxyShard/ShardBrowser mcp/index.js at 99e780e2e685e5b3b5357c5baee8796e10b3ce1e.
// Copyright (c) 2026 ShardBrowser. See LICENSE.upstream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const connectionId = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim() === value &&
      Array.from(value).every(
        (character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127,
      ),
    'Use an explicit connectionId',
  )
const id = z.string().uuid()
const moduleId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
const object = z.record(z.string(), z.unknown())
const projectPath = (id) => `/automation/projects/${encodeURIComponent(id)}`
const modulePath = (id) => `/automation/modules/${encodeURIComponent(id)}`

const text = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

export function createServer(api) {
  const server = new McpServer({ name: 'raccoon-automation', version: '0.1.0' })
  function tool(name, description, schema, handler) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: { connectionId, ...schema },
      },
      async (args) => {
        try {
          return text(await handler(args))
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  error instanceof Error ? error.message : 'Automation request failed',
              },
            ],
          }
        }
      },
    )
  }

  tool(
    'list_automation_projects',
    "List the Workspace's automation projects, blocks and run settings.",
    {},
    ({ connectionId }) => api('/automation/projects', { connectionId }),
  )
  tool(
    'get_automation_project',
    'Read one project from the specified Workspace.',
    { id },
    ({ connectionId, id }) => api(projectPath(id), { connectionId }),
  )
  tool(
    'create_automation_project',
    'Create an empty project in the specified Workspace.',
    { name: z.string().max(1024).default('') },
    ({ connectionId, name }) =>
      api('/automation/projects', { connectionId, method: 'POST', body: { name } }),
  )
  tool(
    'save_automation_project',
    'Replace the project with its edited payload including the current revision. The path supplies the project UUID.',
    { id, project: object },
    ({ connectionId, id, project }) =>
      api(projectPath(id), { connectionId, method: 'PUT', body: project }),
  )
  tool(
    'delete_automation_project',
    'Permanently delete a project in this Workspace.',
    { id },
    ({ connectionId, id }) => api(projectPath(id), { connectionId, method: 'DELETE' }),
  )
  tool(
    'duplicate_automation_project',
    'Copy a project within its Workspace.',
    { id },
    ({ connectionId, id }) =>
      api(`${projectPath(id)}/duplicate`, { connectionId, method: 'POST' }),
  )
  tool(
    'export_automation_project',
    'Export a versioned bundle with required modules and secret parameters stripped by the Rust service.',
    { id },
    ({ connectionId, id }) => api(`${projectPath(id)}/export`, { connectionId }),
  )
  tool(
    'import_automation_project',
    'Import a bundle as a new project in the specified Workspace. Resolve its binding issues before running.',
    { bundle: object },
    ({ connectionId, bundle }) =>
      api('/automation/import', { connectionId, method: 'POST', body: bundle }),
  )
  tool(
    'run_automation_project',
    'Submit a run using a stable operationId. Reuse that operationId to reconcile the same request after an uncertain result. Poll automation_status for progress.',
    {
      id,
      operationId: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => value.trim().length > 0),
    },
    ({ connectionId, id, operationId }) =>
      api(`${projectPath(id)}/run`, {
        connectionId,
        method: 'POST',
        body: { operationId },
      }),
  )
  tool(
    'reconcile_automation_project',
    'Reconcile interrupted or uncertain runs through the shared service and return the latest state or null. confirmed defaults to false. Set confirmed to true only after the user has inspected browser state and external side effects and explicitly confirmed ending the affected runs.',
    { id, confirmed: z.boolean().default(false) },
    ({ connectionId, id, confirmed }) =>
      api(`${projectPath(id)}/reconcile`, {
        connectionId,
        method: 'POST',
        body: { confirmed },
      }),
  )
  tool(
    'stop_automation_project',
    'Request cancellation through the shared service. Poll status for the final result.',
    { id },
    ({ connectionId, id }) =>
      api(`${projectPath(id)}/stop`, { connectionId, method: 'POST' }),
  )
  tool(
    'automation_status',
    "Read the project's latest persisted run state, including interrupted or uncertain results. Returns null when it has no run.",
    { id },
    ({ connectionId, id }) => api(`${projectPath(id)}/status`, { connectionId }),
  )
  tool(
    'list_automation_runs',
    "Read Fleet's latest persisted run states for this explicit connectionId.",
    {},
    ({ connectionId }) => api('/automation/runs', { connectionId }),
  )
  tool(
    'list_automation_modules',
    'List application-installed WebAssembly modules in a validated Workspace context.',
    {},
    ({ connectionId }) => api('/automation/modules', { connectionId }),
  )
  tool(
    'install_automation_module',
    'Install a WASM file from an absolute path on the Raccoon machine. Module installation affects the application.',
    { path: z.string().min(1) },
    ({ connectionId, path }) =>
      api('/automation/modules', { connectionId, method: 'POST', body: { path } }),
  )
  tool(
    'remove_automation_module',
    'Remove an application-installed module. Projects referencing it may require repair.',
    { id: moduleId },
    ({ connectionId, id }) => api(modulePath(id), { connectionId, method: 'DELETE' }),
  )
  tool(
    'automation_module_permissions',
    "Inspect a module's requested permissions and grants in this Workspace.",
    { id: moduleId },
    ({ connectionId, id }) => api(`${modulePath(id)}/permissions`, { connectionId }),
  )
  tool(
    'grant_automation_module',
    'Set module and flow call grants. Flow IDs must belong to this connectionId.',
    {
      id: moduleId,
      modules: z.array(moduleId),
      flows: z.array(id),
    },
    ({ connectionId, id, modules, flows }) =>
      api(`${modulePath(id)}/grant`, {
        connectionId,
        method: 'POST',
        body: { modules, flows },
      }),
  )
  return server
}
