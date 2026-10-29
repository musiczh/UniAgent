import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

await run(process.execPath, ['scripts/build-capability-fs-addon.mjs'])
const require = createRequire(import.meta.url)
try {
  const Database = require('better-sqlite3')
  new Database(':memory:').close()
} catch (error) {
  // Packaging rebuilds SQLite for Electron. Offline tests must use the current Node ABI.
  if (!String(error).includes('NODE_MODULE_VERSION')) throw error
  await run('pnpm', ['rebuild', 'better-sqlite3'], {
    ...process.env,
    npm_config_build_from_source: 'true',
    npm_config_nodedir: dirname(dirname(realpathSync(process.execPath)))
  })
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)))
  })
}
