import { EventEmitter } from 'node:events'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  fchmodSync, openSync, readFileSync, readdirSync, writeFileSync
} from 'node:fs'
import {
  chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, stat, symlink, writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentsStrategy, CapabilityExecuteRequest, CapabilityJobErrorCode, CapabilityJobSnapshot, CapabilityMarkdownPreview,
  CapabilityInventorySyncPreparation, CapabilityInventorySyncRequest, CapabilityPlanRequest, CapabilityRollbackCandidate, CapabilityScanRequest, CapabilityScanResult, CapabilitySyncJob,
  CapabilitySyncPlan, CapabilityProviderId
} from '../../shared/capabilitySync.ts'
import { isUuid } from '../../shared/capabilitySync.ts'
import { buildPlan, diffInventories, semanticHash, type CanonicalCapability, type Inventory } from './planner.ts'
import {
  AtomicFsError, atomicRemoveIdentitySync, atomicRenameAnchoredSync, helperAvailable, processStartIdentitySync,
  type AtomicFsEntryIdentity, type AtomicFsParentIdentity, type AtomicFsSourceIdentity
} from './atomicFs.ts'
import {
  assertSafeDestination, assertSafePathChain, cloneToml, discoverProvider, ensurePrivateDirectory, mcpRecord,
  mergeMcpCredentialSafe, parseMcpBlocks, parseToml, providerPaths, rootPreference, setMcpServer, setRootPreference,
  stringifyToml, validateSkillTree, type TomlRecord
} from './provider.ts'
import { listCapabilityInventories, managedInventoryId } from './inventory.ts'

interface AgentsInputs { codex?: string; traex?: string; shared?: string }
interface PrivateScan { public: CapabilityScanResult; sourceInv: Inventory; targetInv: Inventory; agents: AgentsInputs }
interface PrivatePlan { public: CapabilitySyncPlan; scan: PrivateScan; request: CapabilityPlanRequest }
type EntryType = 'file' | 'directory' | 'symlink'
type JournalState = 'backing_up' | 'staging' | 'ready' | 'committing' | 'verifying' | 'completed' | 'rolling_back' | 'rolled_back' | 'aborted'
type RenameLeg = 'target_to_slot' | 'stage_to_target' | 'target_to_post' | 'slot_to_target' | 'preparation_to_transaction'
interface RenameIntent {
  version: 1
  leg: RenameLeg
  entryIndex?: number
  anchorName: string
  expectedSource: { dev: string; ino: string; type: EntryType }
}
interface SealedPathState { exists: boolean; type?: EntryType; mode?: number; dev?: string; ino?: string; link?: string; digest?: string }
interface ParentIdentity { targetRel: string; mode: number; dev: string; ino: string }
interface BackupEntry {
  targetRel: string
  backupName: string
  existed: boolean
  backedUp: boolean
  type?: EntryType
  mode?: number
  link?: string
  digest?: string
  expectedPreState: SealedPathState
  expectedPostState?: SealedPathState
  stageIdentity?: PathIdentity
  parentChain?: ParentIdentity[]
}
interface Journal {
  version: 1 | 2 | 3 | 4
  sealVersion: 1
  seal: string
  transactionRootIdentity?: TransactionRootIdentity
  id: string
  provider: 'codex' | 'traex'
  sharedAgents: boolean
  planId: string
  state: JournalState
  commitIndex: number
  rollbackIndex: number
  createdAt: number
  completedAt?: number
  updatedAt: number
  transactionOrder?: number
  preparationNonce?: string
  transactionLocation?: 'seed' | 'preparation' | 'canonical'
  renameIntent?: RenameIntent
  entries: BackupEntry[]
  rollbackKind?: 'automatic' | 'manual'
  cleanup?: { index: number; artifact: CleanupArtifactKind }
  job: CapabilitySyncJob
}
interface StagedEntry { target: string; stage: string; slot: string; post: string; remove: boolean; type: EntryType; index: number }
interface ExpectedState { fingerprints: Map<string, string>; agentsFingerprint?: string }
interface PathIdentity { dev: string; ino: string; parentDev: string; parentIno: string; parentMode: number }
interface TransactionRootIdentity extends PathIdentity { type: 'directory' }
interface OwnedPathIdentity { parent: AtomicFsParentIdentity; entry: AtomicFsEntryIdentity }
interface RenameNames {
  parent: string
  sourceName: string
  targetName: string
  parentIdentity: AtomicFsParentIdentity
  journalDirectoryName: string
  nextJournalDirectoryName: string
}
interface OperationRootIdentity {
  dataRoot: OwnedPathIdentity
  dataRootDirectory: AtomicFsParentIdentity
  transactions: OwnedPathIdentity
  transactionsDirectory: AtomicFsParentIdentity
}
interface OperationRootAnchor { path: string; fd: number; parent: AtomicFsParentIdentity; entry: AtomicFsEntryIdentity; roots: OperationRootIdentity }
type CleanupArtifactKind = 'slot' | 'stage' | 'post'
interface RecoveredJournal { journal: Journal; transactionName: string; directoryIdentity: OwnedPathIdentity }

const TERMINAL = new Set(['completed', 'failed_no_change', 'rolled_back', 'rollback_failed', 'cancelled'])
const JOURNAL_STATES = new Set<JournalState>(['backing_up', 'staging', 'ready', 'committing', 'verifying', 'completed', 'rolling_back', 'rolled_back', 'aborted'])
const MAX_ENTRIES = 5000
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const JOURNAL_KEY_BYTES = 32
const OPERATION_LOCK_KEY_BYTES = 32
const OPERATION_LOCK_START_DOMAIN = 'UniAgent/capability-sync/operation-lock/start/v2'
const TRANSACTION_PREPARATION_DOMAIN = 'UniAgent/capability-sync/transaction-preparation/v2'
const RENAME_ANCHOR_ARTIFACT = /^\.ua-rn-v1-[a-f0-9]{32}$/
const TERMINAL_TRANSACTION_RETENTION = 8
const MEMORY_NAMES = ['MEMORY.md', 'memory.md', 'preferences.md', 'PREFERENCES.md']
const JOB_STATES = new Set(['idle','scanning','scanned','planning','ready','blocked','backing_up','staging','committing','verifying','completed','failed_no_change','rolling_back','rolled_back','rollback_failed','cancelled'])
const JOB_ERRORS = new Set<CapabilityJobErrorCode>(['cancelled','stale_plan','backup_failed','stage_failed','stage_validation_failed','commit_failed','verification_failed','startup_recovery','rollback_failed','atomic_fs_unavailable','internal_error'])
const JOB_STAGES = new Set([
  'validating_revisions','revision_changed','source_revision_changed','target_revision_changed','cancelled_before_write','cancellation_requested','transaction_setup_failed',
  'backing_up','staging','committing','static_validation','native_validation_pending','no_target_change','rolling_back',
  'rollback_completed','recovery_required','unexpected_failure'
])
interface OperationLock {
  path: string
  token: string
  processStartToken: string
  fd: number
  roots: OperationRootIdentity
  anchor: OperationRootAnchor
  releasePending?: boolean
  releasePath?: string
}
interface OperationRootAnchorRecord {
  version: 1
  pid: number
  token: string
  processStartIdentity: string
  createdAt: number
  dataRootIdentity: TransactionRootIdentity
  transactionsIdentity: TransactionRootIdentity
}
const PROCESS_OPERATION_LOCKS = new Map<string, OperationLock>()

/** Test-only crash sentinel. It deliberately leaves the durable journal for startup recovery. */
export class CapabilitySyncSimulatedCrash extends Error {
  readonly simulateCrash = true
  constructor() { super('simulated_crash') }
}

export class CapabilitySyncService extends EventEmitter {
  private scans = new Map<string, PrivateScan>()
  private plans = new Map<string, PrivatePlan>()
  private jobs = new Map<string, CapabilitySyncJob>()
  private locks = new Set<string>()
  private lockIdleWaiters = new Set<() => void>()
  private cancelled = new Set<string>()
  private faultInjector?: (stage: string) => void
  private recoveryBlocked = false
  private journalSealKey?: Buffer
  private journalSealKeyRoot?: OwnedPathIdentity
  private operationLockSealKey?: Buffer
  private operationLockSealKeyRoot?: OwnedPathIdentity
  private operationLock?: OperationLock
  private rollbackCandidateId?: string
  private home: string
  private dataRoot: string
  private readonly allowedProviders: ReadonlySet<CapabilityProviderId>

  constructor(home = homedir(), dataRoot = join(home, '.uniagent-public/capability-sync'), faultInjector?: (stage: string) => void, providers: readonly CapabilityProviderId[] = ['codex', 'traex']) {
    super()
    this.home = resolve(home)
    this.dataRoot = resolve(dataRoot)
    assertSafeDestination(this.dataRoot, this.home)
    this.faultInjector = faultInjector
    this.allowedProviders = new Set(providers)
  }

