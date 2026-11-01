/** The bounded event trace: every domain event lands with a sequence number, the oldest leave first, and the filter reads one ticket's. */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Store } from '../src/app/store.ts'
import { Trace, TRACE_LIMIT } from '../src/app/trace.ts'
import { KV } from '../src/kv.ts'
import type { DomainEvent } from '../src/core/ports.ts'

const event = (type: DomainEvent['type'], data: DomainEvent['data'], at = '2026-11-01T00:00:00Z'): DomainEvent =>
  ({ type, at, data } as DomainEvent)

describe('trace', () => {
  it('records every event with an arrival sequence number, continuing across Trace instances', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'trace-')), 'db.sqlite'))
    const trace = new Trace(store)
    trace.record(event('trigger.received', { triggerId: 't1', threads: ['localboard:ops:m1'] }))
    trace.record(event('eval.started', { evalId: 'e1', threadKey: 'localboard:ops:m1', triggerIds: ['t1'], strength: 'explicit' }))
    expect(store.get(KV.trace.seq)).toBe(2)
    // A restart's Trace continues the sequence from the stored counter.
    const reopened = new Trace(store)
    reopened.record(event('decision.recorded', { decisionId: 'd1', kind: 'accept', threadKey: 'localboard:ops:m1' }))
    const read = new Trace(store).read()
    expect(read.map(entry => [entry.seq, entry.type])).toEqual([[3, 'decision.recorded'], [2, 'eval.started'], [1, 'trigger.received']])
    store.close()
  })
  it('keeps only the newest entries and filters by ticket', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'trace-')), 'db.sqlite'))
    const trace = new Trace(store)
    for (let index = 0; index < TRACE_LIMIT + 50; index++) {
      trace.record(event('ticket.created', { ticketId: `ticket-${index % 2}`, decisionId: 'd', strength: 'explicit' }))
    }
    const all = new Trace(store).read(undefined, TRACE_LIMIT)
    expect(all).toHaveLength(TRACE_LIMIT)
    // Newest first: the oldest kept entry dropped the first fifty.
    expect(all[0]!.seq).toBe(TRACE_LIMIT + 50)
    expect(all.at(-1)!.seq).toBe(51)
    const ofTicket = new Trace(store).read('ticket-1', 5)
    expect(ofTicket.every(entry => 'ticketId' in entry.data && entry.data.ticketId === 'ticket-1')).toBe(true)
    expect(ofTicket).toHaveLength(5)
    store.close()
  })
  it('traces a worker report and input delivery end to end', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'trace-')), 'db.sqlite'))
    const trace = new Trace(store)
    trace.record(event('assignment.started', { ticketId: 't9', assignmentId: 'a1' }))
    trace.record(event('inputs.delivered', { ticketId: 't9', assignmentId: 'a1', inputIds: ['i1'] }))
    trace.record(event('worker.reported', { ticketId: 't9', assignmentId: 'a1', state: 'ready', summary: 'PR ready' }))
    trace.record(event('ticket.ended', { ticketId: 't9', by: 'executor', outcome: 'completed' }))
    expect(new Trace(store).read('t9').map(entry => entry.type))
      .toEqual(['ticket.ended', 'worker.reported', 'inputs.delivered', 'assignment.started'])
    expect(new Trace(store).read('other')).toEqual([])
    store.close()
  })
})
