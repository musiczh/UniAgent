import { join, resolve } from 'node:path'

/** Native SDK configuration precedence; keep shared state separate from UniAgent data. */
export function qoderConfigRoot(region: 'cn' | 'global', home: string, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = region === 'cn' ? 'QODERCN' : 'QODER'
  return resolve(env[`${prefix}_CONFIG_DIR`] ?? join(env[`${prefix}_CLI_HOME`] ?? home,
    env[`${prefix}_CONFIG_DIR_NAME`] ?? (region === 'cn' ? '.qoder-cn' : '.qoder')))
}
