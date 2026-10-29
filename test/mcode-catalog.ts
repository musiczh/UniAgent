import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  currentMCodeContextLimit,
  mcodeContextLimitPath,
  parseMCodeCatalog,
  upsertYamlNumber,
  writeMCodeContextLimit
} from '../src/main/mcodeCatalog.ts'

// ---------------------------------------------------------------------------
// MiniMax Code runtime configuration.
//
// MiniMax Code stores the per-model context window in its own configuration
// file. UniAgent has to read the catalog (variants, reasoning levels, windows)
// and write the window back through the very same key the native app uses.
// ---------------------------------------------------------------------------

const config = `logLevel: info
provider:
  minimax:
    name: MiniMax
    options:
      apiKey: sk-test
    models:
      MiniMax-M3:
        name: M3
        limit:
          context: 512000
          output: 128000
        contextWindowOptions:
          - 512000
          - 1000000
        thinking_config:
          mode: switchable
          default_value: 'true'
        variants:
          none-thinking:
            thinking:
              type: disabled
          thinking:
            thinking:
              type: adaptive
minimax_api:
  apiKey: sk-test
minimaxModelSource: minimax_api_key
defaultModel: minimax/MiniMax-M3
defaultModelVariant: thinking
`

// Break caught: reading the wrong model id or losing the window options would
// hide the 1M switch even though the native model supports it.
const catalog = parseMCodeCatalog(config, '/tmp/config.yaml')
assert.ok(catalog)
assert.equal(catalog.credentialSource, 'api')
assert.equal(catalog.models.size, 1)
const m3 = catalog.models.get('MiniMax-M3')
assert.ok(m3)
assert.equal(m3.displayName, 'M3')
assert.equal(m3.defaultContextWindow, 512000)
assert.equal(m3.contextWindow, 512000)
assert.equal(m3.maxContextWindow, 1000000)
assert.equal(m3.supportsMax, true)
assert.equal(m3.thinkingMode, 'switchable')
assert.deepEqual(m3.variants, ['none-thinking', 'thinking'])
assert.equal(m3.effortOptions, undefined)

// Break caught: a managed (subscription) login stores the window under a
// different key than an API-key login.
const managed = parseMCodeCatalog(config.replace('minimaxModelSource: minimax_api_key', 'minimaxModelSource: managed_token_plan'), '/tmp/config.yaml')
assert.ok(managed)
assert.equal(managed.credentialSource, 'managed')
assert.deepEqual(mcodeContextLimitPath(managed, 'MiniMax-M3'), ['minimaxModelContextLimits', 'MiniMax-M3'])
assert.deepEqual(mcodeContextLimitPath(catalog, 'MiniMax-M3'), ['minimax_api', 'modelContextLimits', 'MiniMax-M3'])

// Break caught: a stored override is the window the runtime actually applies.
const withStoredWindow = (value: number): string =>
  config.replace('minimax_api:\n  apiKey: sk-test\n', `minimax_api:\n  apiKey: sk-test\n  modelContextLimits:\n    MiniMax-M3: ${value}\n`)
const overridden = parseMCodeCatalog(withStoredWindow(1000000), '/tmp/config.yaml')
assert.ok(overridden)
assert.equal(overridden.models.get('MiniMax-M3')?.contextWindow, 1000000)
// An unsupported value must not widen the window.
const invalid = parseMCodeCatalog(withStoredWindow(999999), '/tmp/config.yaml')
assert.ok(invalid)
assert.equal(invalid.models.get('MiniMax-M3')?.contextWindow, 512000)

// Break caught: a broken configuration must not crash the picker.
assert.equal(parseMCodeCatalog('::: not yaml :::', '/tmp/config.yaml'), undefined)

// --- YAML patching ---------------------------------------------------------

// Break caught: writing the window has to create the missing mapping without
// reformatting the rest of the user's configuration.
const patched = upsertYamlNumber(config, ['minimax_api', 'modelContextLimits', 'MiniMax-M3'], 1000000)
assert.ok(patched)
assert.ok(patched.includes('\n  modelContextLimits:\n    MiniMax-M3: 1000000\n'))
assert.ok(patched.includes('logLevel: info'))
assert.ok(patched.includes('apiKey: sk-test'))

// Break caught: an existing mapping has to be updated in place.
const repatched = upsertYamlNumber(patched, ['minimax_api', 'modelContextLimits', 'MiniMax-M3'], 512000)
assert.ok(repatched)
assert.ok(repatched.includes('    MiniMax-M3: 512000'))
assert.ok(!repatched.includes('MiniMax-M3: 1000000'))

// Break caught: a top-level mapping is created when it is missing entirely.
const managedPatched = upsertYamlNumber(config, ['minimaxModelContextLimits', 'MiniMax-M3'], 1000000)
assert.ok(managedPatched)
assert.ok(managedPatched.includes('\nminimaxModelContextLimits:\n  MiniMax-M3: 1000000\n'))

// --- Writing the window ----------------------------------------------------

const directory = await mkdtemp(join(tmpdir(), 'uniagent-mcode-catalog-'))
const configPath = join(directory, 'config.yaml')
await writeFile(configPath, config, { mode: 0o600 })

// Break caught: the runtime has to see the window UniAgent shows as active.
assert.equal(await currentMCodeContextLimit('MiniMax-M3', configPath), 512000)
assert.equal(await writeMCodeContextLimit('MiniMax-M3', 1000000, { configPath }), true)
assert.equal(await currentMCodeContextLimit('MiniMax-M3', configPath), 1000000)
assert.ok((await readFile(configPath, 'utf8')).includes('    MiniMax-M3: 1000000'))
// Break caught: writing the same window again must not touch the file.
assert.equal(await writeMCodeContextLimit('MiniMax-M3', 1000000, { configPath }), false)
// Break caught: a window the model does not support must be rejected instead
// of silently writing a value the runtime ignores.
await assert.rejects(() => writeMCodeContextLimit('MiniMax-M3', 999999, { configPath }))
// Break caught: an unknown model must be reported instead of writing a key the
// runtime would never read.
await assert.rejects(() => writeMCodeContextLimit('MiniMax-M9', 1000000, { configPath }))
// The rejected writes must not have changed the stored window.
assert.equal(await currentMCodeContextLimit('MiniMax-M3', configPath), 1000000)