  async recover(): Promise<void> {
    if (!helperAvailable()) return
    const transactions = join(this.dataRoot, 'transactions')
    let transactionNames: string[] = []
    try { transactionNames = (await readdir(transactions)).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.setRecoveryBlocked(); return } }
    if (await this.hasRenameAnchorResidue() || await this.hasRawStartupRenameIntent(transactions, transactionNames)) {
      this.setRecoveryBlocked()
      return
    }
    const operationLock = this.acquireOperationLock(true)
    try {
      await this.recoverLocked()
    } finally {
      this.releaseOperationLock(operationLock)
    }
  }

  private async recoverLocked(): Promise<void> {
    let blocked = false
    this.validateOperationRoots()
    const latest = await this.readLatestJob()
    const recovered = new Map<string, RecoveredJournal>()
    const transactions = join(this.dataRoot, 'transactions')
    this.validateOperationRoots()
    const transactionNames = (await readdir(transactions)).sort()
    // An anchored rename residue is evidence that the source may have crossed
    // a namespace boundary without a durably acknowledged publication.  A
    // journal intent carries the same meaning.  Inspect both before recovery
    // performs *any* transaction cleanup or rollback mutation.
    if (await this.hasRenameAnchorResidue() || await this.hasRawStartupRenameIntent(transactions, transactionNames)) {
      this.jobs.clear()
      if (latest) this.jobs.set(latest.id, { ...latest })
      this.rollbackCandidateId = undefined
      this.recoveryBlocked = true
      this.validateOperationRoots()
      return
    }
    for (const name of transactionNames) {
      this.validateOperationRoots()
      const preparationIdentity = await this.authenticatedPreparationIdentity(name)
      if (preparationIdentity) {
        try {
          const path = join(transactions, name)
          const identity = { parent: syncParentIdentity(transactions), entry: preparationIdentity }
          await this.validatePreparationTransaction(path, identity)
          this.removeOwnedPathHandled(path, identity)
        } catch (error) {
          if (error instanceof OperationRootChanged) throw error
          blocked = true
        }
        continue
      }
      const pendingId = pendingTransactionId(name)
      if (pendingId) {
        // Legacy pending names do not authenticate the inode created by this
        // service. Never promote the inode currently occupying the name into
        // deletion authority, even when it contains a valid copied journal.
        blocked = true
        continue
      }
      // A seed is created before its inode is authenticated or any target can
      // be mutated. Preserve this untrusted scratch residue without treating
      // it as recovery authority or blocking future transactions.
      if (isTransactionSeed(name)) continue
      if (!isCanonicalUuid(name)) { blocked = true; continue }
      const txDir = join(transactions, name)
      const journalFile = join(txDir, 'journal.json')
      if (!existsSync(journalFile)) { blocked = true; continue }
      try {
        const record = await this.readJournalRecord(journalFile, name, true)
        const journal = record.journal
        if (journal.state === 'completed') {
          recovered.set(journal.id, record)
          continue
        }
        if (journal.state === 'rolled_back' || journal.state === 'aborted') {
          await this.cleanupArtifacts(journal)
          recovered.set(journal.id, record)
          continue
        }
        if (journal.state === 'backing_up' || journal.state === 'staging' || journal.state === 'ready') {
          await this.finalizeNoChange(journal, 'startup_recovery')
          await this.cleanupArtifacts(journal)
          recovered.set(journal.id, record)
        } else {
          const wasCommitting = journal.state === 'committing'
          journal.state = 'rolling_back'
          journal.rollbackKind ||= 'automatic'
          journal.job = { ...journal.job, state: 'rolling_back', errorCode: 'startup_recovery', updatedAt: Date.now() }
          await this.persistJournal(journal)
          if (wasCommitting) await this.captureInFlightCommit(journal)
          await this.restore(journal)
          journal.state = 'rolled_back'
          journal.job = { ...journal.job, state: 'rolled_back', stage: 'rollback_completed', updatedAt: Date.now(), result: rollbackResult(journal.commitIndex) }
          await this.persistJournal(journal)
          recovered.set(journal.id, record)
        }
      } catch (error) {
        if (error instanceof OperationRootChanged) throw error
        blocked = true
      }
    }
    const recoveredJobs = [...recovered.values()].map(({ journal }) => journal.job)
    const latestHasJournal = !!latest && [...recovered.values()].some(({ journal }) => journal.job.id === latest.id)
    if (latest && !TERMINAL.has(latest.state) && !latest.transactionId && !latestHasJournal) {
      const recovered = { ...latest, state: 'failed_no_change' as const, errorCode: 'startup_recovery' as const, updatedAt: Date.now() }
      recoveredJobs.push(recovered)
    } else if (latest && !latest.transactionId && !latestHasJournal) {
      recoveredJobs.push(latest)
    } else if (latest?.transactionId && !recovered.has(latest.transactionId)) {
      // A latest record naming a missing or rejected transaction cannot be
      // trusted as an independent source of truth. Keep recovery closed.
      blocked = true
    }
    const deduplicatedJobs = deduplicateJobs(recoveredJobs)
    const authoritative = latestCapabilityJob(deduplicatedJobs)
    this.validateOperationRoots()
    this.jobs.clear()
    for (const recoveredJob of deduplicatedJobs) this.jobs.set(recoveredJob.id, { ...recoveredJob })
    if (authoritative && (!latest || authoritative.id !== latest.id || authoritative.updatedAt !== latest.updatedAt || authoritative.state !== latest.state)) {
      await this.persistLatestJob(authoritative)
    }
    let rollbackCandidate: Journal | undefined
    try { rollbackCandidate = latestRollbackCandidate([...recovered.values()].map(({ journal }) => journal)) }
    catch (error) { if (error instanceof OperationRootChanged) throw error; blocked = true }
    if (rollbackCandidate) {
      try { await this.validateCompletedArtifacts(rollbackCandidate) }
      catch (error) { if (error instanceof OperationRootChanged) throw error; blocked = true }
    }
    if (!blocked) {
      this.rollbackCandidateId = rollbackCandidate?.id
      try { await this.pruneTerminalArtifacts(); }
      catch (error) { if (error instanceof OperationRootChanged) throw error; blocked = true }
    }
    this.rollbackCandidateId = blocked ? undefined : rollbackCandidate?.id
    this.recoveryBlocked = blocked
    this.validateOperationRoots()
  }

  private async hasRawStartupRenameIntent(transactions: string, transactionNames: string[]): Promise<boolean> {
    for (const name of transactionNames) {
      const path = join(transactions, name, 'journal.json')
      if (!existsSync(path)) continue
      let value: unknown
      try { value = JSON.parse(await readFile(path, 'utf8')) as unknown }
      catch { continue }
      // The presence of any own, non-null intent is sufficient evidence that
      // an anchored mutation may be in flight. Authentication is required to
      // act on a journal, but never to preserve it and fail closed.
      if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'renameIntent') && value.renameIntent != null) return true
    }
    return false
  }

  private async journalDirectoryName(journal: Journal): Promise<string> {
    if (!journal.preparationNonce || !journal.transactionRootIdentity) throw new Error('invalid_journal')
    if (journal.transactionLocation === 'seed') return `.ua-transaction-seed-${journal.preparationNonce}-${journal.id}`
    if (journal.transactionLocation === 'preparation') return this.preparationTransactionName(
      journal.id, journal.preparationNonce, sourceIdentityFromTransactionRoot(journal.transactionRootIdentity)
    )
    if (journal.transactionLocation === 'canonical') return journal.id
    throw new Error('invalid_journal')
  }

  private async hasRenameAnchorResidue(): Promise<boolean> {
    for (const parent of this.renameParents()) {
      try {
        const info = await lstat(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) continue
        if ((await readdir(parent)).some(isRenameAnchorArtifact)) return true
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true }
    }
    return false
  }

  private renameParents(): string[] {
    const parents = new Set<string>([this.dataRoot, join(this.dataRoot, 'transactions'), join(this.home, '.agents')])
    for (const provider of this.allowedProviders) {
      const paths = providerPaths(provider, this.home)
      parents.add(paths.root); parents.add(paths.skills); parents.add(dirname(paths.config)); parents.add(dirname(paths.agents))
      for (const memory of paths.memories) parents.add(dirname(memory))
    }
    // Include both supported TraeX layouts even when only one is currently
    // authoritative; an anchor from an interrupted older-layout operation is
    // still recovery evidence.
    if (this.allowedProviders.has('traex')) {
      parents.add(join(this.home, '.trae', 'skills')); parents.add(join(this.home, '.trae', 'cli', 'skills'))
      parents.add(join(this.home, '.trae')); parents.add(join(this.home, '.trae', 'cli'))
    }
    return [...parents]
  }

  private async validatePreparationTransaction(path: string, expected: OwnedPathIdentity): Promise<void> {
    await assertSafePathChain(path, this.home)
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077n) !== 0n ||
        info.dev.toString() !== String(expected.entry.dev) || info.ino.toString() !== String(expected.entry.ino)) {
      throw new Error('invalid_pending_transaction')
    }
  }

  private async preparationTransactionName(
    transactionId: string, nonce: string, identity: AtomicFsSourceIdentity
  ): Promise<string> {
    const device = canonicalUnsignedIdentity(identity.dev)
    const inode = canonicalUnsignedIdentity(identity.ino)
    const tag = createHmac('sha256', await this.getJournalSealKey())
      .update(TRANSACTION_PREPARATION_DOMAIN).update('\0').update(nonce).update('\0').update(transactionId)
      .update('\0').update(identity.type).update('\0').update(device).update('\0').update(inode).digest('hex')
    return `.ua-transaction-preparation-${nonce}-${transactionId}-${device}-${inode}-${identity.type}-${tag}`
  }

  private async authenticatedPreparationIdentity(name: string): Promise<AtomicFsSourceIdentity | undefined> {
    const match = /^\.ua-transaction-preparation-([a-f0-9]{32})-([0-9a-f-]{36})-(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})-(directory)-([a-f0-9]{64})$/.exec(name)
    if (!match || !isCanonicalUuid(match[2])) return undefined
    const expected = createHmac('sha256', await this.getJournalSealKey())
      .update(TRANSACTION_PREPARATION_DOMAIN).update('\0').update(match[1]).update('\0').update(match[2])
      .update('\0').update(match[5]).update('\0').update(match[3]).update('\0').update(match[4]).digest('hex')
    return constantTimeHexEqual(match[6], expected)
      ? { dev: match[3], ino: match[4], type: 'directory' }
      : undefined
  }

  private async nextTransactionOrder(transactions: string): Promise<number> {
    this.validateOperationRoots()
    const journals: Journal[] = []
    for (const name of (await readdir(transactions)).sort()) {
      this.validateOperationRoots()
      if (!isCanonicalUuid(name)) continue
      journals.push(await this.readJournal(join(transactions, name, 'journal.json'), name))
    }
    assertUniqueTransactionOrders(journals)
    const maximum = journals.reduce((result, journal) => Math.max(result, journal.transactionOrder || 0), 0)
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('transaction_order_exhausted')
    return maximum + 1
  }

  private async finalizeNoChange(journal: Journal, errorCode: CapabilityJobErrorCode): Promise<void> {
    journal.state = 'aborted'
    journal.commitIndex = 0
    journal.rollbackIndex = 0
    journal.job = {
      ...journal.job, state: 'failed_no_change', errorCode,
      stage: 'no_target_change', progress: { completed: 0, total: journal.entries.length }, updatedAt: Date.now()
    }
    await this.persistJournal(journal)
  }

  async scan(req: CapabilityScanRequest): Promise<CapabilityScanResult> {
    if (!this.allowedProviders.has(req.source) || !this.allowedProviders.has(req.target)) throw new Error('capability_provider_unavailable')
    if (await this.hasRenameAnchorResidue()) this.setRecoveryBlocked()
    const sourceInv = await discoverProvider(req.source, this.home)
    const targetInv = await discoverProvider(req.target, this.home)
    const sourcePaths = providerPaths(req.source, this.home)
    const targetPaths = providerPaths(req.target, this.home)
    const sourceAvailable = existsSync(sourcePaths.root)
    const targetAvailable = existsSync(targetPaths.root)
    const atomicFsAvailable = helperAvailable()
    const executionSupported = !!(sourceAvailable && targetAvailable && sourceInv.layoutKnown && targetInv.layoutKnown &&
      atomicFsAvailable && !this.recoveryBlocked)
    const result: CapabilityScanResult = {
      id: randomUUID(),
      source: req.source,
      target: req.target,
      sourceRevision: sourceInv.revision,
      targetRevision: targetInv.revision,
      scannedAt: Date.now(),
      sourceAvailable,
      targetAvailable,
      executionSupported,
      blockedReason: executionSupported ? undefined : this.recoveryBlocked ? 'recovery_required'
        : !atomicFsAvailable ? 'atomic_fs_unavailable' : 'unsupported_provider_layout',
      items: diffInventories(sourceInv, targetInv)
    }

    const sourceById = new Map(sourceInv.items.map((item) => [item.id, item]))
    const targetById = new Map(targetInv.items.map((item) => [item.id, item]))
    for (let index = 0; index < result.items.length; index++) {
      const item = result.items[index]
      if (item.kind !== 'mcp' || !item.selectable) continue
      const source = sourceById.get(item.id)
      const target = targetById.get(item.id)
      if (!source) continue
      try {
        const merged = mergeMcpCredentialSafe(await this.mcpValue(source), target ? await this.mcpValue(target) : undefined)
        if (merged.credentialRequired) result.items[index] = { ...item, status: 'invalid', compatible: false, selectable: false, cloneSafe: false, defaultSelected: false, issueCode: 'credential_required' }
      } catch {
        result.items[index] = { ...item, status: 'invalid', compatible: false, selectable: false, cloneSafe: false, defaultSelected: false, issueCode: 'invalid_mcp_schema' }
      }
    }

    const agents = await this.readAgentsInputs(sourceInv, targetInv, req.source)
    result.items = result.items.filter((item) => item.kind !== 'global-instructions')
    const agentsItem = this.agentsItem(agents, sourceInv, targetInv)
    if (agentsItem) result.items.push(agentsItem)
    this.scans.set(result.id, { public: result, sourceInv, targetInv, agents })
    return result
  }

  /** Resolve capability-center opaque ids into the canonical ids of a fresh sync scan. */
  async prepareInventorySelection(req: CapabilityInventorySyncRequest): Promise<CapabilityInventorySyncPreparation> {
    if (!this.allowedProviders.has(req.source) || !this.allowedProviders.has(req.target) || req.source === req.target || !['codex', 'traex'].includes(req.source) || !['codex', 'traex'].includes(req.target) ||
        !req.selections.length || req.selections.length > 1000 || new Set(req.selections).size !== req.selections.length) {
      throw new Error('invalid_selection')
    }
    const inventories = await listCapabilityInventories(this.home, undefined, undefined, [...this.allowedProviders, 'claude'])
    const sourceInventory = inventories.inventories.find((inventory) => inventory.agentId === req.source)
    if (!sourceInventory) throw new Error('invalid_selection')
    const requested = new Set(req.selections)
    const allowed = new Set(sourceInventory.items
      .filter((item) => item.scope === 'agent' && item.owner === 'user' && item.copyable && requested.has(item.id))
      .map((item) => item.id))
    if (allowed.size !== requested.size) throw new Error('invalid_selection')

    const publicScan = await this.scan({ source: req.source, target: req.target })
    const privateScan = this.scans.get(publicScan.id)
    if (!privateScan) throw new Error('scan_not_found')
    const canonicalByOpaque = new Map(privateScan.sourceInv.items
      .filter((item) => item.owner === 'user' && item.compatible)
      .map((item) => [managedInventoryId(req.source, item.id), item.id]))
    const selectable = new Set(publicScan.items.filter((item) => item.selectable).map((item) => item.id))
    const selections = req.selections
      .map((id) => canonicalByOpaque.get(id))
      .filter((id): id is string => !!id && selectable.has(id))
    if (selections.length !== req.selections.length || new Set(selections).size !== selections.length) throw new Error('stale_plan')
    return { scan: publicScan, selections }
  }

  plan(req: CapabilityPlanRequest): CapabilitySyncPlan {
    const scan = this.scans.get(req.scanId)
    if (!scan) throw new Error('scan_not_found')
    let agentsMergeConflict = false
    if (req.agentsStrategy === 'merge') {
      try { mergeMarkdownInputs(scan.agents) } catch { agentsMergeConflict = true }
    }
    const plan = buildPlan({
      id: randomUUID(), scanId: req.scanId, source: scan.public.source, target: scan.public.target,
      sourceRevision: scan.public.sourceRevision, targetRevision: scan.public.targetRevision, mode: req.mode,
      cloneCategories: req.cloneCategories,
      items: scan.public.items, selections: req.selections, resolutions: req.resolutions, agentsStrategy: req.agentsStrategy,
      agentsMergeConflict
    })
    if (req.selections.includes('global-instructions:agents') && req.agentsStrategy && !this.agentsContent(req.agentsStrategy, scan.agents, false)) {
      plan.blockedReasons.push(req.agentsStrategy === 'merge' ? 'agents_merge_conflict' : 'invalid_selection')
    }
    if (!scan.public.executionSupported) plan.blockedReasons.push(scan.public.blockedReason || 'unsupported_provider_layout')
    plan.blockedReasons = [...new Set(plan.blockedReasons)]
    this.plans.set(plan.id, { public: plan, scan, request: req })
    return plan
  }

  /** Build an explicit deletion plan for user-owned Skill/MCP entries only. */
  async planRemoval(target: 'codex' | 'traex', selections: string[]): Promise<CapabilitySyncPlan> {
    if (!this.allowedProviders.has(target)) throw new Error('capability_provider_unavailable')
    const other = target === 'codex' ? 'traex' : 'codex'
    const source = this.allowedProviders.has(other) ? other : target
    const sourceInv = await discoverProvider(source, this.home)
    const targetInv = await discoverProvider(target, this.home)
    const allowed = targetInv.items.filter((item) =>
      item.owner === 'user' && (item.compatible || (item.kind === 'skill' && item.linked)) && (item.kind === 'skill' || item.kind === 'mcp'))
    const publicToCanonical = new Map(allowed.map((item) => [managedInventoryId(target, item.id), item.id]))
    if (!selections.length || new Set(selections).size !== selections.length ||
        selections.some((id) => !publicToCanonical.has(id))) throw new Error('invalid_selection')
    const canonicalSelections = selections.map((id) => publicToCanonical.get(id)!)
    const result: CapabilityScanResult = {
      id: randomUUID(), source, target, sourceRevision: sourceInv.revision, targetRevision: targetInv.revision,
      scannedAt: Date.now(), sourceAvailable: existsSync(providerPaths(source, this.home).root),
      targetAvailable: existsSync(providerPaths(target, this.home).root),
      executionSupported: targetInv.layoutKnown && helperAvailable() && !this.recoveryBlocked,
      blockedReason: this.recoveryBlocked ? 'recovery_required' : !helperAvailable() ? 'atomic_fs_unavailable'
        : targetInv.layoutKnown ? undefined : 'unsupported_provider_layout',
      items: allowed.map((item) => ({ id: item.id, kind: item.kind, name: item.name, status: 'target-only',
        compatible: true, selectable: true, cloneSafe: true, defaultSelected: false }))
    }
    const scan: PrivateScan = { public: result, sourceInv, targetInv, agents: {} }
    this.scans.set(result.id, scan)
    const request: CapabilityPlanRequest = { scanId: result.id, mode: 'remove-selected', cloneCategories: [], selections: canonicalSelections, resolutions: {} }
    const plan = buildPlan({ id: randomUUID(), scanId: result.id, source, target, sourceRevision: sourceInv.revision,
      targetRevision: targetInv.revision, mode: 'remove-selected', cloneCategories: [], items: result.items, selections: canonicalSelections, resolutions: {} })
    if (!result.executionSupported) plan.blockedReasons.push(result.blockedReason || 'unsupported_provider_layout')
    plan.blockedReasons = [...new Set(plan.blockedReasons)]
    this.plans.set(plan.id, { public: plan, scan, request })
    return plan
  }

  async getMarkdownPreview(scanId: string, itemId: 'global-instructions:agents', strategy: AgentsStrategy): Promise<CapabilityMarkdownPreview> {
    const scan = this.scans.get(scanId)
    if (!scan) throw new Error('scan_not_found')
    if (itemId !== 'global-instructions:agents') throw new Error('preview_not_supported')
    const merged = this.agentsContent(strategy, scan.agents, true)
    if (!merged) throw new Error('agents_source_empty')
    return {
      itemId,
      lineCount: merged.length ? merged.split(/\r?\n/).length : 0,
      headingCount: merged.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line)).length,
      byteCount: Buffer.byteLength(merged)
    }
  }

  /** Reserves both providers synchronously and returns before any filesystem await. */
  execute(req: CapabilityExecuteRequest): CapabilitySyncJob {
    if (!helperAvailable()) throw new Error('atomic_fs_unavailable')
    if (this.recoveryBlocked) throw new Error('recovery_required')
    const plan = this.plans.get(req.planId)
    if (!plan) throw new Error('plan_not_found')
    if (plan.public.blockedReasons.length) throw new Error(`plan_blocked:${plan.public.blockedReasons.join(',')}`)
    if (plan.public.requiresConfirmation && (!req.confirmation?.acknowledged || req.confirmation.targetName?.toLowerCase() !== plan.public.target ||
        (plan.public.mode === 'remove-selected' && req.confirmation.deleteCount !== plan.public.destructiveCount))) throw new Error('confirmation_required')
    if (req.expectedSourceRevision !== plan.public.sourceRevision || req.expectedTargetRevision !== plan.public.targetRevision) throw new Error('stale_plan')
    const reservation = [plan.public.source, plan.public.target]
    if (reservation.some((provider) => this.locks.has(provider))) throw new Error('sync_in_progress')
    const operationLock = this.acquireOperationLock()
    try { this.faultInjector?.('after-operation-lock-acquired') }
    catch (error) { this.releaseOperationLock(operationLock); throw error }
    for (const provider of reservation) this.locks.add(provider)
    const job: CapabilitySyncJob = {
      id: randomUUID(), planId: plan.public.id, operation: plan.public.mode === 'remove-selected' ? 'remove-selected' : 'sync',
      state: 'backing_up', stage: 'validating_revisions',
      progress: { completed: 0, total: 0 }, updatedAt: Date.now()
    }
    this.jobs.set(job.id, job)
    this.publish(job)
    queueMicrotask(() => void this.startExecution(job, plan, reservation, operationLock))
    return { ...job }
  }

  getJob(id: string): CapabilitySyncJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job } : undefined
  }

  getJobSnapshot(): CapabilityJobSnapshot {
    const jobs = [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const active = jobs.find((job) => !TERMINAL.has(job.state))
    const candidate = !this.recoveryBlocked && this.rollbackCandidateId
      ? jobs.find((job) => job.transactionId === this.rollbackCandidateId && job.state === 'completed')
      : undefined
    const rollbackCandidate: CapabilityRollbackCandidate | undefined = candidate?.transactionId
      ? { ...candidate, state: 'completed', transactionId: candidate.transactionId }
      : undefined
    return {
      active: active ? { ...active } : undefined,
      latest: jobs[0] ? { ...jobs[0] } : undefined,
      rollbackCandidate
    }
  }

  cancel(id: string): CapabilitySyncJob | undefined {
    const job = this.jobs.get(id)
    if (!job || TERMINAL.has(job.state)) return job ? { ...job } : undefined
    this.cancelled.add(id)
    job.stage = 'cancellation_requested'
    job.updatedAt = nextJobTimestamp(job.updatedAt)
    this.publish(job)
    return { ...job }
  }

  async rollback(transactionId: string): Promise<CapabilitySyncJob> {
    if (!helperAvailable()) throw new Error('atomic_fs_unavailable')
    if (!isCanonicalUuid(transactionId)) throw new Error('invalid_transaction_id')
    // A terminal job is published immediately before startExecution's finally
    // releases its provider reservation. Let that already-finished transaction
    // drain instead of exposing a spurious sync_in_progress race to the UI.
    if (this.locks.size) {
      if ([...this.jobs.values()].some((job) => !TERMINAL.has(job.state))) throw new Error('sync_in_progress')
      await new Promise<void>((resolve) => this.lockIdleWaiters.add(resolve))
    }
    const operationLock = this.acquireOperationLock()
    this.locks.add('codex'); this.locks.add('traex')
    try {
      let journal: Journal
      try { journal = await this.readJournal(this.journalPath(transactionId), transactionId) }
      catch (error) { if (error instanceof OperationRootChanged) throw error; throw new Error('invalid_journal') }
      // Validate the requested artifact first so a corrupt transaction remains
      // diagnosable even when a different transaction has blocked recovery.
      if (this.recoveryBlocked) throw new Error('recovery_required')
      if (journal.state !== 'completed') throw new Error('transaction_not_rollbackable')
      if (this.rollbackCandidateId !== transactionId) throw new Error('transaction_not_rollbackable')
      try {
        this.validateOperationRoots(operationLock)
        await this.validateRestoreSet(journal)
        await this.validateCommittedPostState(journal)
        await this.validateCompletedArtifacts(journal)
      } catch (error) {
        if (error instanceof CommittedTargetChanged) throw error
        throw new Error('invalid_journal')
      }
      const job: CapabilitySyncJob = {
        id: randomUUID(), planId: journal.planId, operation: journal.job.operation, transactionId, state: 'rolling_back',
        stage: 'rolling_back', progress: { completed: 0, total: journal.entries.length }, updatedAt: Date.now()
      }
      journal.state = 'rolling_back'
      journal.rollbackIndex = 0
      journal.rollbackKind = 'manual'
      journal.job = job
      // The rollback intent is journaled before it is exposed as an active job.
      try {
        await this.updateJob(job, journal)
        await this.restore(journal)
        journal.state = 'rolled_back'
        job.state = 'rolled_back'
        job.stage = 'rollback_completed'
        job.result = rollbackResult(journal.commitIndex)
        await this.updateJob(job, journal)
        await this.refreshRollbackCandidate()
        await this.runTerminalMaintenance()
        return { ...job }
      } catch {
        // Once rollback intent may have reached disk, no subsequent sync is
        // safe in this process until recovery proves the target is coherent.
        this.setRecoveryBlocked()
        journal.state = 'rolling_back'
        journal.rollbackKind = 'manual'
        job.state = 'rollback_failed'
        job.errorCode = 'rollback_failed'
        job.stage = 'recovery_required'
        job.progress = journal.job.progress || job.progress
        try {
          await this.updateJob(job, journal)
        } catch {
          // Preserve an observable closed failure even when the durability
          // failure that triggered this path also prevents status persistence.
          job.updatedAt = nextJobTimestamp(job.updatedAt)
          this.jobs.set(job.id, { ...job })
          this.publish(job)
        }
        return { ...job }
      }
    } finally {
      this.locks.delete('codex'); this.locks.delete('traex')
      this.releaseLockWaiters()
      this.releaseOperationLock(operationLock)
    }
  }

  private async startExecution(job: CapabilitySyncJob, plan: PrivatePlan, reservation: string[], operationLock: OperationLock): Promise<void> {
    try {
      this.validateOperationRoots(operationLock)
      await this.updateJob(job)
      this.validateOperationRoots(operationLock)
      const [source, target] = await Promise.all([discoverProvider(plan.public.source, this.home), discoverProvider(plan.public.target, this.home)])
      this.validateOperationRoots(operationLock)
      if (source.revision !== plan.public.sourceRevision || target.revision !== plan.public.targetRevision) {
        job.state = 'failed_no_change'; job.errorCode = 'stale_plan'; job.stage = 'revision_changed'
        await this.updateJob(job)
        return
      }
      if (this.cancelled.has(job.id)) {
        job.state = 'cancelled'; job.errorCode = 'cancelled'; job.stage = 'cancelled_before_write'
        await this.updateJob(job)
        return
      }
      await this.runTransaction(job, plan)
    } catch (error) {
      if (!(error instanceof CapabilitySyncSimulatedCrash) && !this.recoveryBlocked && !TERMINAL.has(job.state)) {
        job.state = 'failed_no_change'; job.errorCode = 'internal_error'; job.stage = 'unexpected_failure'
        try { await this.updateJob(job) } catch { this.jobs.set(job.id, { ...job }); this.publish(job) }
      }
    } finally {
      for (const provider of reservation) this.locks.delete(provider)
      this.releaseLockWaiters()
      this.releaseOperationLock(operationLock)
    }
  }

  private async runTransaction(job: CapabilitySyncJob, plan: PrivatePlan): Promise<void> {
    this.validateOperationRoots()
    this.faultInjector?.('before-transaction-root-setup')
    this.validateOperationRoots()
    const transactionId = randomUUID()
    const transactions = join(this.dataRoot, 'transactions')
    const txDir = this.transactionDir(transactionId)
    const backupDir = join(txDir, 'backup')
    let pendingName = ''
    let pendingDir = ''
    let pendingIdentity: OwnedPathIdentity | undefined
    let entries!: BackupEntry[]
    let journal!: Journal
    let setupError: CapabilityJobErrorCode = 'backup_failed'
    let published = false
    try {
      const targets = this.targetsFor(plan)
      const linkedSkills = new Set(plan.public.operations.filter((operation) => operation.action === 'delete' &&
        plan.scan.targetInv.items.find((item) => item.id === operation.itemId)?.linked).map((operation) =>
        join(providerPaths(plan.public.target, this.home).skills, operation.name)))
      entries = await Promise.all(targets.map((target, index) => this.describeBackup(target, String(index), linkedSkills.has(target))))
      setupError = 'internal_error'
      this.validateOperationRoots()
      const transactionOrder = await this.nextTransactionOrder(transactions)
      const preparationNonce = randomBytes(16).toString('hex')
      journal = {
        version: 4, sealVersion: 1, seal: '', id: transactionId, provider: plan.public.target,
        sharedAgents: plan.public.operations.some((operation) => operation.action === 'share'),
        planId: plan.public.id, state: 'backing_up',
        commitIndex: 0, rollbackIndex: 0, createdAt: Date.now(), updatedAt: Date.now(), transactionOrder,
        preparationNonce, transactionLocation: 'seed', entries,
        job: { ...job, transactionId }
      }
      job.transactionId = transactionId
      this.validateOperationRoots()
      await syncDirectory(this.dataRoot)
      pendingName = `.ua-transaction-seed-${preparationNonce}-${transactionId}`
      pendingDir = join(transactions, pendingName)
      this.validateOperationRoots()
      await mkdir(pendingDir, { mode: 0o700 })
      this.faultInjector?.('after-transaction-seed-created')
      await chmod(pendingDir, 0o700)
      pendingIdentity = captureOwnedPathIdentity(pendingDir)
      const preparedIdentity = pendingIdentity
      const transactionRootIdentity = sealedTransactionRootIdentity(preparedIdentity)
      journal.transactionRootIdentity = transactionRootIdentity
      await this.persistJournalAt(join(pendingDir, 'journal.json'), journal)
      pendingName = await this.renameWithJournalIntent(journal, 'preparation_to_transaction')
      pendingDir = join(transactions, pendingName)
      validateOwnedPathIdentity(pendingDir, preparedIdentity)
      this.validateOperationRoots()
      this.faultInjector?.('after-transaction-preparation-created')
      await ensurePrivateDirectory(join(pendingDir, 'backup'), this.home)
      await syncDirectory(pendingDir)
      this.faultInjector?.('after-transaction-journal-durable')
      pendingName = await this.renameWithJournalIntent(journal, 'preparation_to_transaction')
      pendingDir = join(transactions, pendingName)
      published = true
      this.validateTransactionRootIdentity(txDir, ownedIdentity(transactionRootIdentity))
      this.validateOperationRoots()
      this.faultInjector?.('after-transaction-publish')
    } catch (error) {
      if (this.recoveryBlocked || journal?.renameIntent || anchoredRenameNeedsRecovery(error)) {
        this.setRecoveryBlocked()
        throw error
      }
      if (!published && error instanceof CapabilitySyncSimulatedCrash) throw error
      if (published) {
        // The complete journal is already visible under its canonical id. Let
        // normal transaction handling or startup recovery close it.
        if (error instanceof CapabilitySyncSimulatedCrash) throw error
        try {
          journal = await this.readJournal(this.journalPath(transactionId), transactionId)
          await this.finalizeNoChange(journal, 'internal_error')
          job.state = journal.job.state
          job.errorCode = journal.job.errorCode
          job.stage = journal.job.stage
          job.progress = journal.job.progress
          job.updatedAt = journal.job.updatedAt
          await this.persistLatestJob(job)
          this.jobs.set(job.id, { ...job })
          this.emit('progress', { ...job })
          await this.runTerminalMaintenance()
          return
        } catch (recoveryError) {
          this.setRecoveryBlocked()
          if (recoveryError instanceof OperationRootChanged) throw recoveryError
          throw error
        }
      }
      try { if (pendingIdentity && !this.recoveryBlocked) this.removeOwnedPathHandled(pendingDir, pendingIdentity) }
      catch (cleanupError) { this.setRecoveryBlocked(); if (cleanupError instanceof OperationRootChanged) throw cleanupError }
      delete job.transactionId
      job.state = 'failed_no_change'; job.errorCode = setupError; job.stage = setupError === 'backup_failed' ? 'no_target_change' : 'transaction_setup_failed'
      await this.updateJob(job)
      return
    }
    let commitStarted = false
    let phase: TransactionPhase = 'backup'
    try {
      job.stage = 'backing_up'; job.progress = { completed: 0, total: entries.length }
      await this.updateJob(job, journal)
      for (let index = 0; index < entries.length; index++) {
        await this.backupOne(entries[index], backupDir, journal)
        // Missing targets and symlinks need no copied payload, but are still
        // durably described and therefore complete backup records.
        entries[index].backedUp = true
        job.progress = { completed: index + 1, total: entries.length }
        await this.updateJob(job, journal)
      }
      if (this.cancelled.has(job.id)) throw new CancelledBeforeCommit()

      phase = 'stage'
      this.validateOperationRoots()
      journal.state = 'staging'; job.state = 'staging'; job.stage = 'staging'; job.progress = { completed: 0, total: entries.length }
      await this.updateJob(job, journal)
      const staged = await this.prepareStages(plan, journal)
      phase = 'stage_validation'
      const expected = await this.validateStages(plan, staged)
      // Seal every staged object and its destination parent chain before the
      // externally visible post-staging boundary.  Recovery may only remove a
      // stage whose exact identity was durably recorded; sampling it later
      // would let a replacement object become transaction-owned.
      await this.prepareCommitGuards(journal, staged)
      await this.persistJournal(journal)
      phase = 'stage'
      this.faultInjector?.('after-staging')
      if (this.cancelled.has(job.id)) throw new CancelledBeforeCommit()

      // Re-read both providers after staging and immediately before entering
      // commit. This catches source mutation and target TOCTOU races.
      const [freshSource, freshTarget] = await Promise.all([discoverProvider(plan.public.source, this.home), discoverProvider(plan.public.target, this.home)])
      if (freshSource.revision !== plan.public.sourceRevision || freshTarget.revision !== plan.public.targetRevision) {
        job.stage = freshSource.revision !== plan.public.sourceRevision ? 'source_revision_changed' : 'target_revision_changed'
        throw new StaleBeforeCommit()
      }
      phase = 'stage_validation'
      await this.validateStages(plan, staged, expected)
      for (const entry of staged) if (!entry.remove) await syncTree(entry.stage)
      await this.validatePreparedCommitGuards(journal, staged)

      journal.state = 'ready'; await this.updateJob(job, journal)
      phase = 'commit'
      journal.state = 'committing'; job.state = 'committing'; job.stage = 'committing'; job.progress = { completed: 0, total: entries.length }
      commitStarted = true
      await this.updateJob(job, journal)
      for (let index = 0; index < staged.length; index++) {
        const entry = staged[index]
        this.validateOperationRoots()
        this.faultInjector?.(`before-commit-${index}`)
        this.validateOperationRoots()
        await this.validateCommitTarget(journal.entries[index], entry.target)
        const targetPresent = pathEntryExists(entry.target)
        if (targetPresent !== journal.entries[index].expectedPreState.exists) throw new TargetChangedBeforeCommit()
        if (targetPresent) {
          try {
            await this.renameWithJournalIntent(journal, 'target_to_slot', index)
          }
          catch (error) { throw atomicCommitError(error) }
          // From this point the entry is transaction-owned even before the
          // normal progress journal write. Any caught error persists this
          // in-flight index so recovery never cleans an unaccounted slot.
          journal.commitIndex = index + 1
          this.faultInjector?.(`after-commit-slot-${index}`)
        }
        try { await this.validateCommitSlot(journal.entries[index], entry.slot) }
        catch (error) { this.setRecoveryBlocked(); throw error }
        this.faultInjector?.(`before-install-${index}`)
        if (!entry.remove) {
          try {
            await this.renameWithJournalIntent(journal, 'stage_to_target', index)
          } catch (error) { throw atomicCommitError(error) }
          journal.commitIndex = index + 1
          this.faultInjector?.(`after-install-${index}`)
        }
        await this.validateParentChain(journal.entries[index], entry.target)
        await this.validateExpectedState(entry.target, journal.entries[index].expectedPostState!, true)
        journal.commitIndex = index + 1
        job.progress = { completed: index + 1, total: staged.length }
        await this.updateJob(job, journal)
        this.faultInjector?.(`after-commit-${index}`)
        if (this.cancelled.has(job.id)) throw new Error('cancelled')
      }

      phase = 'verification'
      journal.state = 'verifying'; job.state = 'verifying'; job.stage = 'static_validation'; job.progress = { completed: 0, total: plan.public.operations.length }
      await this.updateJob(job, journal)
      if (this.cancelled.has(job.id)) throw new Error('cancelled')
      const verified = await discoverProvider(plan.public.target, this.home)
      await this.verifyCommitted(plan, verified, expected)
      if (expected.agentsFingerprint) await verifyAgentsShared(this.home, expected.agentsFingerprint)
      if (this.cancelled.has(job.id)) throw new Error('cancelled')

      journal.state = 'completed'
      journal.completedAt = Math.max(Date.now(), journal.updatedAt, journal.createdAt)
      await this.validateCompletedArtifacts(journal)
      job.state = 'completed'; job.stage = 'native_validation_pending'; job.result = counts(plan.public)
      job.progress = { completed: plan.public.operations.length, total: plan.public.operations.length }
      await this.updateJob(job, journal)
      this.rollbackCandidateId = journal.id
      try { await this.cleanupArtifacts(journal) } catch { /* terminal commit is durable; recovery can retry cleanup */ }
      await this.runTerminalMaintenance(false)
    } catch (error) {
      if (error instanceof CapabilitySyncSimulatedCrash) throw error
      if (this.recoveryBlocked || journal.renameIntent || anchoredRenameNeedsRecovery(error)) {
        this.setRecoveryBlocked()
        throw error
      }
      if (journal.commitIndex > 0 && journal.state === 'committing') {
        // Persist the in-memory in-flight marker before any rollback work so a
        // second crash cannot make a durable slot/post object look unowned.
        try { await this.persistJournal(journal) } catch { this.setRecoveryBlocked() }
      }
      const firstCommitSlot = journal.entries.length ? this.stagedEntries(journal)[0].slot : undefined
      if (error instanceof TargetChangedBeforeCommit && journal.commitIndex === 0 &&
          (!firstCommitSlot || !pathEntryExists(firstCommitSlot))) {
        journal.state = 'rolled_back'
        job.state = 'failed_no_change'; job.errorCode = 'stale_plan'; job.stage = 'target_revision_changed'
        await this.updateJob(job, journal)
        try { await this.cleanupArtifacts(journal) } catch { this.setRecoveryBlocked() }
        await this.runTerminalMaintenance()
        return
      }
      if (!commitStarted) {
        job.state = error instanceof CancelledBeforeCommit ? 'cancelled' : 'failed_no_change'
        job.errorCode = error instanceof CancelledBeforeCommit ? 'cancelled' : error instanceof StaleBeforeCommit ? 'stale_plan' : classifyPhaseError(error, phase)
        if (!(error instanceof StaleBeforeCommit)) job.stage = 'no_target_change'
        journal.job = { ...job }
        await this.finalizeNoChange(journal, job.errorCode)
        job.updatedAt = journal.job.updatedAt
        // Do not expose a terminal in-memory/latest-job state until every
        // identity-sealed precommit artifact has been removed.  Otherwise a
        // caller can observe completion and immediately race the still-live
        // stage cleanup.
        try { await this.cleanupArtifacts(journal) } catch { this.setRecoveryBlocked() }
        await this.persistLatestJob(job)
        this.jobs.set(job.id, { ...job })
        this.emit('progress', { ...job })
        await this.runTerminalMaintenance()
        return
      }
      journal.state = 'rolling_back'; journal.rollbackKind = 'automatic'; job.state = 'rolling_back'; job.errorCode = (error as Error).message === 'cancelled' ? 'cancelled' : error instanceof TargetChangedBeforeCommit ? 'stale_plan' : classifyPhaseError(error, phase)
      job.stage = 'rolling_back'; job.progress = { completed: 0, total: journal.commitIndex }
      await this.updateJob(job, journal)
      try {
        await this.restore(journal)
        job.state = (error as Error).message === 'cancelled' ? 'cancelled' : 'rolled_back'
        job.result = rollbackResult(journal.commitIndex)
        job.stage = 'rollback_completed'
        journal.state = 'rolled_back'
        await this.updateJob(job, journal)
        await this.runTerminalMaintenance()
      } catch (rollbackError) {
        if (rollbackError instanceof CapabilitySyncSimulatedCrash) throw rollbackError
        job.state = 'rollback_failed'; job.errorCode = 'rollback_failed'; job.stage = 'recovery_required'
        this.setRecoveryBlocked()
        try { await this.updateJob(job, journal) }
        catch { job.updatedAt = nextJobTimestamp(job.updatedAt); this.jobs.set(job.id, { ...job }); this.publish(job) }
      }
    } finally {
      this.cancelled.delete(job.id)
    }
  }

  private targetsFor(plan: PrivatePlan): string[] {
    const targetPaths = providerPaths(plan.public.target, this.home)
    const output = new Set<string>()
    for (const operation of plan.public.operations) {
      if (operation.action === 'noop' || operation.action === 'skip') continue
      if (operation.kind === 'skill') { assertSafeDestination(join(targetPaths.skills, operation.name), targetPaths.skills); output.add(join(targetPaths.skills, operation.name)) }
      else if (operation.kind === 'mcp' || operation.kind === 'global-preference') output.add(targetPaths.config)
      else if (operation.kind === 'memory') {
        output.add(memoryTarget(targetPaths.memories, operation.name))
      } else {
        output.add(providerPaths('codex', this.home).agents)
        output.add(providerPaths('traex', this.home).agents)
        output.add(join(this.home, '.agents/AGENTS.md'))
      }
    }
    return [...output].sort()
  }

  private async describeBackup(target: string, backupName: string, mustBeSymlink = false): Promise<BackupEntry> {
    await assertSafePathChain(target, this.home, true)
    const expectedPreState = await sealedPathState(target)
    if (!expectedPreState.exists) return { targetRel: relative(this.home, target), backupName, existed: false, backedUp: false, expectedPreState }
    const info = await lstat(target)
    const type: EntryType = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : (() => { throw new Error('unsafe_target_type') })()
    if (mustBeSymlink && type !== 'symlink') throw new Error('target_changed')
    const link = type === 'symlink' ? await readlink(target) : undefined
    if (link) this.validateSymlinkTarget(target, link)
    return { targetRel: relative(this.home, target), backupName, existed: true, backedUp: false, type, mode: info.mode & 0o777, link, expectedPreState }
  }

  private async backupOne(entry: BackupEntry, backupDir: string, journal: Journal): Promise<void> {
    if (!entry.existed || entry.type === 'symlink') return
    const target = this.targetFromEntry(entry, journal)
    const backup = join(backupDir, entry.backupName)
    await cp(target, backup, { recursive: true, dereference: false })
    await syncTree(backup)
    await syncDirectory(backupDir)
    entry.digest = await digestPath(backup)
    if (!entry.expectedPreState.digest || entry.digest !== entry.expectedPreState.digest) throw new Error('target_changed_during_backup')
    await this.validateExpectedState(target, entry.expectedPreState, true)
  }

  private stagedEntries(journal: Journal): StagedEntry[] {
    return journal.entries.map((entry, index) => {
      const target = this.targetFromEntry(entry, journal)
      return {
        target, index, remove: false, type: entry.type || 'file',
        stage: artifactPath(target, 'stage', journal.id, index),
        slot: artifactPath(target, 'rollback', journal.id, index),
        post: artifactPath(target, 'post', journal.id, index)
      }
    })
  }

  private async prepareStages(plan: PrivatePlan, journal: Journal): Promise<StagedEntry[]> {
    this.validateOperationRoots()
    const stages = this.stagedEntries(journal)
    const byTarget = new Map(stages.map((entry) => [entry.target, entry]))
    for (const entry of stages) {
      await assertSafePathChain(entry.target, this.home, true)
      await mkdir(dirname(entry.target), { recursive: true, mode: 0o700 })
      if (pathEntryExists(entry.stage) || pathEntryExists(entry.slot) || pathEntryExists(entry.post)) throw new Error('transaction_artifact_collision')
    }

    const targetPaths = providerPaths(plan.public.target, this.home)
    for (const operation of plan.public.operations) {
      this.validateOperationRoots()
      if (operation.action === 'noop' || operation.action === 'skip') continue
      if (operation.kind === 'global-instructions') { await this.stageAgents(plan.public.agentsStrategy!, plan.scan.agents, byTarget, journal); continue }
      const source = plan.scan.sourceInv.items.find((item) => item.id === operation.itemId)
      const target = operation.kind === 'skill' ? join(targetPaths.skills, operation.name)
        : operation.kind === 'memory' ? memoryTarget(targetPaths.memories, operation.name) : targetPaths.config
      const entry = byTarget.get(target)
      if (!entry) throw new Error('stage_failed')
      if (operation.action === 'delete') {
        if (operation.kind === 'mcp' || operation.kind === 'global-preference') {
          await this.ensureConfigStage(entry, journal)
          await this.mutateConfig(entry.stage, operation.kind, operation.name, undefined)
        } else entry.remove = true
        continue
      }
      if (!source) throw new Error('stage_failed')
      if (operation.kind === 'skill') {
        await this.createOwnedStage(entry, journal, 'directory')
        await copySkillTree(source.privateRef, entry.stage)
        entry.type = 'directory'
      } else if (operation.kind === 'memory') {
        const sourceText = await readFile(source.privateRef, 'utf8')
        const targetText = await readAny(entry.target)
        const body = plan.request.resolutions[operation.itemId] === 'merge' ? mergeMarkdown(sourceText, targetText) : sourceText
        await this.createOwnedStage(entry, journal, 'file')
        await writeFile(entry.stage, body, { mode: 0o600 }); entry.type = 'file'
      } else if (operation.kind === 'mcp') {
        await this.ensureConfigStage(entry, journal)
        const sourceValue = await this.mcpValue(source)
        const config = parseToml(await readFile(entry.stage, 'utf8'))
        const targetValue = mcpRecord(config)[source.privateKey || source.name]
        const merged = mergeMcpCredentialSafe(sourceValue, isRecord(targetValue) ? targetValue : undefined)
        if (merged.credentialRequired || !merged.value) throw new Error('credential_required')
        await this.mutateConfig(entry.stage, 'mcp', source.privateKey || source.name, merged.value)
      } else {
        await this.ensureConfigStage(entry, journal)
        const sourceConfig = parseToml(await readFile(source.privateRef, 'utf8'))
        await this.mutateConfig(entry.stage, 'global-preference', source.privateKey || source.name, rootPreference(sourceConfig, source.privateKey || source.name))
      }
    }
    for (const entry of stages) {
      this.validateOperationRoots()
      if (entry.remove) continue
      if (entry.type === 'file') await chmod(entry.stage, 0o600)
      await syncTree(entry.stage)
      await syncDirectory(dirname(entry.stage))
    }
    return stages
  }

  private async ensureConfigStage(entry: StagedEntry, journal: Journal): Promise<void> {
    if (journal.entries[entry.index].stageIdentity) return
    const content = await readFile(entry.target)
    await this.createOwnedStage(entry, journal, 'file')
    await writeFile(entry.stage, content, { mode: 0o600 })
  }

  private async createOwnedStage(entry: StagedEntry, journal: Journal, type: EntryType, link?: string): Promise<void> {
    const record = journal.entries[entry.index]
    if (record.stageIdentity || pathEntryExists(entry.stage)) throw new Error('transaction_artifact_collision')
    if (type === 'directory') await mkdir(entry.stage, { mode: 0o700 })
    else if (type === 'symlink') await symlink(link!, entry.stage)
    else {
      const handle = await open(entry.stage, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      await handle.close()
    }
    entry.type = type
    record.stageIdentity = pathIdentity(entry.stage)
    await syncDirectory(dirname(entry.stage))
    await this.persistJournal(journal)
    this.faultInjector?.(`after-stage-owned-${entry.index}`)
  }

  private async mutateConfig(stage: string, kind: 'mcp' | 'global-preference', name: string, value: unknown): Promise<void> {
    const config = parseToml(await readFile(stage, 'utf8'))
    if (kind === 'mcp') setMcpServer(config, name, value as TomlRecord | undefined)
    else setRootPreference(config, name, value)
    const text = stringifyToml(config)
    await writeFile(stage, text, { mode: 0o600 })
    // Validate the exact persisted bytes, not only the in-memory object.
    parseToml(await readFile(stage, 'utf8'))
  }

  private async stageAgents(strategy: AgentsStrategy, inputs: AgentsInputs, stages: Map<string, StagedEntry>, journal: Journal): Promise<void> {
    const codex = providerPaths('codex', this.home).agents
    const traex = providerPaths('traex', this.home).agents
    const shared = join(this.home, '.agents/AGENTS.md')
    const content = this.agentsContent(strategy, inputs, true)
    if (!content) throw new Error('agents_source_empty')
    const sharedEntry = stages.get(shared)
    if (!sharedEntry) throw new Error('stage_failed')
    await this.createOwnedStage(sharedEntry, journal, 'file')
    await writeFile(sharedEntry.stage, content, { mode: 0o600 })
    sharedEntry.type = 'file'
    for (const target of [codex, traex]) {
      const entry = stages.get(target)
      if (!entry) throw new Error('stage_failed')
      await this.createOwnedStage(entry, journal, 'symlink', shared)
    }
  }

  private async validateStages(plan: PrivatePlan, stages: StagedEntry[], expected?: ExpectedState): Promise<ExpectedState> {
    const targetPaths = providerPaths(plan.public.target, this.home)
    const byTarget = new Map(stages.map((entry) => [entry.target, entry]))
    for (const entry of stages) {
      if (entry.remove) { if (pathEntryExists(entry.stage)) throw new Error('stage_validation_failed'); continue }
      await assertSafePathChain(entry.stage, this.home, entry.type === 'symlink')
      const info = await lstat(entry.stage)
      if (entry.type === 'directory') {
        if (!info.isDirectory()) throw new Error('stage_validation_failed')
        await validateSkillTree(entry.stage, dirname(entry.stage), this.home, true)
      } else if (entry.type === 'symlink') {
        if (!info.isSymbolicLink()) throw new Error('stage_validation_failed')
        this.validateSymlinkTarget(entry.target, await readlink(entry.stage))
      } else {
        if (!info.isFile() || info.size > 5 * 1024 * 1024 || (info.mode & 0o022) !== 0) throw new Error('stage_validation_failed')
      }
    }
    const configEntry = byTarget.get(targetPaths.config)
    const config = configEntry && !configEntry.remove ? parseToml(await readFile(configEntry.stage, 'utf8')) : undefined
    if (config) stringifyToml(config)
    const current: ExpectedState = { fingerprints: new Map() }
    for (const operation of plan.public.operations) {
      if (operation.action === 'share') {
        const shared = byTarget.get(join(this.home, '.agents/AGENTS.md'))
        const intended = this.agentsContent(plan.public.agentsStrategy!, plan.scan.agents, true)
        if (!shared || shared.remove || !intended) throw new Error('stage_validation_failed')
        const fingerprint = semanticHash(await readFile(shared.stage))
        if (fingerprint !== semanticHash(intended)) throw new Error('stage_validation_failed')
        current.agentsFingerprint = fingerprint
        continue
      }
      if (operation.action !== 'write' && operation.action !== 'delete') continue
      const source = plan.scan.sourceInv.items.find((item) => item.id === operation.itemId)
      if (operation.kind === 'skill' && operation.action === 'write') {
        const entry = byTarget.get(join(targetPaths.skills, operation.name))!
        const fingerprint = await validateSkillTree(entry.stage, dirname(entry.stage), this.home)
        if (!source || fingerprint !== source.fingerprint) throw new Error('stage_validation_failed')
        current.fingerprints.set(operation.itemId, fingerprint)
      } else if (operation.kind === 'memory' && operation.action === 'write') {
        const entry = byTarget.get(memoryTarget(targetPaths.memories, operation.name))!
        const fingerprint = semanticHash(await readFile(entry.stage))
        if (!source || (plan.request.resolutions[operation.itemId] !== 'merge' && fingerprint !== source.fingerprint)) throw new Error('stage_validation_failed')
        current.fingerprints.set(operation.itemId, fingerprint)
      } else if (operation.kind === 'mcp') {
        if (!config) throw new Error('stage_validation_failed')
        const server = parseMcpBlocks(stringifyToml(config)).find((item) => item.name === operation.name)
        if (operation.action === 'delete' ? !!server : !server || !source) throw new Error('stage_validation_failed')
        if (server) current.fingerprints.set(operation.itemId, semanticHash(server.body))
      } else if (operation.kind === 'global-preference') {
        if (!config) throw new Error('stage_validation_failed')
        const actual = rootPreference(config, operation.name)
        if (operation.action === 'delete' ? actual !== undefined : !source || actual === undefined) throw new Error('stage_validation_failed')
        if (actual !== undefined) {
          const fingerprint = semanticHash(stableValue(actual))
          if (!source || fingerprint !== source.fingerprint) throw new Error('stage_validation_failed')
          current.fingerprints.set(operation.itemId, fingerprint)
        }
      }
    }
    if (expected && !sameExpectedState(current, expected)) throw new Error('stage_validation_failed')
    return current
  }

  private async verifyCommitted(plan: PrivatePlan, inventory: Inventory, expected: ExpectedState): Promise<void> {
    if (!inventory.layoutKnown || inventory.items.some((item) => !item.compatible && !item.linked)) throw new Error('verification_failed')
    const byId = new Map(inventory.items.map((item) => [item.id, item]))
    for (const operation of plan.public.operations) {
      if (operation.action === 'write') {
        const actual = byId.get(operation.itemId)
        const fingerprint = expected.fingerprints.get(operation.itemId)
        if (!fingerprint || !actual || !actual.compatible || actual.fingerprint !== fingerprint) throw new Error('verification_failed')
      } else if (operation.action === 'delete' && byId.has(operation.itemId)) throw new Error('verification_failed')
    }
  }

  private async prepareCommitGuards(journal: Journal, stages: StagedEntry[]): Promise<void> {
    for (const stage of stages) {
      const entry = journal.entries[stage.index]
      entry.expectedPostState = stage.remove ? { exists: false } : await sealedPathState(stage.stage)
      if (entry.stageIdentity && entry.expectedPostState.exists &&
          (entry.stageIdentity.dev !== entry.expectedPostState.dev || entry.stageIdentity.ino !== entry.expectedPostState.ino)) throw new Error('stage_identity_changed')
      entry.parentChain = await captureParentChain(stage.target, this.home)
    }
  }

  private async validatePreparedCommitGuards(journal: Journal, stages: StagedEntry[]): Promise<void> {
    for (const stage of stages) {
      const entry = journal.entries[stage.index]
      if (!entry.expectedPostState || !entry.parentChain || (entry.expectedPostState.exists && !entry.stageIdentity)) throw new Error('invalid_journal')
      await this.validateParentChain(entry, stage.target)
      await this.validateExpectedState(stage.stage, entry.expectedPostState, true)
    }
  }

  private async validateCommitTarget(entry: BackupEntry, target: string): Promise<void> {
    try {
      await this.validateParentChain(entry, target)
      await this.validateExpectedState(target, entry.expectedPreState, true)
    } catch { throw new TargetChangedBeforeCommit() }
  }

  private async validateCommitSlot(entry: BackupEntry, slot: string): Promise<void> {
    try {
      if (entry.expectedPreState.exists) await this.validateExpectedState(slot, entry.expectedPreState, true)
      else if (pathEntryExists(slot)) throw new Error('unexpected_commit_slot')
    } catch { throw new TargetChangedBeforeCommit() }
  }

  private async validateCommittedPostState(journal: Journal): Promise<void> {
    for (const entry of journal.entries) {
      if (!entry.expectedPostState || !entry.parentChain) throw new Error('invalid_journal')
      const target = this.targetFromEntry(entry, journal)
      try {
        await this.validateParentChain(entry, target)
        await this.validateExpectedState(target, entry.expectedPostState, true)
      } catch { throw new CommittedTargetChanged() }
    }
  }

  private async validateCompletedArtifacts(journal: Journal): Promise<void> {
    if (journal.commitIndex !== journal.entries.length || journal.rollbackIndex !== 0) throw new Error('invalid_journal')
    const staged = this.stagedEntries(journal)
    for (const [index, entry] of journal.entries.entries()) {
      await this.validateParentChain(entry, staged[index].target)
      await this.validateCommitSlot(entry, staged[index].slot)
    }
    await this.validateCommittedPostState(journal)
  }

  private async validateParentChain(entry: BackupEntry, target: string, ignoreDevice = false): Promise<void> {
    if (!entry.parentChain) throw new Error('missing_parent_chain')
    const expectedParent = relative(this.home, dirname(target))
    if (!entry.parentChain.length || entry.parentChain[entry.parentChain.length - 1].targetRel !== expectedParent) throw new Error('invalid_parent_chain')
    for (const expected of entry.parentChain) {
      if (!safeRelative(expected.targetRel)) throw new Error('invalid_parent_chain')
      const path = resolve(this.home, expected.targetRel)
      if (relative(this.home, path) !== expected.targetRel) throw new Error('invalid_parent_chain')
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (!ignoreDevice && String(info.dev) !== expected.dev) || String(info.ino) !== expected.ino || (info.mode & 0o777) !== expected.mode) throw new Error('parent_changed')
    }
    await assertSafePathChain(target, this.home, true)
  }

  private async renameWithJournalIntent(
    journal: Journal, leg: RenameLeg, entryIndex?: number
  ): Promise<string> {
    if (journal.renameIntent) {
      this.setRecoveryBlocked()
      throw new Error('rename_recovery_required')
    }
    const names = await this.renameNames(journal, leg, entryIndex)
    const expectedSource = renameExpectedSource(journal, leg, entryIndex)
    const intent: RenameIntent = {
      version: 1, leg, entryIndex, anchorName: renameAnchorName(),
      expectedSource: canonicalSourceIdentity(expectedSource)
    }
    journal.renameIntent = intent
    await this.persistJournal(journal)
    this.faultInjector?.(`after-rename-intent-${leg}${entryIndex == null ? '' : `-${entryIndex}`}`)

    let published = false
    try {
      atomicRenameAnchoredSync(
        names.parent, names.sourceName, intent.anchorName, names.targetName, names.parentIdentity, intent.expectedSource
      )
      published = true
    } catch (error) {
      if (error instanceof AtomicFsError && error.applied && error.disposition === 'published') {
        // The namespace mutation completed but the native directory sync did
        // not. Retry that durability boundary before acknowledging publish.
        syncDirectorySync(names.parent)
        published = true
      }
      if (published) { /* validate and durably clear the intent below */ }
      else {
      // Any failure may have retained the exact source under the anchor.  The
      // intent and residue are recovery evidence and must remain untouched.
        this.setRecoveryBlocked()
        throw error
      }
    }

    this.faultInjector?.(`after-rename-published-${leg}${entryIndex == null ? '' : `-${entryIndex}`}`)
    try {
      await this.validatePublishedRename(journal, leg, entryIndex, names)
      if (leg === 'preparation_to_transaction') {
        journal.transactionLocation = journal.transactionLocation === 'seed' ? 'preparation' : 'canonical'
      }
      const nextJournalPath = join(this.dataRoot, 'transactions', await this.journalDirectoryName(journal), 'journal.json')
      const cleared: Journal = { ...journal }
      delete cleared.renameIntent
      await this.persistJournalAt(nextJournalPath, cleared)
      Object.assign(journal, cleared)
      delete journal.renameIntent
      return names.targetName
    } catch (error) {
      this.setRecoveryBlocked()
      throw error
    }
  }

  private async renameNames(journal: Journal, leg: RenameLeg, entryIndex?: number): Promise<RenameNames> {
    if (leg === 'preparation_to_transaction') {
      if (entryIndex != null || !journal.preparationNonce || !journal.transactionRootIdentity) throw new Error('invalid_journal')
      const transactions = join(this.dataRoot, 'transactions')
      const sourceIdentity = sourceIdentityFromTransactionRoot(journal.transactionRootIdentity)
      const preparation = await this.preparationTransactionName(journal.id, journal.preparationNonce, sourceIdentity)
      const seed = `.ua-transaction-seed-${journal.preparationNonce}-${journal.id}`
      const sourceName = journal.transactionLocation === 'seed' ? seed :
        journal.transactionLocation === 'preparation' ? preparation : (() => { throw new Error('invalid_journal') })()
      const targetName = journal.transactionLocation === 'seed' ? preparation : journal.id
      return {
        parent: transactions, sourceName, targetName, parentIdentity: syncParentIdentity(transactions),
        journalDirectoryName: sourceName, nextJournalDirectoryName: targetName
      }
    }
    if (!finiteInteger(entryIndex, 0, journal.entries.length - 1)) throw new Error('invalid_journal')
    const entry = journal.entries[entryIndex]
    if (!entry.parentChain?.length) throw new Error('invalid_journal')
    const staged = this.stagedEntries(journal)[entryIndex]
    const parent = dirname(staged.target)
    const expectedParent = entry.parentChain[entry.parentChain.length - 1]
    if (resolve(this.home, expectedParent.targetRel) !== parent) throw new Error('invalid_journal')
    const byLeg: Record<Exclude<RenameLeg, 'preparation_to_transaction'>, [string, string]> = {
      target_to_slot: [basename(staged.target), basename(staged.slot)],
      stage_to_target: [basename(staged.stage), basename(staged.target)],
      target_to_post: [basename(staged.target), basename(staged.post)],
      slot_to_target: [basename(staged.slot), basename(staged.target)]
    }
    const [sourceName, targetName] = byLeg[leg]
    return { parent, sourceName, targetName, parentIdentity: expectedParent, journalDirectoryName: journal.id, nextJournalDirectoryName: journal.id }
  }

  private async validatePublishedRename(
    journal: Journal, leg: RenameLeg, entryIndex: number | undefined, names: RenameNames
  ): Promise<void> {
    if (existsSync(join(names.parent, journal.renameIntent!.anchorName))) throw new Error('rename_anchor_retained')
    if (leg === 'preparation_to_transaction') {
      this.validateTransactionRootIdentity(join(names.parent, names.targetName), ownedIdentity(journal.transactionRootIdentity!))
      return
    }
    const entry = journal.entries[entryIndex!]
    const expected = leg === 'target_to_slot' || leg === 'slot_to_target' ? entry.expectedPreState : entry.expectedPostState
    await this.validateExpectedState(join(names.parent, names.targetName), expected!, true)
  }

  private async validateExpectedState(path: string, expected: SealedPathState, requireIdentity: boolean, ignoreDevice = false): Promise<void> {
    const actual = await sealedPathState(path)
    if (!sameSealedPathState(actual, expected, requireIdentity, ignoreDevice)) throw new Error('path_state_changed')
  }

  private async rollbackOne(journal: Journal, entry: BackupEntry, committed: StagedEntry): Promise<void> {
    this.validateOperationRoots()
    const target = committed.target
    if (await this.rollbackEntryComplete(journal, entry, committed)) return
    await this.validateRollbackTarget(journal, entry, committed)

    // Move the exact committed object aside without clobbering a pre-existing
    // quarantine object. If recovery already performed this move, its sealed
    // identity is accepted below; any other collision is closed failure.
    if (entry.expectedPostState?.exists) {
      if (pathEntryExists(target)) {
        try {
          await this.renameWithJournalIntent(journal, 'target_to_post', committed.index)
        }
        catch (error) { throw atomicRollbackError(error) }
        try { await this.validateExpectedState(committed.post, entry.expectedPostState, true) }
        catch (error) { this.setRecoveryBlocked(); throw new CommittedTargetChanged() }
        this.faultInjector?.(`after-restore-quarantine-${committed.index}`)
      } else if (pathEntryExists(committed.post)) {
        await this.validateExpectedState(committed.post, entry.expectedPostState, true)
      } else {
        // A crash after target -> slot but before stage -> target leaves the
        // exact post object in stage. It was never installed and needs no
        // quarantine, but must remain sealed for unambiguous recovery.
        await this.validateExpectedState(committed.stage, entry.expectedPostState, true)
      }
    } else if (pathEntryExists(target)) {
      throw new CommittedTargetChanged()
    }

    if (entry.expectedPreState.exists) {
      await this.validateExpectedState(committed.slot, entry.expectedPreState, true)
      if (!pathEntryExists(target)) {
        try {
          await this.renameWithJournalIntent(journal, 'slot_to_target', committed.index)
        }
        catch (error) {
          // Do not overwrite a conflicting target. The post-state remains in
          // quarantine and the original rollback slot remains recoverable.
          throw atomicRollbackError(error)
        }
        this.faultInjector?.(`after-restore-install-${committed.index}`)
      }
      try { await this.validateExpectedState(target, entry.expectedPreState, true) }
      catch (error) { this.setRecoveryBlocked(); throw new CommittedTargetChanged() }
    } else if (pathEntryExists(target)) {
      throw new CommittedTargetChanged()
    }

    await this.validateParentChain(entry, target)
    await syncDirectory(dirname(target))
  }

  private async restore(journal: Journal): Promise<void> {
    this.validateOperationRoots()
    await this.captureInFlightCommit(journal)
    await this.validateRestoreSet(journal)
    await this.captureInFlightRollback(journal)
    const start = journal.commitIndex - 1 - journal.rollbackIndex
    const committed = this.stagedEntries(journal)
    // Validate the complete remaining restore set before the first mutation.
    // This prevents a later externally-edited target from being discovered
    // only after earlier targets have already been rolled back.
    for (let index = start; index >= 0; index--) {
      await this.validateRollbackTarget(journal, journal.entries[index], committed[index])
    }
    journal.state = 'rolling_back'
    await this.persistJournal(journal)
    for (let index = start; index >= 0; index--) {
      const entry = journal.entries[index]
      await this.rollbackOne(journal, entry, committed[index])
      this.faultInjector?.(`after-restore-${index}`)
      journal.rollbackIndex = journal.commitIndex - index
      journal.job.progress = { completed: journal.rollbackIndex, total: journal.commitIndex }
      await this.persistJournal(journal)
    }
    try { await this.cleanupArtifacts(journal) } catch { /* rollback is already durable */ }
  }

  private async captureInFlightRollback(journal: Journal): Promise<void> {
    while (journal.rollbackIndex < journal.commitIndex) {
      const index = journal.commitIndex - 1 - journal.rollbackIndex
      const entry = journal.entries[index]
      if (!await this.rollbackEntryComplete(journal, entry, this.stagedEntries(journal)[index])) break
      journal.rollbackIndex++
      journal.job.progress = { completed: journal.rollbackIndex, total: journal.commitIndex }
      await this.persistJournal(journal)
    }
  }

  private async rollbackEntryComplete(journal: Journal, entry: BackupEntry, committed: StagedEntry): Promise<boolean> {
    const target = committed.target
    try {
      await this.validateParentChain(entry, target)
      // Exact post identity wins over equal content. This prevents an unchanged
      // symlink or byte-identical file from being mistaken for a completed
      // rollback before it has left the target name.
      if (entry.expectedPostState?.exists) {
        try { await this.validateExpectedState(target, entry.expectedPostState, true); return false }
        catch { /* target is not the exact committed object */ }
      }
      if (!entry.expectedPreState.exists) {
        if (pathEntryExists(target)) return false
        await this.validateRollbackPostArtifact(entry, committed)
      } else {
        await this.validateExpectedState(target, entry.expectedPreState, true)
        if (pathEntryExists(committed.slot)) return false
        await this.validateRollbackPostArtifact(entry, committed)
      }
      await syncDirectory(dirname(target))
      return true
    } catch { return false }
  }

  private async validateRollbackPostArtifact(entry: BackupEntry, committed: StagedEntry): Promise<void> {
    if (!entry.expectedPostState?.exists) {
      if (pathEntryExists(committed.post)) throw new Error('unexpected_post_quarantine')
      return
    }
    try { await this.validateExpectedState(committed.post, entry.expectedPostState, true) }
    catch { await this.validateExpectedState(committed.stage, entry.expectedPostState, true) }
  }

  private async validateRollbackSlot(entry: BackupEntry, committed: StagedEntry): Promise<void> {
    if (entry.expectedPreState.exists) await this.validateExpectedState(committed.slot, entry.expectedPreState, true)
    else if (pathEntryExists(committed.slot)) throw new Error('unexpected_commit_slot')
  }

  private async validateRollbackTarget(journal: Journal, entry: BackupEntry, committed: StagedEntry): Promise<void> {
    const target = committed.target
    try { await this.validateParentChain(entry, target) }
    catch { throw new CommittedTargetChanged() }
    // A completed rollback is safe and will be captured before mutation.
    if (await this.rollbackEntryComplete(journal, entry, committed)) return
    try {
      await this.validateExpectedState(target, entry.expectedPostState!, true)
      await this.validateRollbackSlot(entry, committed)
      if (pathEntryExists(committed.post)) throw new Error('post_quarantine_collision')
      return
    } catch {
      // A process crash can occur after the old target was moved into the
      // transaction-owned rollback slot but before the staged replacement was
      // renamed into place. That exact intermediate state is safe to restore:
      // both artifacts must still match the sealed pre/post states. No other
      // post-state mismatch is allowed to overwrite current user data.
      if (pathEntryExists(target)) throw new CommittedTargetChanged()
      try {
        await this.validateRollbackSlot(entry, committed)
        await this.validateRollbackPostArtifact(entry, committed)
        return
      } catch {
        // Rollback itself may have crashed after slot -> target but before the
        // progress journal write. Accept only the original sealed pre-state at
        // target with a consumed slot and a sealed post artifact.
        try {
          if (entry.expectedPreState.exists) {
            await this.validateExpectedState(target, entry.expectedPreState, true)
            if (pathEntryExists(committed.slot)) throw new Error('rollback_slot_not_consumed')
          } else if (pathEntryExists(target)) throw new Error('unexpected_target')
          await this.validateRollbackPostArtifact(entry, committed)
        }
        catch { throw new CommittedTargetChanged() }
      }
    }
  }

  private async captureInFlightCommit(journal: Journal): Promise<void> {
    if (journal.commitIndex >= journal.entries.length) return
    const entry = journal.entries[journal.commitIndex]
    const next = this.stagedEntries(journal)[journal.commitIndex]
    if (!entry.expectedPostState || !entry.parentChain) throw new Error('invalid_journal')
    await this.validateParentChain(entry, next.target)

    if (entry.expectedPreState.exists) {
      if (!pathEntryExists(next.slot)) {
        // Nothing from this entry crossed the commit boundary. Both the old
        // target and staged replacement must still be their sealed objects.
        await this.validateExpectedState(next.target, entry.expectedPreState, true)
        if (entry.expectedPostState.exists) await this.validateExpectedState(next.stage, entry.expectedPostState, true)
        else if (pathEntryExists(next.stage)) throw new Error('unexpected_stage_artifact')
        return
      }
      await this.validateExpectedState(next.slot, entry.expectedPreState, true)
    } else if (pathEntryExists(next.slot)) {
      throw new Error('unexpected_commit_slot')
    }

    if (entry.expectedPostState.exists) {
      if (pathEntryExists(next.target)) await this.validateExpectedState(next.target, entry.expectedPostState, true)
      else if (pathEntryExists(next.stage)) await this.validateExpectedState(next.stage, entry.expectedPostState, true)
      else if (pathEntryExists(next.post)) await this.validateExpectedState(next.post, entry.expectedPostState, true)
      else throw new Error('missing_committed_post_state')
    } else {
      if (pathEntryExists(next.target) || pathEntryExists(next.stage) || pathEntryExists(next.post)) throw new Error('unexpected_committed_post_state')
    }
    journal.commitIndex++
    await this.persistJournal(journal)
  }

  private async validateBackup(entry: BackupEntry, backup: string, backupDir: string): Promise<void> {
    assertSafeDestination(backup, backupDir)
    await assertSafePathChain(backup, this.home)
    const info = await lstat(backup)
    if (entry.type === 'directory') {
      if (!info.isDirectory()) throw new Error('invalid_backup')
      await validateSkillTree(backup, backupDir, this.home)
    } else if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('invalid_backup')
    if (!entry.digest || await digestPath(backup) !== entry.digest) throw new Error('invalid_backup')
  }

  private async validateRestoreSet(journal: Journal): Promise<void> {
    const backupDir = join(this.transactionDir(journal.id), 'backup')
    for (const entry of journal.entries) {
      this.targetFromEntry(entry, journal)
      if (!entry.existed || entry.type === 'symlink') continue
      if (!entry.backedUp || !entry.digest) throw new Error('invalid_backup')
      await this.validateBackup(entry, join(backupDir, entry.backupName), backupDir)
    }
  }

  private targetFromEntry(entry: BackupEntry, journal: Pick<Journal, 'provider' | 'sharedAgents'>): string {
    if (!safeRelative(entry.targetRel)) throw new Error('invalid_journal')
    const target = resolve(this.home, entry.targetRel)
    if (relative(this.home, target) !== entry.targetRel || !this.allowedTarget(target, journal.provider, journal.sharedAgents)) throw new Error('invalid_journal')
    return target
  }

  private allowedTarget(target: string, provider: 'codex' | 'traex', sharedAgents: boolean): boolean {
    const candidate = resolve(target)
    const providerRoot = provider === 'codex' ? join(this.home, '.codex') : join(this.home, '.trae')
    const exact = new Set<string>()
    const skillRoots: string[] = []
    if (provider === 'codex') {
      exact.add(join(providerRoot, 'config.toml'))
      exact.add(join(providerRoot, 'AGENTS.md'))
      for (const name of MEMORY_NAMES) exact.add(join(providerRoot, name))
      skillRoots.push(join(providerRoot, 'skills'))
    } else {
      for (const prefix of ['', 'cli']) {
        const root = prefix ? join(providerRoot, prefix) : providerRoot
        exact.add(prefix ? join(root, 'config.toml') : join(root, 'traecli.toml'))
        exact.add(join(root, 'AGENTS.md'))
        for (const name of MEMORY_NAMES) exact.add(join(root, name))
        skillRoots.push(join(root, 'skills'))
      }
    }
    if (sharedAgents) {
      exact.add(join(this.home, '.codex/AGENTS.md'))
      exact.add(join(this.home, '.trae/AGENTS.md'))
      exact.add(join(this.home, '.trae/cli/AGENTS.md'))
      exact.add(join(this.home, '.agents/AGENTS.md'))
    }
    if ([...exact].some((path) => resolve(path) === candidate)) return true
    return skillRoots.some((root) => dirname(candidate) === resolve(root) && isSafeLeafName(basename(candidate)))
  }

  private validateSymlinkTarget(target: string, link: string): void {
    if (!link || link.length > 4096 || link.includes('\0')) throw new Error('invalid_symlink')
    const skillRoots = [join(this.home, '.codex/skills'), join(this.home, '.trae/skills'), join(this.home, '.trae/cli/skills')].map((path) => resolve(path))
    if (skillRoots.includes(dirname(resolve(target))) && isSafeLeafName(basename(target))) return
    const resolved = resolve(dirname(target), link)
    const agents = new Set([join(this.home, '.codex/AGENTS.md'), join(this.home, '.trae/AGENTS.md'), join(this.home, '.trae/cli/AGENTS.md')].map((path) => resolve(path)))
    if (!agents.has(resolve(target)) || resolved !== resolve(this.home, '.agents/AGENTS.md')) throw new Error('invalid_symlink')
  }

  private async cleanupArtifacts(journal: Journal, preserveRollback = journal.state === 'completed'): Promise<void> {
    const staged = this.stagedEntries(journal)
    for (const entry of staged) {
      const backupEntry = journal.entries[entry.index]
      if (backupEntry.parentChain) await this.validateParentChain(backupEntry, entry.target)
      if (!preserveRollback) await this.cleanupArtifact(journal, entry, 'slot')
      await this.cleanupArtifact(journal, entry, 'stage')
      await this.cleanupArtifact(journal, entry, 'post')
    }
  }

  private async cleanupArtifact(journal: Journal, staged: StagedEntry, artifact: CleanupArtifactKind): Promise<void> {
    const backupEntry = journal.entries[staged.index]
    const path = staged[artifact]
    const expected = artifact === 'slot' ? backupEntry.expectedPreState : backupEntry.expectedPostState
    const recorded = artifact === 'stage'
      ? backupEntry.stageIdentity || (expected?.exists ? identityFromState(expected, backupEntry) : undefined)
      : expected?.exists ? identityFromState(expected, backupEntry) : undefined
    if (journal.cleanup?.index === staged.index && journal.cleanup.artifact === artifact) {
      if (!pathEntryExists(path)) { delete journal.cleanup; await this.persistJournal(journal); return }
      if (!recorded) throw new Error('missing_artifact_identity')
      this.removeOwnedPathHandled(path, ownedIdentity(recorded))
      delete journal.cleanup; await this.persistJournal(journal)
      return
    }
    if (!pathEntryExists(path)) return
    if (!recorded) throw new Error(`unexpected_${artifact}_artifact`)
    if (expected?.exists) await this.validateExpectedState(path, expected, true)
    else if (artifact === 'stage') validateOwnedPathIdentity(path, ownedIdentity(recorded))
    else throw new Error(`unexpected_${artifact}_artifact`)
    journal.cleanup = { index: staged.index, artifact }
    await this.persistJournal(journal)
    this.removeOwnedPathHandled(path, ownedIdentity(recorded))
    delete journal.cleanup
    await this.persistJournal(journal)
  }

  private pruneLockArtifacts(): void {
    this.validateOperationRoots()
    const candidates: Array<{ path: string; updatedAt: number }> = []
    for (const name of readdirSync(this.dataRoot)) {
      if (!isDisposableLockArtifact(name)) continue
      const path = join(this.dataRoot, name)
      try { candidates.push({ path, updatedAt: lstatSync(path).mtimeMs }) } catch { /* concurrent cleanup */ }
    }
    candidates.sort((left, right) => right.updatedAt - left.updatedAt || right.path.localeCompare(left.path))
    for (const { path } of candidates.slice(TERMINAL_TRANSACTION_RETENTION)) {
      try { this.removeOwnedPathHandled(path, captureOwnedPathIdentity(path)) } catch { /* best-effort bounded maintenance */ }
    }
  }

  private removeOwnedPath(path: string, expected: OwnedPathIdentity): void {
    atomicRemoveIdentitySync(dirname(path), basename(path), expected.parent, expected.entry)
  }

  private removeOwnedPathHandled(path: string, expected: OwnedPathIdentity): void {
    try { this.removeOwnedPath(path, expected) }
    catch (error) {
      if (error instanceof AtomicFsError && error.applied) { syncDirectorySync(dirname(path)); return }
      throw error
    }
  }

  private atomicRenameOutsideJournal(
    parent: string, sourceName: string, targetName: string, expectedParent: AtomicFsParentIdentity,
    expectedSource: AtomicFsSourceIdentity
  ): void {
    const anchorName = renameAnchorName()
    try {
      try { atomicRenameAnchoredSync(parent, sourceName, anchorName, targetName, expectedParent, expectedSource) }
      catch (error) {
        if (!(error instanceof AtomicFsError)) throw error
        if (error.disposition === 'anchor_retained' || error.disposition === 'unknown') throw error
        if (!error.applied || error.disposition !== 'published') throw error
        syncDirectorySync(parent)
      }
      const current = lstatSync(join(parent, targetName), { bigint: true })
      if (String(current.dev) !== canonicalUnsignedIdentity(expectedSource.dev) ||
          String(current.ino) !== canonicalUnsignedIdentity(expectedSource.ino) ||
          entryType(current) !== expectedSource.type || existsSync(join(parent, anchorName))) {
        throw new Error('anchored_rename_validation_failed')
      }
    } catch (error) {
      // These lifecycle renames have no transaction journal. Preserve the
      // high-entropy anchor as evidence and keep this process closed.
      this.setRecoveryBlocked()
      throw error
    }
  }

  private setRecoveryBlocked(): void {
    this.recoveryBlocked = true
    this.rollbackCandidateId = undefined
  }

  private validateTransactionRootIdentity(path: string, expected: OwnedPathIdentity): void {
    try { validateOwnedPathIdentity(path, expected) }
    catch (error) { this.setRecoveryBlocked(); throw error }
  }

  private async refreshRollbackCandidate(): Promise<void> {
    if (this.recoveryBlocked) { this.rollbackCandidateId = undefined; return }
    this.validateOperationRoots()
    const transactions = join(this.dataRoot, 'transactions')
    const journals: Journal[] = []
    try {
      for (const name of (await readdir(transactions)).sort()) {
        if (!isCanonicalUuid(name)) continue
        journals.push(await this.readJournal(join(transactions, name, 'journal.json'), name))
      }
      assertUniqueTransactionOrders(journals)
      const candidate = latestRollbackCandidate(journals)
      if (candidate) await this.validateCompletedArtifacts(candidate)
      this.rollbackCandidateId = candidate?.id
    } catch {
      this.setRecoveryBlocked()
    }
  }

  private async runTerminalMaintenance(refreshCandidate = true): Promise<void> {
    if (this.recoveryBlocked) return
    try {
      if (refreshCandidate) await this.refreshRollbackCandidate()
      if (!this.recoveryBlocked) await this.pruneTerminalArtifacts()
    } catch { this.setRecoveryBlocked() }
  }

  private async pruneTerminalArtifacts(): Promise<void> {
    this.validateOperationRoots()
    const transactions = join(this.dataRoot, 'transactions')
    const journals: Journal[] = []
    const identities = new Map<string, OwnedPathIdentity>()
    for (const name of (await readdir(transactions)).sort()) {
      if (!isCanonicalUuid(name)) continue
      const record = await this.readJournalRecord(join(transactions, name, 'journal.json'), name)
      journals.push(record.journal); identities.set(record.journal.id, record.directoryIdentity)
    }
    assertUniqueTransactionOrders(journals)
    const terminal = journals.filter((journal) => ['completed', 'rolled_back', 'aborted'].includes(journal.state))
      .sort(compareJournalOrderDescending)
    const keep = new Set<string>()
    if (this.rollbackCandidateId) keep.add(this.rollbackCandidateId)
    for (const journal of terminal) if (keep.size < TERMINAL_TRANSACTION_RETENTION) keep.add(journal.id)
    for (const journal of terminal) {
      if (keep.has(journal.id)) {
        await this.cleanupArtifacts(journal)
        continue
      }
      await this.cleanupArtifacts(journal, false)
      const path = this.transactionDir(journal.id)
      const identity = identities.get(journal.id)
      if (!identity) throw new Error('missing_transaction_root_identity')
      this.removeOwnedPathHandled(path, identity)
    }
    this.pruneLockArtifacts()
  }

  private transactionDir(id: string): string {
    if (!isCanonicalUuid(id)) throw new Error('invalid_transaction_id')
    return join(this.dataRoot, 'transactions', id)
  }

  private journalPath(id: string): string { return join(this.transactionDir(id), 'journal.json') }

  private captureOperationRoots(): OperationRootIdentity {
    const transactions = join(this.dataRoot, 'transactions')
    const dataRoot = captureOwnedPathIdentity(this.dataRoot)
    const transactionRoot = captureOwnedPathIdentity(transactions)
    return {
      dataRoot, dataRootDirectory: syncParentIdentity(this.dataRoot),
      transactions: transactionRoot, transactionsDirectory: syncParentIdentity(transactions)
    }
  }

  private validateOperationRoots(lock = this.operationLock): OperationLock {
    if (!lock) throw new Error('operation_lock_not_held')
    try {
      validateOwnedPathIdentity(this.dataRoot, lock.roots.dataRoot)
      validateOwnedPathIdentity(join(this.dataRoot, 'transactions'), lock.roots.transactions)
      const held = fstatSync(lock.fd)
      const current = lstatSync(lock.path)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) {
        throw new Error('operation_lock_changed')
      }
      return lock
    } catch (error) {
      this.setRecoveryBlocked()
      if (error instanceof OperationRootChanged) throw error
      throw new OperationRootChanged()
    }
  }

  private acquireOperationLock(allowStaleRecovery = false): OperationLock {
    const path = join(this.dataRoot, 'operation.lock')
    const retained = PROCESS_OPERATION_LOCKS.get(path)
    if (retained) {
      if (retained.releasePending) {
        this.releaseOperationLock(retained)
        if (PROCESS_OPERATION_LOCKS.has(path)) throw new Error('sync_in_progress')
      }
      try { this.validateOperationRoots(retained) }
      catch { throw new Error('sync_in_progress') }
      if (PROCESS_OPERATION_LOCKS.has(path)) throw new Error('sync_in_progress')
    }
    ensurePrivateDirectorySync(dirname(this.dataRoot), this.home)
    this.reclaimOrRejectOperationRootAnchors()
    ensurePrivateDirectorySync(this.dataRoot, this.home)
    ensurePrivateDirectorySync(join(this.dataRoot, 'transactions'), this.home)
    const processStartToken = this.operationProcessStartToken(process.pid)
    if (!processStartToken) throw new Error('atomic_fs_unavailable')
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID()
      const pendingName = `.ua-operation-lock-pending-${token}`
      const pendingPath = join(this.dataRoot, pendingName)
      const parentIdentity = syncParentIdentity(this.dataRoot)
      let fd: number | undefined
      let owned: ReturnType<typeof fstatSync> | undefined
      let published = false
      try {
        fd = openSync(pendingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
        fchmodSync(fd, 0o600)
        writeFileSync(fd, JSON.stringify({ version: 2, pid: process.pid, token, processStartToken, createdAt: Date.now() }))
        fsyncSync(fd)
        owned = fstatSync(fd)
        if (existsSync(path)) {
          atomicRemoveIdentitySync(this.dataRoot, pendingName, parentIdentity, { dev: owned.dev, ino: owned.ino })
          closeSync(fd); fd = undefined; owned = undefined
          if (!allowStaleRecovery || attempt > 0 ||
              !this.reclaimStaleOperationLock(path, parentIdentity)) throw new Error('sync_in_progress')
          continue
        }
        try {
          this.atomicRenameOutsideJournal(
            this.dataRoot, pendingName, basename(path), parentIdentity,
            { dev: owned.dev, ino: owned.ino, type: 'file' }
          )
        }
        catch (error) {
          if (error instanceof AtomicFsError && error.code === 'atomic_fs_destination_exists') {
            atomicRemoveIdentitySync(this.dataRoot, pendingName, parentIdentity, { dev: owned.dev, ino: owned.ino })
            closeSync(fd); fd = undefined; owned = undefined
            if (!allowStaleRecovery || attempt > 0 ||
                !this.reclaimStaleOperationLock(path, parentIdentity)) throw new Error('sync_in_progress')
            continue
          }
          throw error
        }
        published = true
        const current = lstatSync(path)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
          throw new Error('operation_lock_changed')
        }
        const roots = this.captureOperationRoots()
        const anchor = this.createOperationRootAnchor(token, roots)
        const lock: OperationLock = { path, token, processStartToken, fd, roots, anchor }
        this.operationLock = lock
        this.validateOperationRoots(lock)
        PROCESS_OPERATION_LOCKS.set(path, lock)
        return lock
      } catch (error) {
        if (fd != null && !published && owned) {
          try { atomicRemoveIdentitySync(this.dataRoot, pendingName, parentIdentity, { dev: owned.dev, ino: owned.ino }) }
          catch (cleanupError) { try { closeSync(fd) } catch { /* best effort */ }; throw cleanupError }
        }
        if (fd != null) try { closeSync(fd) } catch { /* best effort */ }
        throw error
      }
    }
    throw new Error('sync_in_progress')
  }

  private createOperationRootAnchor(token: string, roots: OperationRootIdentity): OperationRootAnchor {
    const parentPath = dirname(this.dataRoot)
    const parent = syncParentIdentity(parentPath)
    const path = join(parentPath, `.ua-operation-root-${token}`)
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    try {
      fchmodSync(fd, 0o600)
      const processStartIdentity = processStartIdentitySync(process.pid)
      if (!processStartIdentity) throw new Error('atomic_fs_unavailable')
      writeFileSync(fd, JSON.stringify({
        version: 1, pid: process.pid, token, processStartIdentity, createdAt: Date.now(),
        dataRootIdentity: sealedTransactionRootIdentity(roots.dataRoot),
        transactionsIdentity: sealedTransactionRootIdentity(roots.transactions)
      }))
      fsyncSync(fd)
      const info = fstatSync(fd)
      return { path, fd, parent, entry: { dev: info.dev, ino: info.ino }, roots }
    } catch (error) { try { closeSync(fd) } catch { /* best effort */ }; throw error }
  }

  private reclaimOrRejectOperationRootAnchors(): void {
    const parentPath = dirname(this.dataRoot)
    for (const name of readdirSync(parentPath)) {
      if (!name.startsWith('.ua-operation-root-')) continue
      const path = join(parentPath, name)
      let fd: number | undefined
      try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        const info = fstatSync(fd)
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error('sync_in_progress')
        const record = parseOperationRootAnchor(readFileSync(fd, 'utf8'), name)
        if (!record) throw new Error('sync_in_progress')
        const currentStart = processStartIdentitySync(record.pid)
        if (currentStart && currentStart === record.processStartIdentity) throw new Error('sync_in_progress')
        const current = lstatSync(path)
        if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('sync_in_progress')
        atomicRemoveIdentitySync(parentPath, name, syncParentIdentity(parentPath), { dev: info.dev, ino: info.ino })
      } catch (error) {
        if (error instanceof Error && error.message === 'sync_in_progress') throw error
        throw new Error('sync_in_progress')
      } finally { if (fd != null) try { closeSync(fd) } catch { /* best effort */ } }
    }
  }

  private releaseOperationLock(lock: OperationLock): void {
    let releaseConfirmed = false
    try {
      const held = PROCESS_OPERATION_LOCKS.get(lock.path)
      if (held !== lock) return
      this.validateOperationRoots(lock)
      const owned = fstatSync(lock.fd)
      let current
      try { current = lstatSync(lock.path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!current!.isFile() || current!.isSymbolicLink() || current!.dev !== owned.dev || current!.ino !== owned.ino) {
        return
      }
      const record = parseOperationLock(readFileSync(lock.path, 'utf8'))
      if (!record || record.pid !== process.pid || record.token !== lock.token ||
          record.processStartToken !== lock.processStartToken) return
      const parent = lock.roots.dataRootDirectory
      let tombstone = ''
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = `.ua-operation-lock-released-${lock.token}-${randomUUID()}`
        try {
          this.atomicRenameOutsideJournal(
            this.dataRoot, basename(lock.path), candidate, parent,
            { dev: owned.dev, ino: owned.ino, type: 'file' }
          )
          tombstone = candidate
          break
        } catch (error) {
          if (!(error instanceof AtomicFsError) || error.code !== 'atomic_fs_destination_exists') throw error
        }
      }
      if (!tombstone) return
      lock.releasePath = join(this.dataRoot, tombstone)
      const moved = lstatSync(lock.releasePath)
      if (moved.dev !== owned.dev || moved.ino !== owned.ino) {
        this.setRecoveryBlocked()
        return
      }
      releaseConfirmed = true
      try { atomicRemoveIdentitySync(this.dataRoot, tombstone, parent, { dev: owned.dev, ino: owned.ino }); lock.releasePath = undefined }
      catch { /* the active lock name is already free; maintenance can prune the tombstone */ }
    } catch {
      // Release runs only after the protected operation has ended. Retaining
      // an uncertain lock or tombstone is fail-closed and must not turn a
      // completed background task into an unhandled rejection.
    } finally {
      if (!releaseConfirmed) { lock.releasePending = true; return }
      try {
        atomicRemoveIdentitySync(dirname(lock.anchor.path), basename(lock.anchor.path), lock.anchor.parent, lock.anchor.entry)
      } catch { /* operation.lock is already free; preserve uncertain anchor residue */ }
      try { closeSync(lock.anchor.fd) } catch { /* already closed */ }
      try { closeSync(lock.fd) } catch { /* already closed */ }
      if (PROCESS_OPERATION_LOCKS.get(lock.path) === lock) PROCESS_OPERATION_LOCKS.delete(lock.path)
      if (this.operationLock === lock) this.operationLock = undefined
    }
  }

  private operationProcessStartToken(pid: number): string | undefined {
    const identity = processStartIdentitySync(pid)
    if (!identity) return undefined
    return createHmac('sha256', this.getOperationLockSealKeySync())
      .update(OPERATION_LOCK_START_DOMAIN).update('\0').update(String(pid)).update('\0').update(identity).digest('hex')
  }

  private reclaimStaleOperationLock(path: string, parentIdentity: AtomicFsParentIdentity): boolean {
    let fd: number | undefined
    try {
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const opened = fstatSync(fd)
      if (!opened.isFile() || (opened.mode & 0o077) !== 0 || opened.size > 1024) return false
      const record = parseOperationLock(readFileSync(fd, 'utf8'))
      if (!record) return false
      const currentStart = this.operationProcessStartToken(record.pid)
      if (currentStart && constantTimeHexEqual(currentStart, record.processStartToken)) return false
      const current = lstatSync(path)
      if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) return false
      const tombstone = `.ua-operation-lock-stale-${record.token}-${randomUUID()}`
      this.atomicRenameOutsideJournal(
        this.dataRoot, basename(path), tombstone, parentIdentity,
        { dev: opened.dev, ino: opened.ino, type: 'file' }
      )
      const moved = lstatSync(join(this.dataRoot, tombstone))
      if (moved.dev === opened.dev && moved.ino === opened.ino) {
        try { atomicRemoveIdentitySync(this.dataRoot, tombstone, parentIdentity, { dev: opened.dev, ino: opened.ino }) }
        catch { /* operation.lock is already free; bounded maintenance handles residue */ }
        return true
      }
      this.setRecoveryBlocked()
      return false
    } catch { return false }
    finally { if (fd != null) try { closeSync(fd) } catch { /* best effort */ } }
  }

  private getOperationLockSealKeySync(): Buffer {
    ensurePrivateDirectorySync(this.dataRoot, this.home)
    if (this.operationLockSealKey) {
      try { validateOwnedPathIdentity(this.dataRoot, this.operationLockSealKeyRoot!) }
      catch { this.setRecoveryBlocked(); throw new OperationRootChanged() }
      return this.operationLockSealKey
    }
    const rootIdentity = captureOwnedPathIdentity(this.dataRoot)
    const path = join(this.dataRoot, 'operation-lock.key')
    let key: Buffer
    try {
      key = this.readOperationLockSealKeySync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const pendingName = `.ua-operation-lock-key-pending-${randomUUID()}`
      const pendingPath = join(this.dataRoot, pendingName)
      const parent = syncParentIdentity(this.dataRoot)
      const fd = openSync(pendingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      const generated = randomBytes(OPERATION_LOCK_KEY_BYTES)
      const identity = fstatSync(fd)
      let published = false
      try {
        writeFileSync(fd, generated); fsyncSync(fd)
        try {
          this.atomicRenameOutsideJournal(
            this.dataRoot, pendingName, basename(path), parent,
            { dev: identity.dev, ino: identity.ino, type: 'file' }
          )
          published = true
        }
        catch (publishError) {
          if (!(publishError instanceof AtomicFsError) || publishError.code !== 'atomic_fs_destination_exists') throw publishError
          atomicRemoveIdentitySync(this.dataRoot, pendingName, parent, { dev: identity.dev, ino: identity.ino })
        }
      } catch (publishError) {
        if (!published && existsSync(pendingPath)) {
          try { atomicRemoveIdentitySync(this.dataRoot, pendingName, parent, { dev: identity.dev, ino: identity.ino }) } catch { /* preserve uncertain inode */ }
        }
        throw publishError
      } finally { closeSync(fd) }
      if (published) { key = generated; syncDirectorySync(this.dataRoot) }
      else key = this.readOperationLockSealKeySync(path)
    }
    validateOwnedPathIdentity(this.dataRoot, rootIdentity)
    this.operationLockSealKey = key
    this.operationLockSealKeyRoot = rootIdentity
    return key
  }

  private readOperationLockSealKeySync(path: string): Buffer {
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.size !== OPERATION_LOCK_KEY_BYTES || (info.mode & 0o077) !== 0) throw new Error('invalid_operation_lock_key')
      return readFileSync(fd)
    } finally { closeSync(fd) }
  }

  private async persistJournal(journal: Journal): Promise<void> {
    await this.persistJournalAt(join(this.dataRoot, 'transactions', await this.journalDirectoryName(journal), 'journal.json'), journal)
  }

  private async persistJournalAt(path: string, journal: Journal): Promise<void> {
    if (journal.version !== 4 || !journal.transactionRootIdentity) throw new Error('invalid_journal')
    const expectedDirectory = await this.journalDirectoryName(journal)
    if (!expectedDirectory || basename(dirname(path)) !== expectedDirectory) throw new Error('invalid_journal')
    const operationLock = this.validateOperationRoots()
    this.validateTransactionRootIdentity(dirname(path), ownedIdentity(journal.transactionRootIdentity))
    const persisted: Journal = { ...journal, job: { ...journal.job } }
    persisted.updatedAt = Math.max(Date.now(), journal.updatedAt + 1, journal.job.updatedAt)
    persisted.job.updatedAt = persisted.updatedAt
    persisted.sealVersion = 1
    persisted.seal = await this.journalSeal(persisted)
    this.validateOperationRoots(operationLock)
    this.validateTransactionRootIdentity(dirname(path), ownedIdentity(journal.transactionRootIdentity))
    await durableJson(path, persisted, ownedIdentity(journal.transactionRootIdentity))
    this.validateOperationRoots(operationLock)
    this.validateTransactionRootIdentity(dirname(path), ownedIdentity(journal.transactionRootIdentity))
    Object.assign(journal, persisted)
  }

  private async readJournal(path: string, expectedId: string): Promise<Journal> {
    return (await this.readJournalRecord(path, expectedId)).journal
  }

  private async readJournalRecord(path: string, expectedId: string, recoverCompletedDeviceChange = false): Promise<RecoveredJournal> {
    const operationLock = this.validateOperationRoots()
    await assertSafePathChain(path, this.home)
    const txDir = dirname(path)
    const backupDir = join(txDir, 'backup')
    const [txInfo, journalInfo] = await Promise.all([lstat(txDir, { bigint: true }), lstat(path)])
    if (!txInfo.isDirectory() || txInfo.isSymbolicLink() || (txInfo.mode & 0o077n) !== 0n ||
        !journalInfo.isFile() || journalInfo.isSymbolicLink() || (journalInfo.mode & 0o077) !== 0 || journalInfo.size > MAX_JOURNAL_BYTES) throw new Error('invalid_journal')
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isJournal(raw) || raw.id !== expectedId || !isCanonicalUuid(expectedId) || raw.entries.length > MAX_ENTRIES ||
        raw.job.planId !== raw.planId || raw.job.transactionId !== raw.id) throw new Error('invalid_journal')
    if (!await this.validJournalSeal(raw)) throw new Error('invalid_journal')
    if (raw.version !== 4 || !raw.transactionRootIdentity) throw new Error('invalid_journal')
    if (raw.transactionLocation !== 'canonical') throw new Error('invalid_journal')
    if (raw.renameIntent && !sameRenameSource(raw.renameIntent.expectedSource,
      renameExpectedSource(raw, raw.renameIntent.leg, raw.renameIntent.entryIndex))) throw new Error('invalid_journal')
    const directoryIdentity = ownedIdentity(raw.transactionRootIdentity)
    if (recoverCompletedDeviceChange && raw.state === 'completed') {
      const current = pathIdentity(txDir)
      if (current.ino !== raw.transactionRootIdentity.ino || current.parentIno !== raw.transactionRootIdentity.parentIno ||
          current.parentMode !== raw.transactionRootIdentity.parentMode) throw new Error('path_identity_changed')
    } else this.validateTransactionRootIdentity(txDir, directoryIdentity)
    const targets = new Set<string>(), backups = new Set<string>()
    for (const entry of raw.entries) {
      const target = this.targetFromEntry(entry, raw)
      if (!safeRelative(entry.targetRel) || !/^\d{1,5}$/.test(entry.backupName) ||
          targets.has(target) || backups.has(entry.backupName)) throw new Error('invalid_journal')
      targets.add(target); backups.add(entry.backupName)
      if (!validEntryInvariant(entry, raw.state)) throw new Error('invalid_journal')
      if (entry.link) this.validateSymlinkTarget(resolve(this.home, entry.targetRel), entry.link)
    }
    if (raw.entries.some((entry) => entry.existed && entry.type !== 'symlink' && entry.backedUp)) {
      const backupInfo = await lstat(backupDir)
      if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink() || (backupInfo.mode & 0o077) !== 0) throw new Error('invalid_journal')
    }
    if (raw.state !== 'backing_up' && raw.state !== 'aborted') await this.validateRestoreSet(raw)
    if (recoverCompletedDeviceChange && raw.state === 'completed') await this.rebindCompletedJournalDevice(raw, txDir)
    const currentDirectoryIdentity = ownedIdentity(raw.transactionRootIdentity)
    this.validateTransactionRootIdentity(txDir, currentDirectoryIdentity)
    this.validateOperationRoots(operationLock)
    return {
      journal: raw, transactionName: basename(txDir),
      directoryIdentity: currentDirectoryIdentity
    }
  }

  private async rebindCompletedJournalDevice(journal: Journal, txDir: string): Promise<void> {
    const root = pathIdentity(txDir)
    const sealedRoot = journal.transactionRootIdentity!
    if (root.ino !== sealedRoot.ino || root.parentIno !== sealedRoot.parentIno || root.parentMode !== sealedRoot.parentMode) throw new Error('path_identity_changed')
    let changed = root.dev !== sealedRoot.dev || root.parentDev !== sealedRoot.parentDev
    const staged = this.stagedEntries(journal)
    for (const [index, entry] of journal.entries.entries()) {
      await this.validateParentChain(entry, staged[index].target, true)
      for (const parent of entry.parentChain!) {
        const device = String((await lstat(resolve(this.home, parent.targetRel))).dev)
        changed ||= parent.dev !== device
        parent.dev = device
      }
      const parent = entry.parentChain![entry.parentChain!.length - 1]
      if (entry.expectedPreState.exists) {
        await this.validateExpectedState(staged[index].slot, entry.expectedPreState, true, true)
        const device = String((await lstat(staged[index].slot)).dev)
        changed ||= entry.expectedPreState.dev !== device
        entry.expectedPreState.dev = device
      }
      if (entry.expectedPostState) {
        await this.validateExpectedState(staged[index].target, entry.expectedPostState, true, true)
        if (entry.expectedPostState.exists) {
          const device = String((await lstat(staged[index].target)).dev)
          changed ||= entry.expectedPostState.dev !== device
          entry.expectedPostState.dev = device
        }
      }
      if (entry.stageIdentity && entry.expectedPostState?.exists) {
        changed ||= entry.stageIdentity.dev !== entry.expectedPostState.dev || entry.stageIdentity.parentDev !== parent.dev
        entry.stageIdentity.dev = entry.expectedPostState.dev!; entry.stageIdentity.parentDev = parent.dev
      }
    }
    sealedRoot.dev = root.dev; sealedRoot.parentDev = root.parentDev
    if (changed) await this.persistJournalAt(join(txDir, 'journal.json'), journal)
  }

  private async journalSeal(journal: Journal): Promise<string> {
    const key = await this.getJournalSealKey()
    // Sign the exact JSON data model that durableJson persists. Object fields
    // with `undefined` are omitted by JSON.stringify; normalizing first keeps
    // an in-memory journal and its reloaded representation byte-equivalent.
    const persisted = JSON.parse(JSON.stringify({ ...journal, seal: '' })) as unknown
    return createHmac('sha256', key).update(canonicalValue(persisted)).digest('hex')
  }

  private async validJournalSeal(journal: Journal): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(journal.seal)) return false
    const actual = Buffer.from(journal.seal, 'hex')
    const expected = Buffer.from(await this.journalSeal(journal), 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private async getJournalSealKey(): Promise<Buffer> {
    const operationLock = this.validateOperationRoots()
    if (this.journalSealKey) {
      validateOwnedPathIdentity(this.dataRoot, this.journalSealKeyRoot!)
      return this.journalSealKey
    }
    const path = join(this.dataRoot, 'journal-seal.key')
    let key: Buffer
    try {
      await assertSafePathChain(path, this.home)
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== JOURNAL_KEY_BYTES || (info.mode & 0o077) !== 0) throw new Error('invalid_journal_key')
        key = await handle.readFile()
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      try { key = randomBytes(JOURNAL_KEY_BYTES); await handle.writeFile(key); await handle.sync() } finally { await handle.close() }
      await syncDirectory(this.dataRoot)
    }
    this.validateOperationRoots(operationLock)
    this.journalSealKey = key
    this.journalSealKeyRoot = operationLock.roots.dataRoot
    return key
  }

  private async updateJob(job: CapabilitySyncJob, journal?: Journal): Promise<void> {
    job.updatedAt = nextJobTimestamp(job.updatedAt)
    if (journal) { journal.job = { ...job }; await this.persistJournal(journal); job.updatedAt = journal.job.updatedAt }
    await this.persistLatestJob(job)
    this.jobs.set(job.id, { ...job })
    this.emit('progress', { ...job })
  }

  private releaseLockWaiters(): void {
    if (this.locks.size) return
    for (const resolve of this.lockIdleWaiters) resolve()
    this.lockIdleWaiters.clear()
  }

  private publish(job: CapabilitySyncJob): void {
    this.emit('progress', { ...job })
  }

  private async persistLatestJob(job: CapabilitySyncJob): Promise<void> {
    const operationLock = this.validateOperationRoots()
    await durableJson(join(this.dataRoot, 'latest-job.json'), job, operationLock.roots.dataRoot)
    this.validateOperationRoots(operationLock)
  }

  private async readLatestJob(): Promise<CapabilitySyncJob | undefined> {
    const operationLock = this.validateOperationRoots()
    const path = join(this.dataRoot, 'latest-job.json')
    if (!existsSync(path)) return undefined
    try {
      await assertSafePathChain(path, this.home)
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      this.validateOperationRoots(operationLock)
      return isJob(value) ? value : undefined
    } catch (error) {
      if (error instanceof OperationRootChanged) throw error
      this.validateOperationRoots(operationLock)
      return undefined
    }
  }

  private async mcpValue(item: CanonicalCapability): Promise<TomlRecord> {
    const config = parseToml(await readFile(item.privateRef, 'utf8'))
    const value = mcpRecord(config)[item.privateKey || item.name]
    if (!isRecord(value)) throw new Error('invalid_mcp_schema')
    return cloneToml(value)
  }

  private async readAgentsInputs(source: Inventory, target: Inventory, sourceId: 'codex' | 'traex'): Promise<AgentsInputs> {
    const sourceText = await this.inventoryText(source, 'global-instructions:agents')
    const targetText = await this.inventoryText(target, 'global-instructions:agents')
    const sharedPath = join(this.home, '.agents/AGENTS.md')
    let shared: string | undefined
    try { await assertSafePathChain(sharedPath, this.home); shared = await readFile(sharedPath, 'utf8') } catch { /* absent or unsafe */ }
    return sourceId === 'codex' ? { codex: sourceText, traex: targetText, shared } : { codex: targetText, traex: sourceText, shared }
  }

  private async inventoryText(inventory: Inventory, id: string): Promise<string | undefined> {
    const item = inventory.items.find((candidate) => candidate.id === id && candidate.compatible)
    if (!item) return undefined
    try { return await readFile(item.privateRef, 'utf8') } catch { return undefined }
  }

  private agentsItem(inputs: AgentsInputs, source: Inventory, target: Inventory): CapabilityScanResult['items'][number] | undefined {
    if (!inputs.codex && !inputs.traex && !inputs.shared) return undefined
    const invalid = [...source.items, ...target.items].find((item) => item.kind === 'global-instructions' && !item.compatible)
    const values = [inputs.codex, inputs.traex, inputs.shared].filter((value): value is string => value != null)
    const same = values.length >= 2 && values.every((value) => semanticHash(value) === semanticHash(values[0]))
    const sharedConflict = !!inputs.shared && [inputs.codex, inputs.traex].filter(Boolean).every((value) => semanticHash(value!) !== semanticHash(inputs.shared!))
    return {
      id: 'global-instructions:agents', kind: 'global-instructions', name: 'AGENTS.md（双端共享）',
      status: invalid ? 'invalid' : same ? 'same' : 'conflict', compatible: !invalid, selectable: !invalid && !same, cloneSafe: !invalid,
      defaultSelected: false, issueCode: invalid?.issueCode || (sharedConflict ? 'shared_source_conflict' : undefined)
    }
  }

  private agentsContent(strategy: AgentsStrategy, inputs: AgentsInputs, throwOnConflict: boolean): string | undefined {
    if (strategy === 'keep-codex') return inputs.codex
    if (strategy === 'keep-traex') return inputs.traex
    if (strategy === 'keep-shared') return inputs.shared
    try { return mergeMarkdownInputs(inputs) } catch (error) { if (throwOnConflict) throw new Error('agents_merge_conflict'); return undefined }
  }
}

