import type { ConnectionPhase } from './types'

const TRANSITIONS: Readonly<Record<ConnectionPhase, readonly ConnectionPhase[]>> = {
  idle: ['preflight', 'recovering'],
  preflight: ['creating-session', 'handshaking', 'failed', 'disconnecting'],
  'creating-session': ['handshaking', 'failed', 'disconnecting'],
  handshaking: ['preparing-config', 'failed', 'disconnecting'],
  'preparing-config': ['starting-runtime', 'failed', 'disconnecting'],
  'starting-runtime': ['connected', 'failed', 'disconnecting'],
  connected: ['disconnecting', 'recovering', 'failed'],
  disconnecting: ['idle', 'failed'],
  failed: ['disconnecting', 'recovering', 'idle'],
  recovering: ['preflight', 'starting-runtime', 'disconnecting', 'failed', 'idle']
}

export class ConnectionLifecycle {
  private phaseValue: ConnectionPhase = 'idle'
  private operationIdValue = 0

  get phase(): ConnectionPhase {
    return this.phaseValue
  }

  get operationId(): number {
    return this.operationIdValue
  }

  begin(): number {
    if (this.phaseValue !== 'idle') {
      throw new Error(`Cannot begin a connection while phase is "${this.phaseValue}"`)
    }
    this.operationIdValue += 1
    this.phaseValue = 'preflight'
    return this.operationIdValue
  }

  transition(next: ConnectionPhase, operationId = this.operationIdValue): void {
    this.assertCurrent(operationId)
    if (!TRANSITIONS[this.phaseValue].includes(next)) {
      throw new Error(`Invalid connection transition: ${this.phaseValue} -> ${next}`)
    }
    this.phaseValue = next
  }

  fail(operationId = this.operationIdValue): void {
    if (this.phaseValue === 'failed') return
    this.transition('failed', operationId)
  }

  reset(operationId = this.operationIdValue): void {
    this.assertCurrent(operationId)
    if (this.phaseValue === 'idle') return
    if (this.phaseValue !== 'failed' && this.phaseValue !== 'disconnecting' && this.phaseValue !== 'recovering') {
      throw new Error(`Cannot reset a connection while phase is "${this.phaseValue}"`)
    }
    this.phaseValue = 'idle'
  }

  isCurrent(operationId: number): boolean {
    return operationId === this.operationIdValue
  }

  assertCurrent(operationId: number): void {
    if (!this.isCurrent(operationId)) {
      throw new Error(`Stale connection operation: ${operationId}`)
    }
  }
}
