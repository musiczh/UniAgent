import { parseAssistantSnapshot } from '../shared/assistant'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { open, rename, unlink } from 'node:fs/promises'
import type {
  DurableQueueItem,
  ModelDef,
  QueueItem,
  PermissionMode,
  PermissionModeDef,
  ReasoningEffort,
  Session,
  SessionConfig,
  SessionAgentContract,
  SubmittedUserMessage,
  UASubAgent,
  UAEvent
} from '../shared/types'
import { resolveUserDataHome } from './userData.ts'
import { PERMISSION_MODE_IDS } from '../shared/types'
import { parseAgentRole } from './roleStore.ts'
import { parseSessionWorktree } from './worktreeService.ts'
import { parseNativeThreadAction } from '../shared/nativeCapabilities'
import { sanitizeZCodeSelection, sanitizeZCodeState } from './zcode/store'

/**
 * Persists UniAgent's own session metadata to disk (Doc2 需求 3.1) so the
 * sidebar survives restarts. We only store metadata (id/title/config/status/
 * createdAt/updatedAt/nativeSessionId/origin/UI flags/readOnly/importMode/forkedFrom/
 * agentContract), plus a bounded list of user-message display decorations —
 * never the full event history, which is
 * re-read from the native rollout on demand to avoid duplicate storage and
 * unbounded growth.
 */
export class SessionStore {
  private file: string
  private sideChatsFile: string
  private ready = false

  constructor(
    fileOverride?: string,
    private readonly normalizeConfig?: (config: SessionConfig) => SessionConfig
  ) {
    // `app` is unavailable in headless tests; allow an explicit override.
    this.file = fileOverride || join(resolveUserDataHome(), 'sessions.json')
    this.sideChatsFile = basename(this.file) === 'sessions.json'
      ? join(dirname(this.file), 'side-chats.json')
      : `${this.file}.side-chats.json`
  }

  directory(): string {
    return dirname(this.file)
  }

  private ensureDir(): void {
    if (this.ready) return
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
    } catch {
      /* ignore */
    }
    this.ready = true
  }

  /** Load persisted sessions. Running statuses are normalized to idle. */
  load(): Session[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = readFileSync(this.file, 'utf8')
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      const sessions: Session[] = []
      let migratedProjectConfig = false
      for (const row of arr) {
        try {
          const session = parseSessionRow(row, this.normalizeConfig)
          if (session) {
            sessions.push(session)
            const storedConfig = isRecord(row) && isRecord(row.config) ? row.config : undefined
            if (
              session.config.projectId &&
              storedConfig &&
              (
                storedConfig.projectId !== session.config.projectId ||
                'workdir' in storedConfig ||
                'additionalDirectories' in storedConfig
              )
            ) migratedProjectConfig = true
          }
        } catch {
          // A single malformed row must not drop valid siblings.
        }
      }
      if (migratedProjectConfig) this.save(sessions)
      return sessions
    } catch {
      return []
    }
  }

  /** Persist the full session list (metadata only). */
  save(sessions: Session[]): void {
    this.ensureDir()
    try {
      this.saveOrThrow(sessions)
    } catch {
      /* best effort — a failed persist must never break a live turn */
    }
  }

  /**
   * Durability boundary for accepted user input. Unlike save(), failures are
   * observable so callers never announce a queued message that was not fsynced.
   */
  saveOrThrow(sessions: Session[]): void {
    this.ensureDir()
    const meta = sessions.map(serializeSession)
    atomicWriteFileSync(this.file, JSON.stringify(meta, null, 2))
  }

  loadSideChats(): PersistedSideChat[] {
    try {
      if (!existsSync(this.sideChatsFile)) return []
      const rows: unknown = JSON.parse(readFileSync(this.sideChatsFile, 'utf8'))
      if (!Array.isArray(rows)) return []
      const sideChats: PersistedSideChat[] = []
      for (const row of rows) {
        try {
          const parsed = parseSideChatRow(row, this.normalizeConfig)
          if (parsed) sideChats.push(parsed)
        } catch {
          // A malformed row or stale project must not drop valid siblings.
        }
      }
      return sideChats
    } catch {
      return []
    }
  }

  saveSideChats(sideChats: PersistedSideChat[]): void {
    this.ensureDir()
    try {
      atomicWriteFileSync(this.sideChatsFile, JSON.stringify(sideChats, null, 2))
    } catch {
      /* best effort — side-chat cache failure must not break a live turn */
    }
  }
}

export interface PersistedSideChat {
  sessionId: string
  config: SessionConfig
  events: UAEvent[]
  nativeSessionId?: string
  queue?: QueueItem[]
}

/**
 * Describes whether a failed atomic write changed the visible target file.
 *
 * `committed-durability-uncertain` means rename(2) already installed the new
 * file, but syncing the parent directory failed. The caller must keep its
 * in-memory state aligned with the newly visible file while still surfacing
 * that the rename may not survive a crash.
 */
export type SessionStoreCommitDisposition =
  | 'not-committed'
  | 'committed-durability-uncertain'

export class SessionStoreWriteError extends Error {
  readonly commitDisposition: SessionStoreCommitDisposition

  constructor(
    message: string,
    commitDisposition: SessionStoreCommitDisposition,
    cause: unknown
  ) {
    super(message, { cause })
    this.name = 'SessionStoreWriteError'
    this.commitDisposition = commitDisposition
  }
}

export function sessionStoreWriteCommitted(error: unknown): boolean {
  return (
    error instanceof SessionStoreWriteError &&
    error.commitDisposition === 'committed-durability-uncertain'
  )
}