class CancelledBeforeCommit extends Error {}
class StaleBeforeCommit extends Error {}
class TargetChangedBeforeCommit extends Error {}
class CommittedTargetChanged extends Error { constructor() { super('target_changed_since_commit') } }
class OperationRootChanged extends Error { constructor() { super('operation_root_changed') } }
function atomicCommitError(error: unknown): Error {
  if (error instanceof AtomicFsError &&
      (error.code === 'atomic_fs_destination_exists' || error.code === 'atomic_fs_source_not_found' ||
       error.code === 'atomic_fs_identity_mismatch' || error.code === 'atomic_fs_parent_changed')) {
    return new TargetChangedBeforeCommit()
  }
  return error instanceof Error ? error : new Error('commit_failed')
}
function anchoredRenameNeedsRecovery(error: unknown): boolean {
  return error instanceof AtomicFsError &&
    (error.disposition === 'anchor_retained' || error.disposition === 'published' || error.disposition === 'unknown')
}
function atomicRollbackError(error: unknown): Error {
  if (error instanceof AtomicFsError &&
      (error.code === 'atomic_fs_destination_exists' || error.code === 'atomic_fs_source_not_found' ||
       error.code === 'atomic_fs_identity_mismatch' || error.code === 'atomic_fs_parent_changed')) {
    return new CommittedTargetChanged()
  }
  return error instanceof Error ? error : new Error('rollback_failed')
}
type TransactionPhase = 'backup' | 'stage' | 'stage_validation' | 'commit' | 'verification'
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeRelative = (value: string): boolean => !!value && !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep) && !value.includes('\0')
const finiteInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const boundedText = (value: unknown, max = 300): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const isCanonicalUuid = (value: unknown): value is string => isUuid(value) && value === value.toLowerCase()
const pendingTransactionId = (name: string): string | undefined => {
  const prefix = '.ua-transaction-pending-'
  const id = name.startsWith(prefix) ? name.slice(prefix.length) : ''
  return isCanonicalUuid(id) ? id : undefined
}
const isTransactionSeed = (name: string): boolean => {
  const match = /^\.ua-transaction-seed-[a-f0-9]{32}-([0-9a-f-]{36})$/.exec(name)
  return !!match && isCanonicalUuid(match[1])
}
const isDisposableLockArtifact = (name: string): boolean =>
  /^\.ua-operation-lock-(?:released|stale)-[0-9a-f-]+$/.test(name)
