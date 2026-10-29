import { spawn } from 'node:child_process'

/** Owns only the process group created for this installation step. Raw output never enters diagnostics. */
export function runZCodeInstallProcess(bin: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number; message: string
}): Promise<string> {
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = '', stopped = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* Already exited. */ }
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      terminate('SIGTERM')
      escalation = setTimeout(() => terminate('SIGKILL'), 1500)
    }
    const timer = setTimeout(stop, options.timeout)
    options.signal.addEventListener('abort', stop, { once: true })
    const clear = () => {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      options.signal.removeEventListener('abort', stop)
    }
    child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-64 * 1024) })
    child.once('error', error => { clear(); reject(new Error(options.message, { cause: error })) })
    child.once('close', code => {
      clear()
      if (stopped || code !== 0) {
        terminate('SIGKILL')
        reject(options.signal.aborted ? new Error('ZCode 安装已取消') : Object.assign(new Error(options.message), {
          code: stopped ? 'ZCODE_INSTALL_TIMEOUT' : 'ZCODE_INSTALL_EXIT', exitCode: code
        }))
      } else resolve(stdout.trim())
    })
    if (options.signal.aborted) stop()
  })
}
