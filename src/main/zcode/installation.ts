import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ZCodeInstallationSnapshot, ZCodeRuntimeConfig } from '../../shared/zcode'
import { resolveUserDataHome } from '../userData'
import { buildZCodeRuntime, verifyZCodeEngine, ZCODE_VERIFIED_REVISION } from './build'
import { detectZCodeEngine, detectZCodeRuntime, discoverExternalZCodeRuntime, importPreparedZCodeRuntime, zcodeRuntimeConfigPath } from './runtime'
import { writeZCodeJson } from './store'
import { isRecord } from './protocol'
import { ZCodeSetupTrace, type ZCodeSetupReporter } from './diagnostics'

const activePhases = new Set(['preparing', 'downloading', 'building', 'verifying', 'activating'])
export class ZCodeInstallationService {
  private state: ZCodeInstallationSnapshot = { phase: 'idle', installed: false, cancellable: false }
  private flight?: Promise<ZCodeInstallationSnapshot>
  private controller?: AbortController
  constructor(private dependencies = { build: buildZCodeRuntime, verify: verifyZCodeEngine, detect: detectZCodeEngine,
    save: async (config: ZCodeRuntimeConfig) => { writeZCodeJson(zcodeRuntimeConfigPath(), config) } }, private report?: ZCodeSetupReporter) {}
  isBusy(): boolean { return !!this.flight }
  select(file: string, beforeActivate: () => Promise<void>): Promise<ZCodeInstallationSnapshot> {
    if (this.flight) return Promise.reject(new Error('ZCode 正在准备，请稍后选择运行时'))
    this.state = { phase: 'verifying', installed: false, cancellable: false, message: '正在校验所选程序的完整资源与协议…' }
    const readCurrent = () => readFile(zcodeRuntimeConfigPath(), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    const flight = (async () => {
      try {
        const original = await readCurrent()
        const config = await discoverExternalZCodeRuntime(process.env, [], file)
        if (!config) throw new Error('ZCode 运行时校验未通过')
        await beforeActivate()
        if (await readCurrent() !== original) throw new Error('ZCode 配置已变化，请重新选择')
        await this.dependencies.save(config)
        this.state = { phase: 'completed', installed: true, cancellable: false, message: '已复用所选本机运行时' }
      } catch (error) { this.state = { phase: 'failed', installed: false, cancellable: false, message: installFailureMessage(error) } }
      finally { this.flight = undefined }
      return this.snapshot()
    })()
    this.flight = flight
    return flight
  }
  async snapshot(): Promise<ZCodeInstallationSnapshot> {
    if (this.flight) return { ...this.state }
    try { await importPreparedZCodeRuntime() }
    catch { return { phase: 'failed', installed: true, cancellable: false, message: '已找到本机运行时，但资源或协议检测失败，请重新检测或使用提示词排查' } }
    let installed = false, version: string | undefined
    try {
      const config = JSON.parse(await readFile(zcodeRuntimeConfigPath(), 'utf8'))
      version = (await this.dependencies.detect(config)).version
      installed = true
    } catch { /* Missing/broken engine is repairable from this screen. */ }
    return { ...this.state, installed, version }
  }
  install(beforeActivate: () => Promise<void>): Promise<ZCodeInstallationSnapshot> {
    if (this.flight) return this.flight
    const controller = new AbortController()
    this.controller = controller
    this.state = { phase: 'preparing', installed: false, cancellable: true, message: '正在检查现有 ZCode 安装…' }
    const flight = this.perform(controller.signal, beforeActivate).finally(() => {
      if (this.flight === flight) { this.flight = undefined; this.controller = undefined }
    })
    this.flight = flight
    return flight
  }
  async cancel(): Promise<void> {
    if (this.state.cancellable) this.controller?.abort()
    await this.flight
  }
  private async perform(signal: AbortSignal, beforeActivate: () => Promise<void>): Promise<ZCodeInstallationSnapshot> {
    const trace = new ZCodeSetupTrace('installation', this.report)
    let candidate: string | undefined, retain = false
    const progress = (phase: ZCodeInstallationSnapshot['phase'], message: string) => {
      trace.stage(phase)
      this.state = { ...this.state, phase, message, cancellable: activePhases.has(phase) && phase !== 'activating' }
    }
    const readCurrent = async () => {
      try { return await readFile(zcodeRuntimeConfigPath(), 'utf8') }
      catch (error: any) { if (error.code === 'ENOENT') return undefined; throw new Error('ZCode 配置无法读取，请检查文件权限') }
    }
    try {
      await importPreparedZCodeRuntime()
      const original = await readCurrent()
      let previous: ZCodeRuntimeConfig | undefined
      if (original !== undefined) {
        try {
          const value = JSON.parse(original)
          if (!isRecord(value) || value.schemaVersion !== 1 || !['cli', 'official-app', 'source-build'].includes(value.source)
            || typeof value.executable !== 'string' || !isAbsolute(value.executable)
            || typeof value.dataRootId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.dataRootId)
            || ['bundlePath', 'resourceRoot', 'personalProviderConfigPath', 'sourceAppPath'].some(key =>
              value[key] !== undefined && (typeof value[key] !== 'string' || !isAbsolute(value[key])))) throw new Error('invalid config')
          previous = value as unknown as ZCodeRuntimeConfig
        }
        catch { throw new Error('ZCode 配置损坏，请使用 Agent 协助修复；原文件已保留') }
      }
      const parent = join(resolveUserDataHome(), 'zcode', 'runtime')
      await mkdir(parent, { recursive: true, mode: 0o700 })
      if (previous) {
        let engine: Awaited<ReturnType<typeof detectZCodeEngine>> | undefined
        try { engine = await this.dependencies.detect(previous) } catch { /* Repair an unavailable engine in a separate directory. */ }
        if (!engine && previous.source !== 'source-build') throw new Error('ZCode 外部运行时未通过校验，请修复原程序或重新选择已有运行时；原配置已保留')
        if (engine) {
          progress('verifying', '正在验证已有 ZCode 引擎…')
          await this.dependencies.verify(engine.config, parent, signal)
          signal.throwIfAborted()
          if (await readCurrent() !== original) throw new Error('ZCode 配置已变化，请重试')
          this.state = { phase: 'completed', installed: true, cancellable: false, version: engine.version, message: `ZCode ${engine.version} 已安装，运行时校验通过` }
          return { ...this.state }
        }
      }
      signal.throwIfAborted()
      candidate = await mkdtemp(join(parent, 'install-'))
      const config = await this.dependencies.build(candidate, ZCODE_VERIFIED_REVISION, signal, progress, previous)
      signal.throwIfAborted()
      const engine = await this.dependencies.detect(config)
      if (config.personalProviderConfigPath) await detectZCodeRuntime(config)
      if (await readCurrent() !== original) throw new Error('ZCode 配置已变化，请重试；原配置已保留')
      signal.throwIfAborted()
      progress('activating', '正在启用已验证的 ZCode…')
      await beforeActivate()
      signal.throwIfAborted()
      if (await readCurrent() !== original) throw new Error('ZCode 配置已变化，请重试；原配置已保留')
      // Saving may fail after rename/fsync; never delete a possibly active candidate.
      retain = true
      await this.dependencies.save(config)
      this.state = { phase: 'completed', installed: true, cancellable: false, version: engine.version, message: `ZCode ${engine.version} 已安装，运行时校验通过` }
    } catch (error) {
      trace.fail(signal.aborted ? 'cancelled' : 'unknown', error)
      this.state = { phase: signal.aborted ? 'cancelled' : 'failed', installed: false, cancellable: false,
        message: signal.aborted ? '已取消安装，可重新安装或使用 Agent 初始化' : installFailureMessage(error) }
    } finally {
      if (candidate && !retain) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
    }
    return { ...this.state }
  }
}

function installFailureMessage(error: unknown): string {
  // Internal, bounded Chinese diagnostics only. Spawn/fetch exceptions may contain credentials or URLs.
  const text = error instanceof Error ? error.message : ''
  return /^(ZCode |已阻止 ZCode |当前平台暂不支持 ZCode )/.test(text) && text.length < 180 && !/[\r\n]|https?:|api.?key|token|password/i.test(text)
    ? text : 'ZCode 安装未完成，请检查网络和运行环境后重试，或使用 Agent 初始化'
}