const isSafeLeafName = (value: string): boolean => boundedText(value, 200) && value !== '.' && value !== '..' && !value.startsWith('.') && !value.includes('/') && !value.includes('\\')
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key))

function isJob(value: unknown): value is CapabilitySyncJob {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id','planId','operation','transactionId','state','stage','progress','errorCode','result','updatedAt']) ||
      !isCanonicalUuid(value.id) || !boundedText(value.planId) || !JOB_STATES.has(String(value.state)) ||
      !finiteInteger(value.updatedAt, 1)) return false
  if (value.operation != null && !['sync','remove-selected'].includes(String(value.operation))) return false
  if (value.transactionId != null && !isCanonicalUuid(value.transactionId)) return false
  if (value.stage != null && (!boundedText(value.stage, 100) || !JOB_STAGES.has(value.stage))) return false
  if (value.errorCode != null && !JOB_ERRORS.has(value.errorCode as CapabilityJobErrorCode)) return false
  if (value.progress != null && (!isRecord(value.progress) || !hasOnlyKeys(value.progress, ['completed','total']) ||
      !finiteInteger(value.progress.completed, 0, MAX_ENTRIES) || !finiteInteger(value.progress.total, 0, MAX_ENTRIES) || value.progress.completed > value.progress.total)) return false
  if (value.result != null && !isJobResult(value.result)) return false
  return true
}

