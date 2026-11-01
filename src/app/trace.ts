/** Bounded append-only trace of the Engine's domain events and worker Session activity, kept in KV for experiment observability. */
import type { DomainEvent } from '../core/ports.ts'
import type { Store } from './store.ts'
import { KV, type TraceEntry } from '../kv.ts'

/** How many events the trace keeps; the oldest leave first. */
export const TRACE_LIMIT = 2000

/** A worker Session activity the trace records besides domain events: todo snapshots and tool calls. */
export type SessionActivity =
  | { type: 'worker.todos'; at: string; data: { sessionId: string; ticketId: string; todos: { content: string; status: string }[] } }
  | { type: 'worker.tool'; at: string; data: { sessionId: string; ticketId: string; name: string; turn: number; step: number } }
export type TraceEvent = DomainEvent | SessionActivity

/**
 * Records every domain event and traced Session activity with its arrival sequence number into `KV.trace.events`, keeping
 * the newest `TRACE_LIMIT`. `Runtime` feeds it the Engine's events and `Sessions` the workers' todo and tool activity;
 * nothing else writes it.
 */
export class Trace {
  private seq: number
  constructor(private readonly store: Pick<Store, 'get' | 'set'>) {
    this.seq = store.get(KV.trace.seq) ?? 0
  }
  record(event: TraceEvent): void {
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