function serializeSession(s: Session): Record<string, unknown> {
  const zcodeState = s.zcodeState === undefined ? undefined : sanitizeZCodeState(s.zcodeState)
  if (s.zcodeState !== undefined && !zcodeState) throw new Error('ZCode durable delivery state is invalid')
  const readOnly = sanitizeReadOnly(s.readOnly)
  const importMode = sanitizeImportMode(s.importMode)
  const forkedFrom = sanitizeForkedFrom(s.forkedFrom)
  const agentContract = sanitizeAgentContract(s.agentContract)
  const pendingQueue = sanitizePendingQueue(s.pendingQueue, false)
  const submittedUserMessages = sanitizeSubmittedUserMessages(s.submittedUserMessages)
  const goal = sanitizeGoal(s.goal)
  const subagents = sanitizeSubAgents(s.subagents)
  const { workdir, additionalDirectories, requirementDir, requirementDocPath, requirementName, ...projectConfig } = s.config
  const persistedConfig = s.config.projectId ? projectConfig : {
    ...projectConfig, workdir,
    additionalDirectories: additionalDirectories?.filter(path => path !== requirementDir)
  }
  return {
    id: s.id,
    ...(s.teamBinding ? { teamBinding: s.teamBinding } : {}),
    title: s.title,
    ...(s.worktreeTask ? { worktreeTask: s.worktreeTask } : {}),
    ...(s.worktreeTaskError ? { worktreeTaskError: s.worktreeTaskError } : {}),
    config: persistedConfig,
    status: normalizeStatus(s.status),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    nativeSessionId: s.nativeSessionId,
    ...(zcodeState ? { zcodeState } : {}),
    ...(s.zcodeStateInvalid ? { zcodeStateInvalid: true as const } : {}),
    ...(s.pendingClaudeFork ? { pendingClaudeFork: s.pendingClaudeFork } : {}),
    origin: s.origin || 'created',
    archived: s.archived || false,
    pinned: s.pinned,
    titleLocked: s.titleLocked,
    // 需求5 — the handoff lineage id persists (so a restored handoff session
    // still knows its origin); handoffWaiting is deliberately NOT persisted — a
    // wait cannot survive a restart (the blocking MCP server process is gone),
    // so the「等待中」badge must clear on relaunch rather than linger forever.
    ...(typeof s.handoffId === 'string' && s.handoffId ? { handoffId: s.handoffId } : {}),
    ...(s.handoffUserContinued === true ? { handoffUserContinued: true } : {}),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(importMode === undefined ? {} : { importMode }),
    ...(typeof s.previousSessionId === 'string' ? { previousSessionId: s.previousSessionId } : {}),
    ...(s.assistantEndReason ? { assistantEndReason: s.assistantEndReason } : {}),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(agentContract === undefined ? {} : { agentContract }),
    ...(pendingQueue.length === 0 ? {} : { pendingQueue }),
    ...(submittedUserMessages.length === 0 ? {} : { submittedUserMessages }),
    ...(goal === undefined ? {} : { goal }),
    ...(subagents.length ? { subagents } : {})
  }
}

export function atomicWriteFileSync(targetPath: string, contents: string): void {
  const dir = dirname(targetPath)
  const prefix = basename(targetPath)
  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  const tmpPath = join(dir, `${prefix}.${uniqueSuffix}.tmp`)

  let fd: number | undefined
  let didRename = false
  try {
    // Create in the same directory to guarantee atomic rename, using O_EXCL to
    // avoid clobbering an existing file, and mode 0600 for privacy.
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)

    const buf = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset)
      if (written <= 0) throw new Error('SessionStore atomic write made no progress')
      offset += written
    }

    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    renameSync(tmpPath, targetPath)
    didRename = true

    // fsync the parent directory so the rename is crash-safe.
    let dirFd: number | undefined
    try {
      dirFd = openSync(dir, constants.O_RDONLY)
      fsyncSync(dirFd)
    } finally {
      if (dirFd !== undefined) {
        try {
          closeSync(dirFd)
        } catch {
          /* ignore */
        }
      }
    }
  } catch (error) {
    // Any pre-rename failure must preserve the old store; clean up the temp.
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    if (!didRename) {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
    const commitDisposition: SessionStoreCommitDisposition = didRename
      ? 'committed-durability-uncertain'
      : 'not-committed'
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionStoreWriteError(
      didRename
        ? `SessionStore rename committed but directory durability is uncertain: ${detail}`
        : `SessionStore write did not commit: ${detail}`,
      commitDisposition,
      error
    )
  }
}

