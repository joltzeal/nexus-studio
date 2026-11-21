import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../server.js'

test('MCP tools enforce connectionId and route the full automation surface', async () => {
  const calls = []
  const server = createServer(async (path, options) => {
    calls.push({ path, ...options })
    return { ok: true }
  })
  const client = new Client({ name: 'raccoon-automation-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 18)
    for (const tool of tools) {
      assert.ok(tool.inputSchema.required.includes('connectionId'), tool.name)
    }
    const missingScope = await client.callTool({
      name: 'list_automation_projects',
      arguments: {},
    })
    assert.equal(missingScope.isError, true)
    assert.equal(calls.length, 0)

    const id = '11111111-1111-4111-8111-111111111111'
    const connectionId = 'connection-a'
    const cases = [
      ['list_automation_projects', {}, '/automation/projects', 'GET'],
      ['get_automation_project', { id }, `/automation/projects/${id}`, 'GET'],
      ['create_automation_project', { name: 'Project' }, '/automation/projects', 'POST'],
      [
        'save_automation_project',
        { id, project: { name: 'Edited' } },
        `/automation/projects/${id}`,
        'PUT',
      ],
      ['delete_automation_project', { id }, `/automation/projects/${id}`, 'DELETE'],
      [
        'duplicate_automation_project',
        { id },
        `/automation/projects/${id}/duplicate`,
        'POST',
      ],
      ['export_automation_project', { id }, `/automation/projects/${id}/export`, 'GET'],
      [
        'import_automation_project',
        { bundle: { format: 1 } },
        '/automation/import',
        'POST',
      ],
      [
        'run_automation_project',
        { id, operationId: 'operation-1' },
        `/automation/projects/${id}/run`,
        'POST',
      ],
      ['stop_automation_project', { id }, `/automation/projects/${id}/stop`, 'POST'],
      [
        'reconcile_automation_project',
        { id },
        `/automation/projects/${id}/reconcile`,
        'POST',
      ],
      ['automation_status', { id }, `/automation/projects/${id}/status`, 'GET'],
      ['list_automation_runs', {}, '/automation/runs', 'GET'],
      ['list_automation_modules', {}, '/automation/modules', 'GET'],
      [
        'install_automation_module',
        { path: '/controlled/module.wasm' },
        '/automation/modules',
        'POST',
      ],
      [
        'remove_automation_module',
        { id: 'module-a' },
        '/automation/modules/module-a',
        'DELETE',
      ],
      [
        'automation_module_permissions',
        { id: 'module-a' },
        '/automation/modules/module-a/permissions',
        'GET',
      ],
      [
        'grant_automation_module',
        { id: 'module-a', modules: [], flows: [id] },
        '/automation/modules/module-a/grant',
        'POST',
      ],
    ]
    for (const [name, args, path, method] of cases) {
      const result = await client.callTool({ name, arguments: { connectionId, ...args } })
      assert.equal(result.isError, undefined, name)
      const call = calls.at(-1)
      assert.equal(call.path, path, name)
      assert.equal(call.method ?? 'GET', method, name)
      assert.equal(call.connectionId, connectionId, name)
    }
    assert.deepEqual(calls.find((call) => call.path.endsWith('/run')).body, {
      operationId: 'operation-1',
    })
    assert.deepEqual(calls.find((call) => call.path.endsWith('/reconcile')).body, {
      confirmed: false,
    })
    const missingOperation = await client.callTool({
      name: 'run_automation_project',
      arguments: { connectionId, id },
    })
    assert.equal(missingOperation.isError, true)
    assert.equal(calls.length, cases.length)
    const confirmed = await client.callTool({
      name: 'reconcile_automation_project',
      arguments: { connectionId, id, confirmed: true },
    })
    assert.equal(confirmed.isError, undefined)
    assert.deepEqual(calls.at(-1), {
      path: `/automation/projects/${id}/reconcile`,
      connectionId,
      method: 'POST',
      body: { confirmed: true },
    })
    const invalidConfirmation = await client.callTool({
      name: 'reconcile_automation_project',
      arguments: { connectionId, id, confirmed: 'true' },
    })
    assert.equal(invalidConfirmation.isError, true)
    assert.equal(calls.length, cases.length + 1)
    await client.callTool({
      name: 'list_automation_projects',
      arguments: { connectionId: 'connection-b' },
    })
    assert.equal(calls.at(-1).connectionId, 'connection-b')
  } finally {
    await client.close()
    await server.close()
  }
})

test('service refusals remain MCP tool errors', async () => {
  const server = createServer(async () => {
    throw new Error('operation_uncertain: reconcile the original intent')
  })
  const client = new Client({ name: 'error-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({
      name: 'list_automation_runs',
      arguments: { connectionId: 'connection-a' },
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /operation_uncertain/)
  } finally {
    await client.close()
    await server.close()
  }
})

test('reconciliation preserves service state, null results and pending errors', async () => {
  const state = { connectionId: 'connection-a', status: 'interrupted', running: false }
  const results = [state, null, new Error('operation_pending: engine is stopping')]
  const server = createServer(async () => {
    const result = results.shift()
    if (result instanceof Error) throw result
    return result
  })
  const client = new Client({ name: 'reconcile-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const args = {
      connectionId: 'connection-a',
      id: '11111111-1111-4111-8111-111111111111',
    }
    for (const expected of [state, null]) {
      const result = await client.callTool({
        name: 'reconcile_automation_project',
        arguments: args,
      })
      assert.equal(result.isError, undefined)
      assert.deepEqual(JSON.parse(result.content[0].text), expected)
    }
    const pending = await client.callTool({
      name: 'reconcile_automation_project',
      arguments: args,
    })
    assert.equal(pending.isError, true)
    assert.match(pending.content[0].text, /operation_pending/)
  } finally {
    await client.close()
    await server.close()
  }
})
