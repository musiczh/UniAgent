import { isRecord, isId, isInteger, validateZCodeFrame, ZCODE_LIMITS } from './protocol'
import type { ZCodeAssemblyEvent, ZCodeDeliveryKind, ZCodeWireFault } from './protocol'

interface Assembly { identity: string; count: number; bytes: number; checksum: string; chunks: Map<number, Buffer>; size: number; startedAt: number }
interface Route { topic: string; subscriptionId: string; ordinal: number; id: string; complete: boolean; failed: boolean; assembly?: Assembly }
export function zcodeCrc32(bytes: Uint8Array): string {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

export class ZCodeWireAssembler {
  private routes = new Map<string, Route>()
  reset(): void { this.routes.clear() }
  forget(topic: string, subscriptionId: string): void { this.routes.delete(this.key(topic, subscriptionId)) }
  private key(topic: string, subscriptionId: string): string { return `${topic}\0${subscriptionId}` }
  private fault(route: Route | undefined, reason: string): ZCodeWireFault {
    if (route) { route.assembly = undefined; route.failed = true }
    return { kind: 'fault', reason, ...(route ? { topic: route.topic, subscriptionId: route.subscriptionId, logicalFrameOrdinal: route.ordinal } : {}) }
  }
  expire(now = Date.now()): ZCodeWireFault[] {
    const faults: ZCodeWireFault[] = []
    for (const route of this.routes.values()) if (route.assembly && now - route.assembly.startedAt >= ZCODE_LIMITS.assemblyTimeout) {
      faults.push(this.fault(route, 'assembly_timeout'))
    }
    return faults
  }
  accept(candidate: unknown, now = Date.now()): ZCodeAssemblyEvent[] {
    let route: Route | undefined
    try {
      if (!isRecord(candidate) || candidate.wireVersion !== 3 || !['complete', 'fragment'].includes(candidate.kind)
        || !isId(candidate.topic) || !isId(candidate.subscriptionId) || !isId(candidate.logicalFrameId)
        || !isInteger(candidate.logicalFrameOrdinal) || candidate.logicalFrameOrdinal === 0
        || !['initial', 'online', 'recovery'].includes(candidate.deliveryKind)) throw new Error('incompatible_wire')
      const wire = candidate
      const key = this.key(wire.topic, wire.subscriptionId)
      route = this.routes.get(key)
      if (route && wire.logicalFrameOrdinal < route.ordinal) return []
      if (route && wire.logicalFrameOrdinal === route.ordinal) {
        if (wire.logicalFrameId !== route.id) throw new Error('ordinal_conflict')
        if (route.complete || route.failed) return []
      } else {
        if (route?.assembly && wire.deliveryKind !== 'recovery') throw new Error('superseded_incomplete_frame')
        if (route?.failed && wire.deliveryKind !== 'recovery') return []
        if (!route && this.routes.size >= 512) throw new Error('route_budget_exceeded')
        route = { topic: wire.topic, subscriptionId: wire.subscriptionId, ordinal: wire.logicalFrameOrdinal,
          id: wire.logicalFrameId, complete: false, failed: false }
        this.routes.set(key, route)
      }
      let frame = wire.frame
      if (wire.kind === 'fragment') {
        if (!isInteger(wire.fragmentCount) || wire.fragmentCount < 1 || wire.fragmentCount > ZCODE_LIMITS.fragments
          || !isInteger(wire.fragmentIndex) || wire.fragmentIndex >= wire.fragmentCount
          || !isInteger(wire.logicalBytes) || wire.logicalBytes < wire.fragmentCount || wire.logicalBytes > ZCODE_LIMITS.logical
          || !isRecord(wire.checksum) || wire.checksum.algorithm !== 'crc32' || !/^[0-9a-f]{8}$/.test(wire.checksum.value)
          || typeof wire.dataBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wire.dataBase64)) throw new Error('invalid_fragment')
        const identity = JSON.stringify([wire.logicalFrameId, wire.logicalFrameOrdinal, wire.deliveryKind, wire.fragmentCount, wire.logicalBytes, wire.checksum.value])
        if (!route.assembly) {
          if ([...this.routes.values()].filter(item => item.assembly).length >= ZCODE_LIMITS.concurrent) throw new Error('assembly_budget_exceeded')
          route.assembly = { identity, count: wire.fragmentCount, bytes: wire.logicalBytes, checksum: wire.checksum.value,
            chunks: new Map(), size: 0, startedAt: now }
        }
        const entry = route.assembly
        if (entry.identity !== identity) throw new Error('fragment_identity_conflict')
        const bytes = Buffer.from(wire.dataBase64, 'base64')
        if (!bytes.length || bytes.length > ZCODE_LIMITS.line || bytes.toString('base64') !== wire.dataBase64) throw new Error('invalid_base64')
        const prior = entry.chunks.get(wire.fragmentIndex)
        if (prior && !prior.equals(bytes)) throw new Error('fragment_content_conflict')
        if (!prior) { entry.chunks.set(wire.fragmentIndex, bytes); entry.size += bytes.length }
        if (entry.size > entry.bytes) throw new Error('declared_size_exceeded')
        if ([...this.routes.values()].reduce((sum, item) => sum + (item.assembly?.size ?? 0), 0) > ZCODE_LIMITS.staged) throw new Error('staged_budget_exceeded')
        if (entry.chunks.size !== entry.count) return []
        const logical = Buffer.concat(Array.from({ length: entry.count }, (_, index) => entry.chunks.get(index)!))
        if (logical.length !== entry.bytes || zcodeCrc32(logical) !== entry.checksum) throw new Error('checksum_mismatch')
        frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(logical))
        route.assembly = undefined
      } else if (Buffer.byteLength(JSON.stringify(frame) ?? '') > ZCODE_LIMITS.logical) throw new Error('logical_frame_too_large')
      const validated = validateZCodeFrame(frame)
      if (validated.topic !== wire.topic || validated.subscriptionId !== wire.subscriptionId) throw new Error('route_mismatch')
      route.complete = true
      return [{ kind: 'frame', frame: validated, deliveryKind: wire.deliveryKind as ZCodeDeliveryKind,
        logicalFrameId: wire.logicalFrameId, logicalFrameOrdinal: wire.logicalFrameOrdinal }]
    } catch (error) { return [this.fault(route, error instanceof Error ? error.message : 'invalid_wire')] }
  }
}