/** Startup recovery uses libuv I/O so durability waits cannot block Electron. */
export async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  const dir = dirname(targetPath)
  const tmpPath = join(dir, `${basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let didRename = false
  try {
    file = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await file.writeFile(contents, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await rename(tmpPath, targetPath)
    didRename = true
    const directory = await open(dir, constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close().catch(() => {}) }
  } catch (error) {
    await file?.close().catch(() => {})
    if (!didRename) await unlink(tmpPath).catch(() => {})
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionStoreWriteError(
      didRename
        ? `SessionStore rename committed but directory durability is uncertain: ${detail}`
        : `SessionStore write did not commit: ${detail}`,
      didRename ? 'committed-durability-uncertain' : 'not-committed', error
    )
  }
}

/**
 * sessions.json is user-writable input. Validate each persisted row
 * independently so one malformed session does not nuke the full list.
 */
function parseSessionRow(
  value: unknown,
  normalizeConfig?: (config: SessionConfig) => SessionConfig
): Session | undefined {
  if (!isRecord(value)) return undefined

  const id = value.id
  if (!isNonEmptyString(id)) return undefined
  const title = value.title
  if (typeof title !== 'string') return undefined
  const teamBinding = value.teamBinding
  if (teamBinding !== undefined && (!isRecord(teamBinding) || !isNonEmptyString(teamBinding.teamProjectId) || !isNonEmptyString(teamBinding.memberId))) return undefined

  const parsedConfig = parseSessionConfig(value.config)
  if (!parsedConfig) return undefined
  const config = normalizeConfig ? normalizeConfig(parsedConfig) : parsedConfig
  const zcodeState = value.zcodeState === undefined ? undefined : sanitizeZCodeState(value.zcodeState)
  const zcodeStateInvalid = value.zcodeStateInvalid === true || value.zcodeState !== undefined && !zcodeState

  const createdAt = value.createdAt
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) return undefined

  const status = parseSessionStatus(value.status)
  if (!status) return undefined

  const updatedAt = parseOptionalFiniteNumber(value.updatedAt)
  if (updatedAt === INVALID_OPTIONAL_FIELD) return undefined

  const nativeSessionId = parseOptionalNonEmptyString(value.nativeSessionId)
  if (nativeSessionId === INVALID_OPTIONAL_FIELD) return undefined
  let pendingClaudeFork: Session['pendingClaudeFork']
  if (value.pendingClaudeFork !== undefined) {
    const fork = value.pendingClaudeFork
    if (
      !isRecord(fork) || config.agentId !== 'claude' || nativeSessionId ||
      typeof fork.sessionId !== 'string' || !fork.sessionId ||
      typeof fork.messageId !== 'string' || !fork.messageId
    ) return undefined
    pendingClaudeFork = { sessionId: fork.sessionId, messageId: fork.messageId }
  }

  const origin = parseOptionalSessionOrigin(value.origin)
  if (origin === INVALID_OPTIONAL_FIELD) return undefined

  const archived = parseOptionalBoolean(value.archived)
  if (archived === INVALID_OPTIONAL_FIELD) return undefined

  const pinned = parseOptionalBoolean(value.pinned)
  if (pinned === INVALID_OPTIONAL_FIELD) return undefined

  const titleLocked = parseOptionalBoolean(value.titleLocked)
  if (titleLocked === INVALID_OPTIONAL_FIELD) return undefined

  const handoffId = parseOptionalString(value.handoffId)
  if (handoffId === INVALID_OPTIONAL_FIELD) return undefined

  const handoffUserContinued = parseOptionalBoolean(value.handoffUserContinued)
  if (handoffUserContinued === INVALID_OPTIONAL_FIELD) return undefined

  const readOnly = sanitizeReadOnly(value.readOnly)
  const importMode = sanitizeImportMode(value.importMode)
  const forkedFrom = sanitizeForkedFrom(value.forkedFrom)
  const agentContract = sanitizeAgentContract(value.agentContract)
  const pendingQueue = sanitizePendingQueue(value.pendingQueue, true, ['kimi', 'deepseek', 'grok', 'zcode'].includes(config.agentId))
  if (config.agentId === 'zcode') for (const item of pendingQueue) {
    const receipt = zcodeState?.deliveries.filter(record => record.queueItemId === item.id).at(-1)
    item.deliveryUncertain = zcodeStateInvalid || !!receipt && ['sent', 'acknowledged', 'uncertain', 'observed'].includes(receipt.phase) || undefined
  }
  const submittedUserMessages = sanitizeSubmittedUserMessages(value.submittedUserMessages)
  const worktreeTask = parseWorktreeTask(value.worktreeTask)
  const pendingWorktree = !!config.worktree && !!worktreeTask && !submittedUserMessages.length && !pendingQueue.length
  if (config.worktree?.state === 'creating' && !nativeSessionId) {
    config.worktree = { ...config.worktree!, state: 'failed', lastError: '应用已重启，请重试创建工作树' }
  }
  const continuedHandoff = !!handoffId && (handoffUserContinued ?? (
    pendingQueue.some((message) => message.source !== 'mcp') ||
    submittedUserMessages.some((message) => message.userOrdinal > 0 && message.source !== 'mcp')
  ))
  const goal = sanitizeGoal(value.goal)
  const subagents = sanitizeSubAgents(value.subagents, true)
  const canonicalImportMode = origin === 'imported' && !forkedFrom ? importMode : undefined
  const canonicalReadOnly = origin === 'imported'
    ? forkedFrom
      ? readOnly ?? false
      : canonicalImportMode === 'direct'
        ? readOnly ?? false
        : true
    : readOnly

  return {
    id,
    title,
    ...(teamBinding ? { teamBinding: { teamProjectId: teamBinding.teamProjectId as string, memberId: teamBinding.memberId as string } } : {}),
    config,
    // No turn can survive a process restart, so nothing is "running".
    status: zcodeStateInvalid ? 'error' : pendingWorktree || config.worktree && config.worktree.state !== 'ready' && !nativeSessionId ? 'draft' : normalizeStatus(status),
    ...(pendingWorktree ? { worktreeTask, worktreeTaskError: typeof value.worktreeTaskError === 'string' ? value.worktreeTaskError : '任务准备已中断，请重试' } : {}),
    createdAt: createdAt as number,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(zcodeState ? { zcodeState } : {}),
    ...(zcodeStateInvalid ? { zcodeStateInvalid: true as const } : {}),
    ...(pendingClaudeFork ? { pendingClaudeFork } : {}),
    ...(origin === undefined ? {} : { origin }),
    ...(archived === undefined ? {} : { archived }),
    ...(pinned === undefined ? {} : { pinned }),
    ...(titleLocked === undefined ? {} : { titleLocked }),
    ...(handoffId === undefined ? {} : { handoffId }),
    ...(continuedHandoff ? { handoffUserContinued: true } : {}),
    ...(canonicalReadOnly === undefined ? {} : { readOnly: canonicalReadOnly }),
    ...(canonicalImportMode === undefined ? {} : { importMode: canonicalImportMode }),
    ...(typeof value.previousSessionId === 'string' ? { previousSessionId: value.previousSessionId } : {}),
    ...(['new','clear'].includes(String(value.assistantEndReason)) ? { assistantEndReason: value.assistantEndReason as 'new' | 'clear' } : {}),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(agentContract === undefined ? {} : { agentContract }),
    ...(pendingQueue.length === 0 ? {} : { pendingQueue }),
    ...(submittedUserMessages.length === 0 ? {} : { submittedUserMessages }),
    ...(goal === undefined ? {} : { goal }),
    ...(subagents.length ? { subagents } : {})
  }
}

function parseWorktreeTask(value: unknown): Session['worktreeTask'] {
  if (!isRecord(value)) return undefined
  try {
    if (value.kind === 'native') {
      const action = parseNativeThreadAction(value.action)
      return action.type === 'goal.set' || action.type === 'review.start' ? { kind: 'native', action } : undefined
    }
    if (value.kind !== 'message' || typeof value.prompt !== 'string') return undefined
    const attachments = sanitizeAttachments(value.attachments)
    if (attachments === INVALID_OPTIONAL_FIELD) return undefined
    const selection = value.selection
    if (selection !== undefined && (!isRecord(selection) || !Array.isArray(selection.candidateIds) || selection.candidateIds.some(id => typeof id !== 'string'))) return undefined
    return { kind: 'message', prompt: value.prompt, ...(attachments ? { attachments } : {}),
      ...(isRecord(selection) ? { selection: { candidateIds: selection.candidateIds as string[] } } : {}),
      ...(value.activatePlan === true ? { activatePlan: true } : {}) }
  } catch { return undefined }
}

function parseSideChatRow(
  value: unknown,
  normalizeConfig?: (config: SessionConfig) => SessionConfig
): PersistedSideChat | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.sessionId) || !Array.isArray(value.events)) return undefined
  const parsedConfig = parseSessionConfig(value.config)
  if (!parsedConfig) return undefined
  const events = value.events.flatMap((event) => {
    if (
      !isRecord(event) ||
      !Number.isSafeInteger(event.seq) ||
      (event.seq as number) < 0 ||
      !isNonNegativeFiniteNumber(event.ts) ||
      !EVENT_TYPES.has(event.type as UAEvent['type']) ||
      !isRecord(event.payload) ||
      (event.state !== undefined && !EVENT_STATES.has(event.state as UAEvent['state']))
    ) return []
    return [{
      sessionId: value.sessionId as string,
      seq: event.seq as number,
      ts: event.ts,
      type: event.type as UAEvent['type'],
      ...(event.state === undefined ? {} : { state: event.type === 'approval_request' && event.state === 'pending' && event.payload.method !== 'local/plan' ? 'cancelled' as const : event.state as UAEvent['state'] }),
      payload: event.type === 'approval_request' && event.state === 'pending' && event.payload.method !== 'local/plan'
        ? { ...event.payload, resolved: true, interactionExpired: true }
        : event.payload
    }]
  })
  return {
    sessionId: value.sessionId,
    config: normalizeConfig ? normalizeConfig(parsedConfig) : parsedConfig,
    events,
    queue: sanitizeSideQueue(value.queue),
    ...(isNonEmptyString(value.nativeSessionId) ? { nativeSessionId: value.nativeSessionId.trim() } : {})
  }
}

function sanitizeSideQueue(value: unknown): QueueItem[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.id) || ids.has(item.id) || typeof item.prompt !== 'string') return []
    if (item.state !== undefined && !['pending', 'dispatching', 'steering'].includes(String(item.state))) return []
    const attachments = sanitizeAttachments(item.attachments)
    if (attachments === INVALID_OPTIONAL_FIELD) return []
    ids.add(item.id)
    const nativeContext = sanitizeNativeContext(item.nativeContext)
    const comments = Array.isArray(item.comments) ? item.comments.filter((comment) =>
      isRecord(comment) && typeof comment.quote === 'string' && typeof comment.comment === 'string'
    ).map((comment) => ({ quote: comment.quote as string, comment: comment.comment as string })) : []
    return [{
      id: item.id, prompt: item.prompt,
      ...(item.deliveryUncertain === true || item.state === 'dispatching' || item.state === 'steering' ? { deliveryUncertain: true } : {}),
      ...(attachments ? { attachments } : {}),
      ...(nativeContext ? { nativeContext } : {}),
      ...(typeof item.displayText === 'string' ? { displayText: item.displayText } : {}),
      ...(comments.length ? { comments } : {})
    }]
  })
}

const MAX_SUBMITTED_USER_MESSAGES = 200

function sanitizeSubmittedUserMessages(value: unknown): SubmittedUserMessage[] {
  if (!Array.isArray(value)) return []
  const messages: SubmittedUserMessage[] = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.type !== 'user_message' && candidate.type !== 'goal_message') ||
      !Number.isSafeInteger(candidate.userOrdinal) ||
      (candidate.userOrdinal as number) < 0 ||
      typeof candidate.textHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.textHash) ||
      !Number.isSafeInteger(candidate.acceptedAt) ||
      (candidate.acceptedAt as number) < 0 ||
      (candidate.command !== undefined && candidate.command !== 'plan' && candidate.command !== 'goal')
    ) continue
    const attachments = sanitizeAttachments(candidate.attachments)
    if (attachments === INVALID_OPTIONAL_FIELD) continue
    const nativeContext = sanitizeNativeContext(candidate.nativeContext)
    messages.push({
      type: candidate.type,
      ...(candidate.appendedToTurn === true ? { appendedToTurn: true } : {}),
      ...(candidate.source === 'feishu' || candidate.source === 'weixin' || candidate.source === 'app' || candidate.source === 'mcp'
        ? { source: candidate.source }
        : {}),
      userOrdinal: candidate.userOrdinal as number,
      textHash: candidate.textHash,
      ...(typeof candidate.assistantText === 'string' && candidate.assistantText.length <= 65536 ? { assistantText: candidate.assistantText } : {}),
      ...(typeof candidate.assistantMessageId === 'string' && /^[\w-]{1,100}$/.test(candidate.assistantMessageId) ? { assistantMessageId: candidate.assistantMessageId } : {}),
      acceptedAt: candidate.acceptedAt as number,
      ...(candidate.command === undefined ? {} : { command: candidate.command }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(nativeContext === undefined ? {} : { nativeContext })
    })
  }
  return messages.slice(-MAX_SUBMITTED_USER_MESSAGES)
}

const GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
])

/** A bounded roster retains child identities; live states cannot survive restart. */
function sanitizeSubAgents(value: unknown, restored = false): UASubAgent[] {
  if (!Array.isArray(value)) return []
  const statuses = new Set(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'])
  const seen = new Set<string>()
  const result: UASubAgent[] = []
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500 &&
    id === id.trim() && !/[\u0000-\u001f\u007f]/.test(id)
  for (const row of value.slice(0, 1000)) {
    if (!isRecord(row) || !validId(row.agentThreadId) || seen.has(row.agentThreadId) || !statuses.has(String(row.status))) continue
    if (row.parentThreadId !== undefined && !validId(row.parentThreadId) || row.nativeTaskId !== undefined && !validId(row.nativeTaskId)) continue
    seen.add(row.agentThreadId)
    const child: UASubAgent = { agentThreadId: row.agentThreadId,
      status: restored && (row.status === 'running' || row.status === 'pendingInit') ? 'interrupted' : row.status as UASubAgent['status'] }
    for (const key of ['name', 'parentThreadId', 'nativeTaskId', 'dispatchId', 'tool', 'message', 'prompt'] as const) {
      if (typeof row[key] === 'string' && row[key].length <= 64_000) child[key] = row[key]
    }
    for (const key of ['generation', 'startedAt', 'endedAt'] as const) {
      if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) child[key] = row[key]
    }
    const tokens = row.tokens
    if (isRecord(tokens) && ['inputTokens', 'outputTokens', 'totalTokens'].every(key =>
      typeof tokens[key] === 'number' && Number.isFinite(tokens[key]) && tokens[key] >= 0)) {
      child.tokens = { inputTokens: tokens.inputTokens as number, outputTokens: tokens.outputTokens as number,
        totalTokens: tokens.totalTokens as number }
      if (typeof tokens.cost === 'number' && Number.isFinite(tokens.cost) && tokens.cost >= 0) child.tokens.cost = tokens.cost
    }
    result.push(child)
  }
  return result
}

function sanitizeGoal(value: unknown): Session['goal'] | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.objective) ||
    typeof value.status !== 'string' ||
    !GOAL_STATUSES.has(value.status) ||
    (value.tokenBudget !== null &&
      (!Number.isSafeInteger(value.tokenBudget) || (value.tokenBudget as number) <= 0)) ||
    !isNonNegativeFiniteNumber(value.tokensUsed) ||
    !isNonNegativeFiniteNumber(value.timeUsedSeconds) ||
    !isNonNegativeFiniteNumber(value.createdAt) ||
    !isNonNegativeFiniteNumber(value.updatedAt)
  ) {
    return undefined
  }
  if ((value.continuation !== undefined && value.continuation !== 'native') ||
    (value.autonomous !== undefined && typeof value.autonomous !== 'boolean') ||
    (value.nativeActivation !== undefined && value.nativeActivation !== 'armed' && value.nativeActivation !== 'disarmed') ||
    (value.roundLimit !== undefined && (!isRecord(value.roundLimit) ||
      (value.roundLimit.maxRounds !== null && (!Number.isSafeInteger(value.roundLimit.maxRounds) || (value.roundLimit.maxRounds as number) < 1)) ||
      !Number.isSafeInteger(value.roundLimit.roundsStarted) || (value.roundLimit.roundsStarted as number) < 0)) ||
    (value.blockedReason !== undefined && (!isRecord(value.blockedReason) ||
      !isNonEmptyString(value.blockedReason.code) ||
      (value.blockedReason.message !== undefined && typeof value.blockedReason.message !== 'string')))) return undefined
  return {
    objective: value.objective,
    status: value.status as NonNullable<Session['goal']>['status'],
    tokenBudget: value.tokenBudget as number | null,
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.continuation === 'native' ? { continuation: 'native' as const } : {}),
    ...(typeof value.autonomous === 'boolean' ? { autonomous: value.autonomous } : {}),
    ...(value.nativeActivation === 'armed' || value.nativeActivation === 'disarmed' ? { nativeActivation: value.nativeActivation } : {}),
    ...(isRecord(value.roundLimit) ? { roundLimit: { maxRounds: value.roundLimit.maxRounds as number | null, roundsStarted: value.roundLimit.roundsStarted as number } } : {}),
    ...(isRecord(value.blockedReason) ? { blockedReason: { code: value.blockedReason.code as string,
      ...(typeof value.blockedReason.message === 'string' ? { message: value.blockedReason.message } : {}) } } : {})
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseSessionConfig(value: unknown): Session['config'] | undefined {
  if (!isRecord(value)) return undefined

  const agentId = value.agentId
  if (!isNonEmptyString(agentId)) return undefined

  const projectId = parseOptionalNonEmptyString(value.projectId)
  if (projectId === INVALID_OPTIONAL_FIELD) return undefined

  const requirementId = parseOptionalNonEmptyString(value.requirementId)
  if (requirementId === INVALID_OPTIONAL_FIELD) return undefined

  const worktree = value.worktree === undefined ? undefined : parseSessionWorktree(value.worktree)
  if (value.worktree !== undefined && (!worktree || worktree.projectId !== projectId)) return undefined

  const workdir = value.workdir
  if (projectId === undefined && !isNonEmptyString(workdir)) return undefined
  if (workdir !== undefined && !isNonEmptyString(workdir)) return undefined

  const additionalDirectories = value.additionalDirectories === undefined
    ? undefined
    : Array.isArray(value.additionalDirectories) && value.additionalDirectories.every(isNonEmptyString)
      ? value.additionalDirectories as string[]
      : INVALID_OPTIONAL_FIELD
  if (additionalDirectories === INVALID_OPTIONAL_FIELD) return undefined

  const permissionMode = parseOptionalPermissionMode(value.permissionMode)
  if (permissionMode === INVALID_OPTIONAL_FIELD) return undefined

  const model = parseOptionalString(value.model)
  if (model === INVALID_OPTIONAL_FIELD) return undefined
  const zcodeModelSelection = value.zcodeModelSelection === undefined ? undefined : sanitizeZCodeSelection(value.zcodeModelSelection)
  if (value.zcodeModelSelection !== undefined && !zcodeModelSelection) return undefined

  const modelSource = value.modelSource
  if (modelSource !== undefined && (!isRecord(modelSource) ||
      !['native', 'third-party', 'local'].includes(String(modelSource.kind)) ||
      (modelSource.kind !== 'native' && !isNonEmptyString(modelSource.sourceId)))) return undefined

  const effort = parseOptionalReasoningEffort(value.effort)
  if (effort === INVALID_OPTIONAL_FIELD) return undefined

  const kimiThinking = parseOptionalNonEmptyString(value.kimiThinking)
  if (kimiThinking === INVALID_OPTIONAL_FIELD) return undefined
  const kimiRuntimeOwnerId = parseOptionalNonEmptyString(value.kimiRuntimeOwnerId)
  if (kimiRuntimeOwnerId === INVALID_OPTIONAL_FIELD) return undefined
  const kimiDataHome = parseOptionalNonEmptyString(value.kimiDataHome)
  if (kimiDataHome === INVALID_OPTIONAL_FIELD || kimiDataHome !== undefined && (!isAbsolute(kimiDataHome) || kimiDataHome.includes('\0'))) return undefined
  const nikaBinding = value.nikaBinding
  if (nikaBinding !== undefined && (!isRecord(nikaBinding) || !isNonEmptyString(nikaBinding.home) || !isAbsolute(nikaBinding.home) || nikaBinding.home.includes('\0') ||
      !Number.isInteger(nikaBinding.portBase) || Number(nikaBinding.portBase) < 1024 || Number(nikaBinding.portBase) > 65533)) return undefined

  const collaborationMode = parseOptionalCollaborationMode(value.collaborationMode)
  if (collaborationMode === INVALID_OPTIONAL_FIELD) return undefined

  const fastMode = parseOptionalBoolean(value.fastMode)
  if (fastMode === INVALID_OPTIONAL_FIELD) return undefined

  const maxMode = parseOptionalBoolean(value.maxMode)
  if (maxMode === INVALID_OPTIONAL_FIELD) return undefined

  const initializationTargetAgentId = parseOptionalNonEmptyString(value.initializationTargetAgentId)
  if (initializationTargetAgentId === INVALID_OPTIONAL_FIELD) return undefined

  const initializationJobId = parseOptionalNonEmptyString(value.initializationJobId)
  if (initializationJobId === INVALID_OPTIONAL_FIELD) return undefined

  const roleSnapshot = value.roleSnapshot === undefined
    ? undefined
    : parseAgentRole(value.roleSnapshot)
  if (value.roleSnapshot !== undefined && !roleSnapshot) return undefined

  const assistantSnapshot = parseAssistantSnapshot(value.assistantSnapshot)
  if (value.assistantSnapshot !== undefined && !assistantSnapshot) return undefined
  return {
    ...(assistantSnapshot ? { assistantSnapshot } : {}),
    ...(assistantSnapshot && value.assistantChannel === 'weixin' ? { assistantChannel: 'weixin' as const } : {}),
    agentId,
    ...(model === undefined ? {} : { model }),
    ...(zcodeModelSelection ? { zcodeModelSelection } : {}),
    ...(modelSource === undefined ? {} : { modelSource: modelSource as unknown as SessionConfig['modelSource'] }),
    ...(effort === undefined ? {} : { effort }),
    ...(kimiThinking === undefined ? {} : { kimiThinking }),
    ...(kimiRuntimeOwnerId === undefined ? {} : { kimiRuntimeOwnerId }),
    ...(kimiDataHome === undefined ? {} : { kimiDataHome }),
    ...(isRecord(nikaBinding) ? { nikaBinding: { home: nikaBinding.home as string, portBase: nikaBinding.portBase as number } } : {}),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(typeof value.workspaceNotice === 'string' ? { workspaceNotice: value.workspaceNotice.slice(0, 4096) } : {}),
    ...(requirementId === undefined ? {} : { requirementId }),
    workdir: isNonEmptyString(workdir) ? workdir : '',
    ...(additionalDirectories === undefined ? {} : { additionalDirectories: [...additionalDirectories] }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(fastMode === undefined ? {} : { fastMode }),
    ...(maxMode === undefined ? {} : { maxMode }),
    ...(initializationTargetAgentId === undefined ? {} : { initializationTargetAgentId }),
    ...(initializationJobId === undefined ? {} : { initializationJobId }),
    ...(roleSnapshot === undefined ? {} : { roleSnapshot })
  }
}

const SESSION_STATUSES = new Set<Session['status']>([
  'draft',
  'running',
  'queued',
  'awaiting-approval',
  'cancelling',
  'cancelled',
  'interrupted',
  'error',
  'completed',
  'idle',
  'archived'
])
const EVENT_STATES = new Set<UAEvent['state']>([
  'pending', 'running', 'success', 'failed', 'cancelled'
])
const EVENT_TYPES = new Set<UAEvent['type']>([
  'user_message', 'goal_message', 'agent_message', 'reasoning', 'command_exec',
  'file_change', 'tool_call', 'hook', 'approval_request', 'diff_update',
  'background_task',
  'context_compaction', 'error', 'system_notice', 'raw_output', 'turn_started',
  'turn_completed', 'queue_status', 'plan_update', 'subagent'
])

function parseSessionStatus(value: unknown): Session['status'] | undefined {
  return typeof value === 'string' && SESSION_STATUSES.has(value as Session['status'])
    ? (value as Session['status'])
    : undefined
}

const INVALID_OPTIONAL_FIELD = Symbol('SessionStore.invalidOptionalField')
type OptionalFieldResult<T> = T | undefined | typeof INVALID_OPTIONAL_FIELD

function parseOptionalString(value: unknown): OptionalFieldResult<string> {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : INVALID_OPTIONAL_FIELD
}

function parseOptionalNonEmptyString(value: unknown): OptionalFieldResult<string> {
  if (value === undefined) return undefined
  return isNonEmptyString(value) ? value : INVALID_OPTIONAL_FIELD
}

function parseOptionalBoolean(value: unknown): OptionalFieldResult<boolean> {
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : INVALID_OPTIONAL_FIELD
}

function parseOptionalFiniteNumber(value: unknown): OptionalFieldResult<number> {
  if (value === undefined) return undefined
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : INVALID_OPTIONAL_FIELD
}

function parseOptionalReasoningEffort(value: unknown): OptionalFieldResult<ReasoningEffort> {
  if (value === undefined) return undefined
  return isReasoningEffort(value) ? (value as ReasoningEffort) : INVALID_OPTIONAL_FIELD
}

function parseOptionalPermissionMode(value: unknown): OptionalFieldResult<PermissionMode> {
  if (value === undefined) return undefined
  return isPermissionMode(value) ? value : INVALID_OPTIONAL_FIELD
}

function parseOptionalCollaborationMode(
  value: unknown
): OptionalFieldResult<NonNullable<Session['config']['collaborationMode']>> {
  if (value === undefined) return undefined
  return value === 'default' || value === 'plan' ? value : INVALID_OPTIONAL_FIELD
}

function parseOptionalSessionOrigin(value: unknown): OptionalFieldResult<'created' | 'imported'> {
  if (value === undefined) return undefined
  return value === 'created' || value === 'imported' ? value : INVALID_OPTIONAL_FIELD
}

function sanitizePendingQueue(value: unknown, recoverInFlight: boolean, preserveUncertain = false): DurableQueueItem[] {
  if (!Array.isArray(value)) return []
  const queue: DurableQueueItem[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      ids.has(candidate.id) ||
      typeof candidate.prompt !== 'string' ||
      !Number.isSafeInteger(candidate.acceptedAt) ||
      (candidate.acceptedAt as number) < 0 ||
      !Number.isSafeInteger(candidate.attempts) ||
      (candidate.attempts as number) < 0 ||
      (candidate.state !== 'pending' &&
        candidate.state !== 'dispatching' &&
        candidate.state !== 'steering')
    ) {
      continue
    }
    const attachments = sanitizeAttachments(candidate.attachments)
    if (attachments === INVALID_OPTIONAL_FIELD) continue
    const nativeContext = sanitizeNativeContext(candidate.nativeContext)
    ids.add(candidate.id)
    queue.push({
      id: candidate.id,
      prompt: candidate.prompt,
      ...(candidate.source === 'feishu' || candidate.source === 'weixin' || candidate.source === 'app' || candidate.source === 'mcp'
        ? { source: candidate.source }
        : {}),
      ...(attachments === undefined ? {} : { attachments }),
      ...(nativeContext === undefined ? {} : { nativeContext }),
      acceptedAt: candidate.acceptedAt as number,
      ...(candidate.deliveryUncertain === true || recoverInFlight && preserveUncertain && candidate.state !== 'pending'
        ? { deliveryUncertain: true } : {}),
      // Native beta RPCs may already have accepted delivery when the process exits.
      state:
        recoverInFlight && candidate.state !== 'pending'
          ? 'pending'
          : candidate.state,
      attempts: candidate.attempts as number
    })
  }
  return queue
}

function sanitizeNativeContext(value: unknown): DurableQueueItem['nativeContext'] | undefined {
  if (!isRecord(value)) return undefined
  const skills = Array.isArray(value.skills)
    ? value.skills.flatMap((candidate) =>
        isRecord(candidate) && isNonEmptyString(candidate.name) && isNonEmptyString(candidate.path)
          ? [{ name: candidate.name, path: candidate.path }]
          : []
      )
    : []
  const mcpServers = Array.isArray(value.mcpServers)
    ? value.mcpServers.flatMap((candidate) =>
        isRecord(candidate) && isNonEmptyString(candidate.name)
          ? [{ name: candidate.name }]
          : []
      )
    : []
  return skills.length || mcpServers.length ? { skills, mcpServers } : undefined
}

function sanitizeAttachments(
  value: unknown
): OptionalFieldResult<DurableQueueItem['attachments']> {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return INVALID_OPTIONAL_FIELD
  const attachments: NonNullable<DurableQueueItem['attachments']> = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== 'image' && candidate.kind !== 'file') ||
      !isNonEmptyString(candidate.path) ||
      !isNonEmptyString(candidate.name) ||
      (candidate.mime !== undefined && typeof candidate.mime !== 'string')
    ) {
      return INVALID_OPTIONAL_FIELD
    }
    attachments.push({
      kind: candidate.kind,
      path: candidate.path,
      name: candidate.name,
      ...(candidate.mime === undefined ? {} : { mime: candidate.mime })
    })
  }
  return attachments
}

function sanitizeReadOnly(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function sanitizeImportMode(value: unknown): Session['importMode'] | undefined {
  return value === 'snapshot' || value === 'direct' ? value : undefined
}

function sanitizeForkedFrom(value: unknown): Session['forkedFrom'] | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.agentId) ||
    !isNonEmptyString(value.nativeId) ||
    (value.mode !== 'same' && value.mode !== 'cross' && value.mode !== 'compatible')
  ) {
    return undefined
  }
  return { agentId: value.agentId, nativeId: value.nativeId, mode: value.mode }
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const PERMISSION_MODES = new Set<PermissionMode>(PERMISSION_MODE_IDS)

function sanitizeAgentContract(value: unknown): SessionAgentContract | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.permissionModes) ||
    typeof value.imageAttachments !== 'boolean' ||
    typeof value.fileAttachments !== 'boolean' ||
    typeof value.sessionList !== 'boolean' ||
    typeof value.sessionLoad !== 'boolean' ||
    typeof value.sessionResume !== 'boolean' ||
    typeof value.sessionFork !== 'boolean' ||
    !Array.isArray(value.commands) ||
    !value.commands.every(isNonEmptyString) ||
    (value.collaborationModes !== undefined && (
      !Array.isArray(value.collaborationModes) ||
      !value.collaborationModes.every((mode) => mode === 'default' || mode === 'plan')
    ))
  ) {
    return undefined
  }

  const models: ModelDef[] = []
  for (const candidate of value.models) {
    const model = sanitizeModel(candidate)
    if (!model) return undefined
    models.push(model)
  }

  const permissionModes: PermissionModeDef[] = []
  for (const candidate of value.permissionModes) {
    const mode = sanitizePermissionMode(candidate)
    if (!mode) return undefined
    permissionModes.push(mode)
  }

  const currentModelId = value.currentModelId
  if (currentModelId !== undefined && !isNonEmptyString(currentModelId)) return undefined
  const currentPermissionMode = value.currentPermissionMode
  if (currentPermissionMode !== undefined && !isPermissionMode(currentPermissionMode)) return undefined

  return {
    models,
    ...(currentModelId === undefined ? {} : { currentModelId }),
    permissionModes,
    ...(currentPermissionMode === undefined ? {} : { currentPermissionMode }),
    imageAttachments: value.imageAttachments,
    fileAttachments: value.fileAttachments,
    sessionList: value.sessionList,
    sessionLoad: value.sessionLoad,
    sessionResume: value.sessionResume,
    ...(typeof value.steer === 'boolean' ? { steer: value.steer } : {}),
    ...(typeof value.followup === 'boolean' ? { followup: value.followup } : {}),
    sessionFork: value.sessionFork,
    ...(typeof value.sessionForkAtTurn === 'boolean' ? { sessionForkAtTurn: value.sessionForkAtTurn } : {}),
    ...(typeof value.crossAgentFork === 'boolean' ? { crossAgentFork: value.crossAgentFork } : {}),
    ...(typeof value.sideChat === 'boolean' ? { sideChat: value.sideChat } : {}),
    ...(typeof value.structuredSubagents === 'boolean' ? { structuredSubagents: value.structuredSubagents } : {}),
    ...(typeof value.formElicitation === 'boolean' ? { formElicitation: value.formElicitation } : {}),
    ...(typeof value.freeTextElicitation === 'boolean' ? { freeTextElicitation: value.freeTextElicitation } : {}),
    ...(typeof value.nativeGoal === 'boolean' ? { nativeGoal: value.nativeGoal } : {}),
    ...(typeof value.nativeReview === 'boolean' ? { nativeReview: value.nativeReview } : {}),
    ...(typeof value.structuredUsage === 'boolean' ? { structuredUsage: value.structuredUsage } : {}),
    ...(typeof value.capabilityInventory === 'boolean' ? { capabilityInventory: value.capabilityInventory } : {}),
    ...(typeof value.additionalDirectoriesNew === 'boolean' ? { additionalDirectoriesNew: value.additionalDirectoriesNew } : {}),
    ...(typeof value.additionalDirectoriesResume === 'boolean' ? { additionalDirectoriesResume: value.additionalDirectoriesResume } : {}),
    commands: [...value.commands],
    ...(Array.isArray(value.collaborationModes)
      ? { collaborationModes: [...new Set(value.collaborationModes)] }
      : {})
  }
}

function sanitizeModel(value: unknown): ModelDef | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    typeof value.label !== 'string' ||
    !Array.isArray(value.efforts) ||
    !value.efforts.every(isReasoningEffort)
  ) {
    return undefined
  }

  const defaultEffort = value.defaultEffort
  if (
    defaultEffort !== undefined &&
    (!isReasoningEffort(defaultEffort) || !value.efforts.includes(defaultEffort))
  ) {
    return undefined
  }
  const contextWindow = value.contextWindow
  if (
    contextWindow !== undefined &&
    (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0)
  ) {
    return undefined
  }
  const loadPercent = value.loadPercent
  if (
    loadPercent !== undefined &&
    (typeof loadPercent !== 'number' || !Number.isFinite(loadPercent) || loadPercent < 0)
  ) {
    return undefined
  }
  const supportsFast = value.supportsFast
  if (supportsFast !== undefined && typeof supportsFast !== 'boolean') return undefined
  const zcodeSelection = value.zcodeSelection === undefined ? undefined : sanitizeZCodeSelection(value.zcodeSelection)
  if (value.zcodeSelection !== undefined && !zcodeSelection) return undefined

  return {
    id: value.id,
    label: value.label,
    efforts: [...value.efforts],
    ...(zcodeSelection ? { zcodeSelection } : {}),
    ...(Array.isArray(value.zcodeThoughtLevels) && value.zcodeThoughtLevels.every(isNonEmptyString) ? { zcodeThoughtLevels: [...value.zcodeThoughtLevels] } : {}),
    ...(Array.isArray(value.thinkingOptions) && value.thinkingOptions.every(isNonEmptyString) ? { thinkingOptions: [...value.thinkingOptions] as string[] } : {}),
    ...(typeof value.imageInput === 'boolean' ? { imageInput: value.imageInput } : {}),
    ...(isNonEmptyString(value.defaultThinking) ? { defaultThinking: value.defaultThinking } : {}),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(contextWindow === undefined ? {} : { contextWindow: contextWindow as number }),
    ...(loadPercent === undefined ? {} : { loadPercent }),
    ...(supportsFast === undefined ? {} : { supportsFast })
  }
}

function sanitizePermissionMode(value: unknown): PermissionModeDef | undefined {
  if (
    !isRecord(value) ||
    !isPermissionMode(value.id) ||
    typeof value.label !== 'string' ||
    typeof value.hint !== 'string'
  ) {
    return undefined
  }
  return { id: value.id, label: value.label, hint: value.hint }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort)
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as PermissionMode)
}

/** Explicit persistence boundary: process-local renderer coordinates are never serialized. */
export function sessionMetadata(s: Session): Record<string, unknown> {
  return serializeSession(s)
}

/** Any in-flight status on load becomes idle; durable terminal states survive. */
function normalizeStatus(status: Session['status']): Session['status'] {
  if (
    status === 'running' ||
    status === 'queued' ||
    status === 'awaiting-approval' ||
    status === 'cancelling' ||
    status === 'draft'
  ) {
    return 'idle'
  }
  return status || 'idle'
}
