import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokQuotaService } from '../src/main/grokQuota'

const directory = await mkdtemp(join(tmpdir(), 'ua-grok-quota-'))
const bin = join(directory, 'grok')
const responseFile = join(directory, 'response.json')
const logFile = join(directory, 'requests.jsonl')
const service = new GrokQuotaService()
const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-16T03:28:59Z', end: '2026-10-23T03:28:59Z' }

async function billing(config: unknown, extra: Record<string, unknown> = {}) {
  await writeFile(responseFile, JSON.stringify({ result: { config, subscription_tier: 'SuperGrok', ...extra } }))
  return service.get(bin, true)
}

try {
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, 'utf8'));
const log = value => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(value) + '\\n');
log({ argv: process.argv.slice(2) });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log({ method: message.method });
  const reply = message.method === 'initialize' ? { result: { protocolVersion: 1, agentCapabilities: {} } }
    : message.method === '_x.ai/billing' ? response
    : { error: { code: -32601, message: 'unexpected_method' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\\n');
});
`)
  await chmod(bin, 0o755)

  // A new weekly period can omit the proto3 zero-valued percentage entirely.
  const reset = await billing({ currentPeriod: period, onDemandCap: {}, onDemandUsed: {}, isUnifiedBillingUser: true })
  assert.equal(reset?.status, 'ready', 'a reset period with omitted zero usage must stay visible')
  assert.equal(reset.planType, 'SuperGrok')
  assert.deepEqual(reset.window, { label: '周限额', usedPercent: 0, resetsAt: Date.parse(period.end) })

  const monthly = await billing({ currentPeriod: { ...period, type: 'USAGE_PERIOD_TYPE_MONTHLY' } })
  assert.equal(monthly?.window?.label, '月限额')
  assert.equal(monthly?.window?.usedPercent, 0)
  for (const [percent, expected] of [[0, 0], [16, 16], [99.9, 99.9], [100, 100], [-1, 0], [101, 100]]) {
    assert.equal((await billing({ creditUsagePercent: percent, currentPeriod: period }))?.window?.usedPercent, expected)
  }
  for (const [used, expected] of [[{}, 0], [{ val: 25 }, 25]] as const) {
    const legacy = await billing({ monthlyLimit: { val: 100 }, used, billingPeriodEnd: period.end })
    assert.equal(legacy?.window?.label, '月限额')
    assert.equal(legacy?.window?.usedPercent, expected)
  }
  const wrapped = await billing(null, { result: { config: { creditUsagePercent: 8, currentPeriod: period } } })
  assert.equal(wrapped?.window?.usedPercent, 8)

  for (const config of [
    {}, { currentPeriod: {} }, { currentPeriod: { ...period, end: 'invalid' } },
    { currentPeriod: { ...period, type: 'unknown' } },
    { creditUsagePercent: 'invalid', currentPeriod: period }
  ]) {
    const invalid = await billing(config)
    assert.equal(invalid?.status, 'error', 'missing or malformed quota must not become a full allowance')
    assert.equal(invalid.window, undefined)
  }
  assert.equal((await billing(null))?.status, 'unsupported')

  for (const [code, expected] of [[-32000, 'needs-auth'], [-32601, 'unsupported'], [-32603, 'error']] as const) {
    await writeFile(responseFile, JSON.stringify({ error: { code, message: 'private-provider-detail' } }))
    const failure = await service.get(bin, true)
    assert.equal(failure?.status, expected)
    assert.equal(JSON.stringify(failure).includes('private-provider-detail'), false)
  }

  await writeFile(responseFile, JSON.stringify({ result: { config: { creditUsagePercent: 20, currentPeriod: period } } }))
  const before = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).length
  const [first, second] = await Promise.all([service.get(bin, true), service.get(bin, true)])
  assert.equal(first, second, 'parallel reads share one query')
  assert.equal(await service.get(bin), first, 'ordinary reads reuse the cached result')
  const records = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length - before, 3)
  assert.ok(records.filter(entry => entry.argv).every(entry => JSON.stringify(entry.argv) === JSON.stringify(['agent', '--no-leader', 'stdio'])))
  assert.ok(records.filter(entry => entry.method).every(entry => ['initialize', '_x.ai/billing'].includes(entry.method)), 'quota reads never create or prompt a model session')
  assert.equal(await service.get(undefined), null)
} finally {
  await service.close()
  await rm(directory, { recursive: true, force: true })
}
console.log('grok-quota: reset periods, explicit usage, legacy data, failures and cache passed')
