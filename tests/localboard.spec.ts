/** The localboard Source: translation, a poll round with its cursor, the Channel, the Thread context, the plugin entry, and the Policy part. */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { apply, localboardTrigger, pollQueue, sendLocalboard, localboardKind, SOURCE } from '../src/sources/localboard.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, CliError, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testLocalDeployment } from './fixtures/deployment.ts'
import { KV } from '../src/kv.ts'
import type { OutboundMessage } from '../src/core/index.ts'

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'localboard-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { localboard: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
    sources: { localboard: { enabled: true, config: { cli: 'hookq', conversations: [{ id: 'ops', listen: 'mentions' }, { id: 'lab', listen: 'all' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(localboardKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => testLocalDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testLocalDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, localboardKind) }
}

/** A queue message as `hookq pull` and `hookq thread` print it. */
const message = (id: string, fields: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id, conversation: 'ops', sender: { id: 'alice', bot: false }, mentions_me: false, text: `message ${id}`,
  at: `2026-11-01T00:00:${id.replace(/\D/g, '').padStart(2, '0') || '00'}Z`, ...fields })

/** Answers `hookq` calls with `answer()`; also spies `withSignal`, which normally returns a new Commands. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer() as never))
}

describe('localboard source', () => {
  it('translates a message into a Trigger with a stable id, its Thread and actor, and drops the agent\'s own', () => {
    const trigger = localboardTrigger(message('m1', { mentions_me: true }) as never, 'agent')!
    expect(trigger).toMatchObject({ id: key(SOURCE, 'ops', 'm1'), source: SOURCE,
      threads: [{ source: SOURCE, id: 'ops:m1' }], actor: { source: SOURCE, id: 'alice' }, human: true, addressed: 'mention' })
    expect(trigger.channel).toMatchObject({ source: SOURCE, address: { conversation: 'ops', message: 'm1' } })
    expect(localboardTrigger(message('m2', { thread: 'm1' }) as never, 'agent')!.threads[0]).toEqual({ source: SOURCE, id: 'ops:m1' })
    expect(localboardTrigger(message('m3', { sender: { id: 'agent', bot: true } }) as never, 'agent')).toBeUndefined()
  })

  it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
    const h = host()
    let n = 0
    queue(h, () => ({ me: 'agent', items: [message('m1', { mentions_me: true }), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: ++n }))
    expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(h.store.get(KV.localboard.cursor)).toBe(1)
    // An allowed sender who mentions the agent makes an explicit request.
    expect(h.engine.candidate(key(SOURCE, 'ops', 'm1'))?.strength).toBe('explicit')
    await pollQueue(h.ctx, new AbortController().signal)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    h.store.close()
  })

  it('keeps its cursor when a round is cut short', async () => {
    const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1', { mentions_me: true })], next: 1 }))
    const stopped = new AbortController(); stopped.abort()
    await expect(pollQueue(h.ctx, stopped.signal)).rejects.toThrow('stopped during the read')
    expect(h.store.get(KV.localboard.cursor)).toBeUndefined()
    h.store.close()
  })

  it('answers sent, gone only for a 410, and rethrows other failures, using the configured CLI path', async () => {
    const h = host()
    const reply: OutboundMessage = { id: 'r1', channel: { source: SOURCE, thread: `${SOURCE}:ops:m1`,
      address: { conversation: 'ops', message: 'm1' } }, text: 'done', kind: 'reply' }
    const runs: string[] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async program => { runs.push(program); return '{}' })
    const sender = { commands: h.commands, config: { cli: '/opt/hookq', conversations: [], pollSeconds: 30 } as never }
    expect(await sendLocalboard(sender, reply)).toBe('sent')
    expect(runs).toEqual(['/opt/hookq'])
    vi.spyOn(h.commands, 'run').mockRejectedValue(commandError({ stderr: JSON.stringify({ error: { code: 410, message: 'gone' } }), code: 1 }))
    expect(await sendLocalboard(sender, reply)).toBe('gone')
    vi.spyOn(h.commands, 'run').mockRejectedValue(commandError({ stderr: 'hookq could not run: ENOENT', code: 1 }))
    await expect(sendLocalboard(sender, reply)).rejects.toBeInstanceOf(CliError)
    h.store.close()
  })

  it('reads a Thread page and names the next cursor', async () => {
    const h = host()
    queue(h, () => ({ items: [message('m1'), message('m2', { thread: 'm1' })], next: '2026-11-01T00:00:02Z' }))
    const trigger = localboardTrigger(message('m2', { thread: 'm1' }) as never, 'agent')!
    const context = localboardKind.threadContext!
    expect(context.messageId(trigger)).toBe('m2')
    const page = await context.read(h.commands, trigger, 'thread', undefined, {} as never)
    expect(page.messages).toEqual([{ id: 'm1', from: 'alice', at: '2026-11-01T00:00:01Z', text: 'message m1' },
      { id: 'm2', from: 'alice', at: '2026-11-01T00:00:02Z', text: 'message m2' }])
    expect(page.next).toBe('2026-11-01T00:00:02Z')
    h.store.close()
  })

  it('registers its kind through the plugin entry and reports setupPending while setup waits', async () => {
    const board = new HealthBoard()
    const fresh = host({ configured: () => false, sources: new SourceRegistry(() => ({}) as never, board) })
    const value = { ...fresh, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(fresh, kind) }
    const disposers: (() => unknown)[] = []
    apply({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.localboard).toMatchObject({ state: 'paused', code: 'setupPending' }))
    expect(fresh.sources.kind(SOURCE)).toBe(localboardKind)
    for (const dispose of disposers) await dispose()
    expect(fresh.sources.kind(SOURCE)).toBeUndefined()
    fresh.store.close()
  })

  it('declares the admission rows of its conversations and its execution environment variable', () => {
    expect(localboardKind.policy!.rows!({ conversations: [{ id: 'ops', listen: 'mentions' }, { id: 'lab', listen: 'all' }] })).toEqual([
      { id: 'ops', label: 'ops', note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'lab', label: 'lab', note: { zh: '全部消息', en: 'All' }, cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
    ])
    const trigger = localboardTrigger(message('m1', { mentions_me: true }) as never, 'agent')!
    expect(localboardKind.environment!.values({ deployment: testLocalDeployment(), config: {} as never, trigger }))
      .toEqual({ DSH_SUPERAGENT_LOCALBOARD_CONVERSATION: 'ops' })
    expect(localboardKind.environment!.values({ deployment: testLocalDeployment(), config: {} as never }))
      .toEqual({ DSH_SUPERAGENT_LOCALBOARD_CONVERSATION: '' })
  })
})