function latestCapabilityJob(jobs: CapabilitySyncJob[]): CapabilitySyncJob | undefined {
  return [...jobs].sort((left, right) => right.updatedAt - left.updatedAt ||
    (TERMINAL.has(right.state) ? 1 : 0) - (TERMINAL.has(left.state) ? 1 : 0) || right.id.localeCompare(left.id))[0]
}

function deduplicateJobs(jobs: CapabilitySyncJob[]): CapabilitySyncJob[] {
  const byId = new Map<string, CapabilitySyncJob>()
  for (const job of jobs) {
    const prior = byId.get(job.id)
    if (!prior || latestCapabilityJob([prior, job]) === job) byId.set(job.id, job)
  }
  return [...byId.values()]
}

function latestRollbackCandidate(journals: Journal[]): Journal | undefined {
  assertUniqueTransactionOrders(journals)
  return [...journals].sort(compareJournalOrderDescending)
    .find((journal) => journal.state === 'completed')
}

function compareJournalOrderDescending(left: Journal, right: Journal): number {
  if (left.version >= 2 || right.version >= 2) {
    if (left.version !== right.version) return right.version - left.version
    return right.transactionOrder! - left.transactionOrder!
  }
  const leftOrder = left.completedAt || left.updatedAt
  const rightOrder = right.completedAt || right.updatedAt
  return rightOrder - leftOrder || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
}

