import { shell } from 'electron'
import type { FeishuInstallPhase } from '../shared/types.ts'

/** Browser authorization is shared by Session and personal-assistant bots.
 * Credentials are only passed to the settings store; authorization URLs stay transient.
 */

/** A single progress delta streamed to the settings panel. */
export interface FeishuInstallProgress {
  phase: FeishuInstallPhase
  message?: string
  verificationUrl?: string
  appId?: string
}

export interface FeishuInstallerDeps {
  onProgress: (p: FeishuInstallProgress) => void
  /** Persist the created credentials (App Secret 0600, never logged). */
  persist: (appId: string, appSecret: string, signal: AbortSignal) => void | Promise<void>
  /** (Re)start the WSClient bridge to self-test the fresh credentials. */
  startBridge: () => Promise<void>
}

export class FeishuInstaller {
  private readonly deps: FeishuInstallerDeps
  private registrationAbort?: AbortController

  constructor(deps: FeishuInstallerDeps) {
    this.deps = deps
  }

  /** Abort an in-flight install (best effort). */
  cancel(): void {
    this.registrationAbort?.abort()
  }

  /** The SDK keeps the browser's existing-app picker available without changing CLI profiles. */
  async installFromBrowser(): Promise<void> {
    if (this.registrationAbort) throw new Error('机器人配置正在进行中')
    const controller = new AbortController()
    this.registrationAbort = controller
    let stage: 'authorization' | 'binding' | 'connecting' = 'authorization'
    let rejectCancellation: () => void = () => {}
    const cancellation = new Promise<never>((_resolve,reject) => { rejectCancellation = () => reject(new Error('cancelled')) })
    void cancellation.catch(() => {})
    controller.signal.addEventListener('abort',rejectCancellation,{ once: true })
    this.deps.onProgress({ phase: 'installing', message: '正在打开飞书机器人配置页面…' })
    try {
      const { registerApp } = await import('@larksuiteoapi/node-sdk')
      if (controller.signal.aborted) throw new Error('cancelled')
      let openingBrowser = Promise.resolve()
      const result = await Promise.race([registerApp({
        source: 'uniagent-assistant', signal: controller.signal,
        onQRCodeReady: ({ url }) => {
          if (controller.signal.aborted) return
          this.deps.onProgress({ phase: 'awaiting-scan', message: '请在浏览器选择机器人并完成授权，完成后将自动绑定', verificationUrl: url })
          openingBrowser = shell.openExternal(url).catch(() => {
            if (!controller.signal.aborted) this.deps.onProgress({ phase: 'awaiting-scan', message: '浏览器未能自动打开，请点击“打开授权页面”继续', verificationUrl: url })
          })
        }
      }),cancellation])
      await Promise.race([openingBrowser,cancellation])
      if (controller.signal.aborted) throw new Error('cancelled')
      stage = 'binding'
      await this.deps.persist(result.client_id,result.client_secret,controller.signal)
      if (controller.signal.aborted) throw new Error('cancelled')
      stage = 'connecting'
      this.deps.onProgress({ phase: 'awaiting-login', message: '机器人已绑定，正在建立长连接…', appId: result.client_id })
      await Promise.race([this.deps.startBridge(),cancellation])
      // Connection readiness is reported by the bridge's actual onReady event.
    } catch (error: any) {
      const message = controller.signal.aborted ? '已取消配置' : error?.code === 'access_denied' ? '已拒绝授权，可重试或手动填写凭证'
        : error?.code === 'expired_token' ? '授权链接已过期，请重新点击“一键配置”' : stage === 'binding' && error instanceof Error ? error.message
        : stage === 'connecting' ? '机器人已绑定，但连接失败，请检查配置或稍后重试' : '一键配置失败，请重试或手动填写凭证'
      this.fail(message)
      throw new Error(message)
    } finally {
      controller.signal.removeEventListener('abort',rejectCancellation)
      if (this.registrationAbort === controller) this.registrationAbort = undefined
    }
  }

  private fail(message: string): void {
    this.deps.onProgress({ phase: 'failed', message })
  }
}
