#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const provider = process.env.FAKE_BETA_PROVIDER
const scenario = process.env.FAKE_BETA_SCENARIO || 'success'
const log = (record) => appendFileSync(process.env.FAKE_BETA_LOG, JSON.stringify(record) + '\n')
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
log({ kind: 'started', pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() })
assert.deepEqual(process.argv.slice(2), provider === 'kimi' ? ['acp'] : ['agent', '--no-leader', 'stdio'])
process.once('SIGTERM', () => {
  log({ kind: 'closed' })
  process.exit(0)
})
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  log({ kind: 'request', method, params })
  if (method === 'initialize') {
    assert.equal(params.protocolVersion, 1)
    respond(id, {
      protocolVersion: scenario === 'bad-protocol' ? 2 : 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: provider === 'kimi', audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: {
          list: {}, resume: {}, close: {},
          ...(provider === 'kimi' && scenario !== 'missing-fork' ? { fork: scenario === 'malformed-fork' ? [] : {} } : {})
        }
      },
      ...(provider === 'grok' ? { _meta: { agentVersion: '1.0.50' } } : {})
    })
    return
  }
  assert.equal(method, provider === 'kimi' ? 'session/fork' : '_x.ai/session/fork')
  assert.deepEqual(params, provider === 'kimi'
    ? { sessionId: 'fixture-source', cwd: process.env.FAKE_BETA_CWD, mcpServers: [] }
    : { sourceSessionId: 'fixture-source', sourceCwd: process.env.FAKE_BETA_CWD, newCwd: process.env.FAKE_BETA_CWD })
  if (scenario === 'unsupported') return error(id, -32601, 'Method not found')
  if (scenario === 'remote-error') return error(id, -32603, 'Source session not found')
  if (scenario === 'missing-id') return respond(id, {})
  if (scenario === 'null-result') return respond(id, null)
  const sessionId = scenario === 'same-id' ? 'fixture-source' : scenario === 'empty-id' ? '  ' : scenario === 'malformed-id' ? '../fixture-source' : 'fixture-fork'
  if (provider === 'kimi') {
    respond(id, {
      sessionId,
      configOptions: [
        { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'audit-local', options: [{ value: 'audit-local', name: 'audit-local' }] },
        { type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: 'high', options: [{ value: 'off', name: 'Thinking Off' }, { value: 'low', name: 'Thinking Low' }, { value: 'high', name: 'Thinking High' }] },
        { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default', description: 'Manual approvals; tools execute normally.' }, { value: 'plan', name: 'Plan', description: 'Read-only planning; no tool execution.' }, { value: 'auto', name: 'Auto', description: 'Auto-approve safe operations.' }, { value: 'yolo', name: 'YOLO', description: 'Auto-approve everything.' }] }
      ],
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }, { id: 'auto', name: 'Auto' }, { id: 'yolo', name: 'Yolo' }] }
    })
  } else {
    const result = { newSessionId: sessionId, chatMessagesCopied: 2, updatesCopied: 0, planStateCopied: false, newCwd: process.env.FAKE_BETA_CWD, parentSessionId: 'fixture-source' }
    respond(id, scenario === 'nested' ? { result } : result)
  }
})