function isJournal(value: unknown): value is Journal {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version','sealVersion','seal','transactionRootIdentity','id','provider','sharedAgents','planId','state','commitIndex','rollbackIndex','createdAt','completedAt','updatedAt','transactionOrder','preparationNonce','transactionLocation','renameIntent','entries','rollbackKind','cleanup','job']) ||
      ![1,2,3,4].includes(value.version as number) || (value.version === 1 ? value.transactionOrder != null : !finiteInteger(value.transactionOrder, 1)) ||
      value.sealVersion !== 1 || typeof value.seal !== 'string' || !/^[a-f0-9]{64}$/.test(value.seal) || !isCanonicalUuid(value.id) || !['codex','traex'].includes(String(value.provider)) || typeof value.sharedAgents !== 'boolean' ||
      !boundedText(value.planId) || !JOURNAL_STATES.has(value.state as JournalState) || !finiteInteger(value.commitIndex, 0, MAX_ENTRIES) ||
      !finiteInteger(value.rollbackIndex, 0, MAX_ENTRIES) || !finiteInteger(value.createdAt, 1) || !finiteInteger(value.updatedAt, value.createdAt as number) ||
      !Array.isArray(value.entries) || !isJob(value.job)) return false
  if ((value.version as number) >= 3 ? !isTransactionRootIdentity(value.transactionRootIdentity) : value.transactionRootIdentity != null) return false
  if ((value.version as number) === 4) {
    if (typeof value.preparationNonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.preparationNonce)) return false
    if (!['seed','preparation','canonical'].includes(String(value.transactionLocation))) return false
    if (value.renameIntent != null && !isRenameIntent(value.renameIntent, value.entries.length)) return false
  } else if (value.preparationNonce != null || value.transactionLocation != null || value.renameIntent != null) return false
  if (value.completedAt != null && !finiteInteger(value.completedAt, value.createdAt as number, value.updatedAt as number)) return false
  if (value.rollbackKind != null && !['automatic','manual'].includes(String(value.rollbackKind))) return false
  if (value.cleanup != null && (!isRecord(value.cleanup) || !hasOnlyKeys(value.cleanup, ['index','artifact']) ||
      !finiteInteger(value.cleanup.index, 0, MAX_ENTRIES) || !['slot','stage','post'].includes(String(value.cleanup.artifact)))) return false
  if ((value.commitIndex as number) > value.entries.length || (value.rollbackIndex as number) > (value.commitIndex as number)) return false
  if (['backing_up','staging','ready'].includes(String(value.state)) && (value.commitIndex !== 0 || value.rollbackIndex !== 0)) return false
  if (['committing','verifying','completed'].includes(String(value.state)) && value.rollbackIndex !== 0) return false
  if (['staging','ready','committing','verifying','completed','rolling_back','rolled_back'].includes(String(value.state)) && value.entries.some((entry) => !isRecord(entry) || entry.backedUp !== true)) return false
  if (['verifying','completed'].includes(String(value.state)) && value.commitIndex !== value.entries.length) return false
  if (value.state === 'aborted' && (value.commitIndex !== 0 || value.rollbackIndex !== 0)) return false
  const expectedJobStates: Record<JournalState, ReadonlySet<string>> = {
    backing_up: new Set(['backing_up']),
    staging: new Set(['staging']),
    ready: new Set(['staging']),
    committing: new Set(['committing']),
    verifying: new Set(['verifying']),
    completed: new Set(['completed']),
    rolling_back: new Set(['rolling_back', 'rollback_failed']),
    rolled_back: new Set(['rolled_back', 'cancelled']),
    aborted: new Set(['cancelled', 'failed_no_change'])
  }
  if (!expectedJobStates[value.state as JournalState].has(String(value.job.state))) return false
  if (value.state === 'rolled_back' && value.rollbackIndex !== value.commitIndex) return false
  if (value.rollbackKind === 'manual' && !['rolling_back','rolled_back'].includes(String(value.state))) return false
  const guarded = ['ready','committing','verifying','completed'].includes(String(value.state)) || value.rollbackKind != null || (value.commitIndex as number) > 0
  if (value.cleanup != null && (value.cleanup.index as number) >= value.entries.length) return false
  return value.entries.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['targetRel','backupName','existed','backedUp','type','mode','link','digest','expectedPreState','expectedPostState','stageIdentity','parentChain']) &&
    typeof entry.targetRel === 'string' && typeof entry.backupName === 'string' &&
    typeof entry.existed === 'boolean' && typeof entry.backedUp === 'boolean' &&
    (entry.type == null || ['file','directory','symlink'].includes(String(entry.type))) &&
    (entry.mode == null || finiteInteger(entry.mode, 0, 0o777)) && (entry.link == null || boundedText(entry.link, 4096)) &&
    (entry.digest == null || (typeof entry.digest === 'string' && /^[a-f0-9]{64}$/.test(entry.digest))) &&
    isSealedPathState(entry.expectedPreState) && (entry.expectedPostState == null || isSealedPathState(entry.expectedPostState)) &&
    (entry.stageIdentity == null || isPathIdentity(entry.stageIdentity)) &&
    (entry.parentChain == null || (Array.isArray(entry.parentChain) && entry.parentChain.length > 0 && entry.parentChain.length <= 32 && entry.parentChain.every(isParentIdentity))) &&
    (!guarded || (entry.expectedPostState != null && entry.parentChain != null)))
}

