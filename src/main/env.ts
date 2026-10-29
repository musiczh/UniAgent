import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

const LOGIN_SHELL_TIMEOUT_MS = 6000

/**
 * Dirs where the built-in agent CLIs actually live (Homebrew, `~/.local/bin`,
 * grok, cargo). GUI launches only inherit launchd's minimal PATH, so a slow or
 * failed login-shell harvest must not leave every installed CLI reading as
 * "not-installed". Seeding these unconditionally is cheap — a missing dir just
 * gets skipped by `command -v` — and it makes detection robust on first launch.
 */
function wellKnownBinDirs(): string[] {
  const home = homedir()
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.grok/bin`,
    `${home}/.npm-global/bin`
  ]
}

/**
 * GUI apps launched from Finder / Launchpad inherit launchd's minimal PATH,
 * which omits the dirs users add in their shell profile (`~/.local/bin`, nvm,
 * pyenv, …). That makes CLIs like `traecli` "disappear" even though they work
 * fine in the terminal.
 *
 * Harvest the user's real login+interactive shell PATH ONCE at startup and
 * merge it into `process.env.PATH`, so both agent detection and every child
 * spawn (which inherit `process.env`) resolve the same binaries the user sees
 * in their shell. When already launched from a terminal (dev), the login PATH
 * usually matches and this is effectively a no-op.
 */
export function hydratePathFromLoginShell(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve()
  // Always union the known install dirs first: even if the shell harvest below
  // times out or throws, detection still finds Homebrew/`~/.local/bin`/grok CLIs
  // instead of falsely showing the "no agent" empty state on first launch.
  const seed = wellKnownBinDirs()
  const current = (process.env.PATH || '').split(':')
  process.env.PATH = [...new Set([...current, ...seed].filter(Boolean))].join(':')
  const shell = process.env.SHELL || '/bin/bash'
  // `-i -l` so both login (~/.bash_profile, ~/.zprofile) and interactive
  // (~/.bashrc, ~/.zshrc) rc files are sourced — that's where PATH edits live.
  // Sentinels fence off the value from any banner/rc noise on stdout.
  const marker = '__UA_PATH_START__'
  const end = '__UA_PATH_END__'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${end}'`],
      { encoding: 'utf8', timeout: LOGIN_SHELL_TIMEOUT_MS, windowsHide: true },
      (_error, stdout) => {
        // A slow or noisy shell must never hold Electron's main thread. The
        // seeded dirs above already cover the common case when harvesting fails.
        const out = String(stdout || '')
        const s = out.indexOf(marker)
        const e = out.indexOf(end)
        if (s >= 0 && e > s) {
          const harvested = out.slice(s + marker.length, e)
          if (harvested) {
            const now = (process.env.PATH || '').split(':')
            // Prefer the login PATH order, then whatever we already have; de-dup.
            const merged = [...harvested.split(':'), ...now].filter(Boolean)
            process.env.PATH = [...new Set(merged)].join(':')
          }
        }
        resolve()
      }
    )
  })
}
