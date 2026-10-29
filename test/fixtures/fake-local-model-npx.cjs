#!/usr/bin/env node
const { appendFileSync } = require('node:fs')

const args = process.argv.slice(2)
if (process.env.LOCAL_MODEL_ARGS_FILE) {
  appendFileSync(process.env.LOCAL_MODEL_ARGS_FILE, `${JSON.stringify(args)}\n`)
}

const packageIndex = args.indexOf('@bytedance-dev/bonsai-codex@0.3.3')
const commandArgs = args.slice(packageIndex + 1)
const command = commandArgs[0]
const model = commandArgs[commandArgs.indexOf('--model') + 1]
const protocolVersion = Number(process.env.LOCAL_MODEL_PROTOCOL || 2)
const catalogEntry = {
  slug: 'bonsai-2:27b-pq2',
  display_name: 'Bonsai 2 27B PQ2',
  context_window: 262144,
  auto_compact_token_limit: 220000,
  default_reasoning_level: 'low',
  supported_reasoning_levels: [
    { effort: 'low', description: '低' },
    { effort: 'medium', description: '中' },
    { effort: 'xhigh', description: '高' }
  ]
}

if (process.env.LOCAL_MODEL_QUERY_ERROR && command === 'status') {
  process.stdout.write(JSON.stringify({ type: 'error', ok: false, code: 'state_unreadable', stage: 'status', message: 'state file unreadable', recoverable: true }) + '\n')
  process.exitCode = 1
} else if (command === 'catalog') {
  process.stdout.write(JSON.stringify({
    protocolVersion,
    defaultModelId: 'bonsai-2:27b-pq2',
    models: [{
      id: 'bonsai-2:27b-pq2', displayName: 'Bonsai 2 27B PQ2', parameterCount: '27B',
      quantization: 'PQ2', sizeBytes: 7206168928, runtimeSizeBytes: 11517506,
      memoryBytes: 17179869184, freeDiskBytes: 12884901888, nodeMajor: 20,
      contextWindow: 262144, autoCompactTokenLimit: 220000, defaultReasoning: 'low',
      reasoning: { low: 'low', medium: 'medium', high: 'xhigh' }, catalogEntry
    }]
  }) + '\n')
} else if (command === 'status') {
  process.stdout.write(JSON.stringify({
    protocolVersion,
    packageVersion: '0.3.2',
    supported: true,
    activeModelId: process.env.LOCAL_MODEL_ENDPOINT ? 'bonsai-2:27b-pq2' : null,
    connection: process.env.LOCAL_MODEL_ENDPOINT ? { providerId: 'bonsai-local', baseUrl: process.env.LOCAL_MODEL_ENDPOINT, modelId: 'bonsai-2:27b-pq2', wireApi: 'responses' } : null,
    models: [{ id: 'bonsai-2:27b-pq2', downloadState: 'not_downloaded', deploymentState: 'inactive', healthy: false }]
  }) + '\n')
} else if (model === 'rollback-error') {
  const details = {
    original: 'launchctl bootstrap failed: 5: Input/output error',
    rollback: 'launchctl bootout failed: 1: Operation not permitted',
    authorization: 'Bearer hidden-detail',
    originalError: { code: 'runtime_start_failed', stage: 'launchd', details: { exitCode: 5 } }
  }
  process.stderr.write('Authorization: Bearer hidden-stderr\n')
  process.stdout.write(JSON.stringify({ type: 'error', ok: false, code: 'rollback_failed', stage: 'rollback', message: 'failed to restore the previous local model', recoverable: false, details }) + '\n')
  process.exitCode = 1
} else if (model === 'structured-error') {
  process.stderr.write(`diagnostic token=${'secret'.repeat(5000)}`)
  process.stdout.write(JSON.stringify({
    type: 'error', ok: false, code: 'checksum_mismatch', stage: 'verify',
    message: '模型校验失败', recoverable: true
  }) + '\n')
  process.exitCode = 1
} else if (model === 'stderr-error') {
  process.stderr.write('x'.repeat(100000))
  process.exitCode = 4
} else if (model === 'malformed') {
  process.stdout.write('{not-json}\n')
} else if (model === 'oversized') {
  process.stdout.write(`${'x'.repeat(300000)}\n`)
} else if (model === 'hang') {
  process.stderr.write('waiting for runtime\n')
  setInterval(() => {}, 1000)
} else if (command === 'download' || command === 'deploy') {
  const progress = JSON.stringify({
    type: 'progress', operation: command, modelId: model,
    stage: command === 'download' ? 'model' : 'health:runtime', completedBytes: 1, totalBytes: 2, percent: 0.5
  }) + '\n'
  process.stdout.write(progress.slice(0, 17))
  setTimeout(() => {
    process.stdout.write(progress.slice(17))
    process.stdout.write(JSON.stringify({
      type: 'result', ok: true, operation: command, modelId: model,
      ...(command === 'download' ? { downloadState: 'verified' } : { activeModelId: model, connection: { providerId: 'bonsai-local', baseUrl: 'http://127.0.0.1:11437/v1', modelId: model, wireApi: 'responses' } })
    }) + '\n')
  }, 5)
} else if (command === 'stop') {
  process.stdout.write(JSON.stringify({ type: 'result', ok: true, operation: 'stop', activeModelId: null }) + '\n')
} else if (command === 'remove') {
  process.stdout.write(JSON.stringify({ type: 'result', ok: true, operation: 'remove', modelId: model, removed: true }) + '\n')
} else {
  process.stderr.write(`unexpected command: ${commandArgs.join(' ')}`)
  process.exitCode = 2
}