function isRenameIntent(value: unknown, entryCount: number): value is RenameIntent {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version','leg','entryIndex','anchorName','expectedSource']) ||
      value.version !== 1 || !['target_to_slot','stage_to_target','target_to_post','slot_to_target','preparation_to_transaction'].includes(String(value.leg)) ||
      typeof value.anchorName !== 'string' || !isRenameAnchorArtifact(value.anchorName) ||
      !isRecord(value.expectedSource) || !hasOnlyKeys(value.expectedSource, ['dev','ino','type']) ||
      !isCanonicalUnsignedIdentity(value.expectedSource.dev) || !isCanonicalUnsignedIdentity(value.expectedSource.ino) ||
      !['file','directory','symlink'].includes(String(value.expectedSource.type))) return false
  if (value.leg === 'preparation_to_transaction') return !Object.prototype.hasOwnProperty.call(value, 'entryIndex') && value.expectedSource.type === 'directory'
  return finiteInteger(value.entryIndex, 0, entryCount - 1)
}

function assertUniqueTransactionOrders(journals: Journal[]): void {
  const seen = new Set<number>()
  for (const journal of journals) {
    if (journal.version < 2) continue
    if (seen.has(journal.transactionOrder!)) throw new Error('duplicate_transaction_order')
    seen.add(journal.transactionOrder!)
  }
}

