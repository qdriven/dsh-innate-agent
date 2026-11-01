/** Bounded append-only trace of the Engine's domain events, kept in KV for experiment observability. */
import type { DomainEvent } from '../core/ports.ts'
import type { Store } from './store.ts'
import { KV, type TraceEntry } from '../kv.ts'

/** How many events the trace keeps; the oldest leave first. */
export const TRACE_LIMIT = 2000

/**
 * Records every domain event with its arrival sequence number into `KV.trace.events`, keeping the newest `TRACE_LIMIT`.
 * `Runtime` feeds it the same events its `emit` hook receives; nothing else writes it.
 */
export class Trace {
  private seq: number
  constructor(private readonly store: Pick<Store, 'get' | 'set'>) {
    this.seq = store.get(KV.trace.seq) ?? 0
  }
  record(event: DomainEvent): void {
    const entry: TraceEntry = { seq: ++this.seq, ...event }
    const events = [...this.store.get(KV.trace.events) ?? [], entry].slice(-TRACE_LIMIT)
    this.store.set(KV.trace.seq, this.seq)
    this.store.set(KV.trace.events, events)
  }
  /** The newest entries first, optionally filtered by ticket id. */
  read(ticketId?: string, limit = 100): TraceEntry[] {
    const events = this.store.get(KV.trace.events) ?? []
    const ofTicket = ticketId ? events.filter(entry => 'ticketId' in entry.data && entry.data.ticketId === ticketId) : events
    return ofTicket.slice(-limit).reverse()
  }
}
