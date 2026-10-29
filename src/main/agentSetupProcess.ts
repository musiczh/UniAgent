import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export async function findAgentExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const home = env.HOME || homedir()
  const name = process.platform === 'win32' && !/\.(cmd|exe)$/i.test(bin) ? bin + '.exe' : bin
  const candidates = isAbsolute(bin) ? [bin] : [
    ...(env.PATH || '').split(delimiter).filter(Boolean).map(dir => resolve(dir, name)),
    join(home, '.local/bin', name), join(home, '.grok/bin', name), join(home, '.codex/bin', name),
    join(home, '.trae/bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name
  ]
  for (const path of [...new Set(candidates)]) {
    try { await access(path, constants.X_OK); return path }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw new Error('程序访问失败，请检查路径与权限后重试') }
  }
}

/** Only stops the process group created by this invocation; output never enters errors or logs. */
export function runSetupCommand(bin: string, args: string[], options: {
  env?: NodeJS.ProcessEnv; signal: AbortSignal; input?: string; timeoutMs?: number; output?: (chunk: string) => void
}): Promise<string> {
  options.signal.throwIfAborted()
  return new Promise((resolveCommand, reject) => {
    const child = spawn(bin, args, { env: options.env || process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', stopped = false, killer: ReturnType<typeof setTimeout> | undefined
    const send = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch { /* Owned process already exited. */ }
    }
    const stop = () => { stopped = true; send('SIGTERM'); killer ??= setTimeout(() => send('SIGKILL'), 200) }
    const timer = setTimeout(stop, options.timeoutMs || 600_000)
    const capture = (chunk: Buffer) => { const text = chunk.toString(); output = (output + text).slice(-65536); options.output?.(text) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    child.stdin.on('error', () => {})
    child.stdin.end(options.input)
    options.signal.addEventListener('abort', stop, { once: true })
    if (options.signal.aborted) stop()
    const clean = () => { clearTimeout(timer); options.signal.removeEventListener('abort', stop); if (killer) { clearTimeout(killer); send('SIGKILL') } }
    child.once('error', () => { clean(); reject(new Error('程序未能启动，请检查安装与权限')) })
    child.once('close', code => { clean(); code === 0 && !stopped ? resolveCommand(output) : reject(new Error(options.signal.aborted ? '操作已取消' : '程序操作未完成，请检查网络与配置后重试')) })
  })
}