function isPathIdentity(value: unknown): value is PathIdentity {
  return isRecord(value) && hasOnlyKeys(value, ['dev','ino','parentDev','parentIno','parentMode']) &&
    typeof value.dev === 'string' && /^\d+$/.test(value.dev) && typeof value.ino === 'string' && /^\d+$/.test(value.ino) &&
    typeof value.parentDev === 'string' && /^\d+$/.test(value.parentDev) && typeof value.parentIno === 'string' && /^\d+$/.test(value.parentIno) &&
    finiteInteger(value.parentMode, 0, 0o777)
}

function isTransactionRootIdentity(value: unknown): value is TransactionRootIdentity {
  return isRecord(value) && hasOnlyKeys(value, ['dev','ino','type','parentDev','parentIno','parentMode']) && value.type === 'directory' &&
    isCanonicalUnsignedIdentity(value.dev) && isCanonicalUnsignedIdentity(value.ino) &&
    isCanonicalUnsignedIdentity(value.parentDev) && isCanonicalUnsignedIdentity(value.parentIno) &&
    finiteInteger(value.parentMode, 0, 0o777)
}

function pathIdentity(path: string): PathIdentity {
  const info = lstatSync(path, { bigint: true })
  const parent = syncParentIdentity(dirname(path))
  return { dev: String(info.dev), ino: String(info.ino), parentDev: String(parent.dev), parentIno: String(parent.ino), parentMode: parent.mode }
}

function canonicalUnsignedIdentity(value: string | number | bigint): string {
  const text = typeof value === 'bigint'
    ? value.toString()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d*)$/.test(text)) throw new Error('invalid_path_identity')
  const normalized = BigInt(text)
  if (normalized > 0xffffffffffffffffn) throw new Error('invalid_path_identity')
  return normalized.toString()
}

function isCanonicalUnsignedIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false
  try { return BigInt(value) <= 0xffffffffffffffffn } catch { return false }
}

function sourceIdentityFromState(state: SealedPathState | undefined): AtomicFsSourceIdentity {
  if (!state?.exists || !state.type || state.dev == null || state.ino == null)
    throw new Error('missing_source_identity')
  return { dev: state.dev, ino: state.ino, type: state.type }
}

function sourceIdentityFromTransactionRoot(identity: TransactionRootIdentity): AtomicFsSourceIdentity {
  return { dev: identity.dev, ino: identity.ino, type: 'directory' }
}

function canonicalSourceIdentity(identity: AtomicFsSourceIdentity): RenameIntent['expectedSource'] {
  return { dev: canonicalUnsignedIdentity(identity.dev), ino: canonicalUnsignedIdentity(identity.ino), type: identity.type }
}

function sameRenameSource(left: RenameIntent['expectedSource'], right: AtomicFsSourceIdentity): boolean {
  const canonical = canonicalSourceIdentity(right)
  return left.dev === canonical.dev && left.ino === canonical.ino && left.type === canonical.type
}

function renameExpectedSource(journal: Journal, leg: RenameLeg, entryIndex?: number): AtomicFsSourceIdentity {
  if (leg === 'preparation_to_transaction') {
    if (entryIndex != null || !journal.transactionRootIdentity) throw new Error('invalid_journal')
    return sourceIdentityFromTransactionRoot(journal.transactionRootIdentity)
  }
  if (!finiteInteger(entryIndex, 0, journal.entries.length - 1)) throw new Error('invalid_journal')
  const entry = journal.entries[entryIndex]
  return sourceIdentityFromState(leg === 'target_to_slot' || leg === 'slot_to_target'
    ? entry.expectedPreState : entry.expectedPostState)
}

function renameAnchorName(): string { return `.ua-rn-v1-${randomBytes(16).toString('hex')}` }
function isRenameAnchorArtifact(name: string): boolean { return name.length === 42 && RENAME_ANCHOR_ARTIFACT.test(name) }

function ownedIdentity(identity: PathIdentity): OwnedPathIdentity {
  return { parent: { dev: identity.parentDev, ino: identity.parentIno, mode: identity.parentMode }, entry: { dev: identity.dev, ino: identity.ino } }
}

function sealedTransactionRootIdentity(identity: OwnedPathIdentity): TransactionRootIdentity {
  return {
    dev: canonicalUnsignedIdentity(identity.entry.dev), ino: canonicalUnsignedIdentity(identity.entry.ino), type: 'directory',
    parentDev: canonicalUnsignedIdentity(identity.parent.dev), parentIno: canonicalUnsignedIdentity(identity.parent.ino),
    parentMode: identity.parent.mode
  }
}

function identityFromState(state: SealedPathState, entry: BackupEntry): PathIdentity | undefined {
  const parent = entry.parentChain?.[entry.parentChain.length - 1]
  if (!state.exists || !state.dev || !state.ino || !parent) return undefined
  return { dev: state.dev, ino: state.ino, parentDev: parent.dev, parentIno: parent.ino, parentMode: parent.mode }
}

function captureOwnedPathIdentity(path: string): OwnedPathIdentity {
  const info = lstatSync(path, { bigint: true })
  return { parent: syncParentIdentity(dirname(path)), entry: { dev: info.dev, ino: info.ino } }
}

function validateOwnedPathIdentity(path: string, expected: OwnedPathIdentity): void {
  const actual = captureOwnedPathIdentity(path)
  if (String(actual.parent.dev) !== String(expected.parent.dev) || String(actual.parent.ino) !== String(expected.parent.ino) ||
      actual.parent.mode !== expected.parent.mode || String(actual.entry.dev) !== String(expected.entry.dev) ||
      String(actual.entry.ino) !== String(expected.entry.ino)) throw new Error('path_identity_changed')
}

function isSealedPathState(value: unknown): value is SealedPathState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['exists','type','mode','dev','ino','link','digest']) || typeof value.exists !== 'boolean') return false
  if (!value.exists) return Object.keys(value).length === 1
  return ['file','directory','symlink'].includes(String(value.type)) && finiteInteger(value.mode, 0, 0o777) &&
    typeof value.dev === 'string' && /^\d+$/.test(value.dev) && typeof value.ino === 'string' && /^\d+$/.test(value.ino) &&
    (value.type === 'symlink' ? boundedText(value.link, 4096) && value.digest == null : value.link == null && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest))
}

function isParentIdentity(value: unknown): value is ParentIdentity {
  return isRecord(value) && hasOnlyKeys(value, ['targetRel','mode','dev','ino']) && typeof value.targetRel === 'string' && safeRelative(value.targetRel) &&
    finiteInteger(value.mode, 0, 0o777) && typeof value.dev === 'string' && /^\d+$/.test(value.dev) &&
    typeof value.ino === 'string' && /^\d+$/.test(value.ino)
}

function classifyPhaseError(error: unknown, phase: TransactionPhase): CapabilityJobErrorCode {
  const message = error instanceof Error ? error.message : ''
  if (error instanceof AtomicFsError && error.code === 'atomic_fs_unavailable') return 'atomic_fs_unavailable'
  if (message === 'verification_failed') return 'verification_failed'
  if (message === 'stage_validation_failed' || message === 'credential_required') return 'stage_validation_failed'
  if (phase === 'backup') return 'backup_failed'
  if (phase === 'stage_validation') return 'stage_validation_failed'
  if (phase === 'stage') return 'stage_failed'
  if (phase === 'verification') return 'verification_failed'
  return 'commit_failed'
}

async function durableJson(path: string, value: unknown, expectedParent: OwnedPathIdentity): Promise<void> {
  validateOwnedPathIdentity(dirname(path), expectedParent)
  const temporary = `${path}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync()
  } finally { await handle.close() }
  validateOwnedPathIdentity(dirname(path), expectedParent)
  await rename(temporary, path)
  validateOwnedPathIdentity(dirname(path), expectedParent)
  await syncDirectory(dirname(path))
}

function validEntryInvariant(entry: BackupEntry, state: JournalState): boolean {
  const backupRequired = !['backing_up', 'aborted'].includes(state)
  if (!entry.existed) return (backupRequired ? entry.backedUp : true) && entry.type == null && entry.mode == null && entry.link == null && entry.digest == null
  if (!entry.type || entry.mode == null) return false
  if (entry.type === 'symlink') return (backupRequired ? entry.backedUp : true) && !!entry.link && entry.digest == null
  if (!backupRequired && !entry.backedUp) return entry.link == null && (entry.digest == null || /^[a-f0-9]{64}$/.test(entry.digest))
  return entry.backedUp && entry.link == null && !!entry.digest
}

function isJobResult(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['verified','noop','skipped','manualRequired','failed','rolledBack','residualDifferences'])) return false
  return ['verified','noop','skipped','manualRequired','failed','rolledBack','residualDifferences']
    .every((key) => finiteInteger(value[key], 0, MAX_ENTRIES))
}

function sameExpectedState(a: ExpectedState, b: ExpectedState): boolean {
  if (a.agentsFingerprint !== b.agentsFingerprint || a.fingerprints.size !== b.fingerprints.size) return false
  for (const [key, value] of a.fingerprints) if (b.fingerprints.get(key) !== value) return false
  return true
}

function memoryTarget(candidates: string[], name: string): string {
  if (!MEMORY_NAMES.includes(name)) throw new Error('unsafe_memory_path')
  const target = candidates.find((candidate) => basename(candidate) === name)
  if (!target) throw new Error('unsafe_memory_path')
  return target
}

function artifactPath(target: string, kind: 'stage' | 'rollback' | 'restore' | 'post', transactionId: string, index: number): string {
  return join(dirname(target), `.ua-${kind}-${basename(target)}-${transactionId}-${index}`)
}

function stableValue(value: unknown): string {
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`
  return `${typeof value}:${String(value)}`
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function sealedPathState(path: string): Promise<SealedPathState> {
  let info
  try { info = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
  const type: EntryType = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : (() => { throw new Error('unsafe_path_type') })()
  return {
    exists: true, type, mode: info.mode & 0o777, dev: String(info.dev), ino: String(info.ino),
    link: type === 'symlink' ? await readlink(path) : undefined,
    digest: type === 'symlink' ? undefined : await digestPath(path)
  }
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function sameSealedPathState(actual: SealedPathState, expected: SealedPathState, requireIdentity: boolean, ignoreDevice = false): boolean {
  if (actual.exists !== expected.exists) return false
  if (!actual.exists || !expected.exists) return true
  return actual.type === expected.type && actual.mode === expected.mode && actual.link === expected.link && actual.digest === expected.digest &&
    (!requireIdentity || (actual.ino === expected.ino && (ignoreDevice || actual.dev === expected.dev)))
}

async function captureParentChain(target: string, home: string): Promise<ParentIdentity[]> {
  const base = resolve(home)
  const rel = relative(base, dirname(target))
  if (!safeRelative(rel)) throw new Error('unsafe_parent_chain')
  const output: ParentIdentity[] = []
  let cursor = base
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    const info = await lstat(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_parent_chain')
    output.push({ targetRel: relative(base, cursor), mode: info.mode & 0o777, dev: String(info.dev), ino: String(info.ino) })
  }
  return output
}

async function digestPath(path: string): Promise<string> {
  const hash = createHash('sha256')
  async function walk(current: string, root: string): Promise<void> {
    const info = await lstat(current)
    const rel = relative(root, current)
    hash.update(info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : 'f').update(rel).update('\0').update(String(info.mode & 0o777)).update('\0')
    if (info.isSymbolicLink()) { hash.update(await readlink(current)).update('\0'); return }
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await walk(join(current, name), root)
      return
    }
    hash.update(await readFile(current)).update('\0')
  }
  await walk(path, path)
  return hash.digest('hex')
}

async function syncTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await syncTree(join(path, name))
    await syncDirectory(path)
    return
  }
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function copySkillTree(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (path) => path === source || !isRenameAnchorArtifact(basename(path))
  })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function readAny(path: string): Promise<string> { try { return await readFile(path, 'utf8') } catch { return '' } }

export function mergeMarkdown(a: string, b: string): string {
  const chunks = (source: string): string[] => source.split(/(?=^#{1,6} )/m).map((chunk) => chunk.trim()).filter(Boolean)
  const output = chunks(a)
  const byHeading = new Map<string, string>()
  for (const chunk of output) {
    const heading = chunk.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim().toLowerCase()
    if (heading) byHeading.set(heading, chunk)
  }
  for (const chunk of chunks(b)) {
    const heading = chunk.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim().toLowerCase()
    if (!heading) { if (!output.includes(chunk)) output.push(chunk); continue }
    const prior = byHeading.get(heading)
    if (prior && prior !== chunk) throw new Error('markdown_conflict')
    if (!prior) { byHeading.set(heading, chunk); output.push(chunk) }
  }
  return output.length ? output.join('\n\n') + '\n' : ''
}

function mergeMarkdownInputs(inputs: AgentsInputs): string {
  let output = ''
  const seen = new Set<string>()
  for (const value of [inputs.codex, inputs.traex, inputs.shared]) {
    if (!value) continue
    const fingerprint = semanticHash(value)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    output = mergeMarkdown(output, value)
  }
  return output
}

async function verifyAgentsShared(home: string, expectedFingerprint: string): Promise<void> {
  const sharedPath = join(home, '.agents/AGENTS.md')
  const shared = await realpath(sharedPath)
  const codex = await realpath(providerPaths('codex', home).agents)
  const traex = await realpath(providerPaths('traex', home).agents)
  if (shared !== codex || shared !== traex) throw new Error('verification_failed')
  const [sharedInfo, codexInfo, traexInfo] = await Promise.all([stat(sharedPath), stat(providerPaths('codex', home).agents), stat(providerPaths('traex', home).agents)])
  if (sharedInfo.ino !== codexInfo.ino || sharedInfo.ino !== traexInfo.ino) throw new Error('verification_failed')
  if (semanticHash(await readFile(sharedPath)) !== expectedFingerprint) throw new Error('verification_failed')
}

function counts(plan: CapabilitySyncPlan) {
  const changed = plan.operations.filter((operation) => operation.action === 'write' || operation.action === 'share' || operation.action === 'delete')
  return {
    verified: changed.length,
    noop: plan.operations.filter((operation) => operation.action === 'noop').length,
    skipped: plan.operations.filter((operation) => operation.action === 'skip').length,
    // Every changed operation passed static V1 validation. Native-provider V2
    // validation is not claimed anywhere by this result.
    manualRequired: 0,
    failed: 0, rolledBack: 0, residualDifferences: 0
  }
}

function rollbackResult(count: number) {
  return { verified: 0, noop: 0, skipped: 0, manualRequired: 0, failed: 0, rolledBack: count, residualDifferences: 0 }
}

function nextJobTimestamp(previous: number): number {
  return Math.max(Date.now(), previous + 1)
}

function ensurePrivateDirectorySync(path: string, home: string): void {
  const base = resolve(home)
  const candidate = resolve(path)
  const rel = relative(base, candidate)
  if (rel && !safeRelative(rel)) throw new Error('unsafe_path')
  const baseInfo = lstatSync(base)
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error('unsafe_path')
  let cursor = base
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    try { mkdirSync(cursor, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = lstatSync(cursor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_path')
  }
  chmodSync(candidate, 0o700)
}

interface OperationLockRecord { version: 2; pid: number; token: string; processStartToken: string; createdAt: number }
function parseOperationLock(text: string): OperationLockRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value) || !hasOnlyKeys(value, ['version','pid','token','processStartToken','createdAt']) || value.version !== 2 ||
        !finiteInteger(value.pid, 1, 0x7fffffff) || !isCanonicalUuid(value.token) ||
        typeof value.processStartToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.processStartToken) ||
        !finiteInteger(value.createdAt, 0)) return undefined
    return value as unknown as OperationLockRecord
  } catch { return undefined }
}

function parseOperationRootAnchor(text: string, name: string): OperationRootAnchorRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value) || !hasOnlyKeys(value, ['version','pid','token','processStartIdentity','createdAt','dataRootIdentity','transactionsIdentity']) ||
        value.version !== 1 || !finiteInteger(value.pid, 1, 0x7fffffff) || !isCanonicalUuid(value.token) ||
        name !== `.ua-operation-root-${value.token}` || typeof value.processStartIdentity !== 'string' ||
        !/^v1:[1-9]\d{0,19}:\d{6}$/.test(value.processStartIdentity) || !finiteInteger(value.createdAt, 0) ||
        !isTransactionRootIdentity(value.dataRootIdentity) || !isTransactionRootIdentity(value.transactionsIdentity)) return undefined
    return value as unknown as OperationRootAnchorRecord
  } catch { return undefined }
}

function syncParentIdentity(path: string): AtomicFsParentIdentity {
  const info = lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AtomicFsError('atomic_fs_invalid_parent')
  return { dev: info.dev, ino: info.ino, mode: Number(info.mode & 0o777n) }
}

function entryType(info: NonNullable<ReturnType<typeof lstatSync>>): EntryType {
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  throw new Error('unsafe_path_type')
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function syncDirectorySync(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
