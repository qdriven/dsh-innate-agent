/** Localboard source kind: polls a local issue-board through the hookq CLI (`cli/hookq.mjs`), following docs/008-cookbook.md. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'localboard'

/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })

const ConfigSchema = z.object({
  cli: z.string().trim().min(1).default(''),
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type LocalboardConfig = z.infer<typeof ConfigSchema>

/** The Thread of one queue message: its conversation and the id of the message that started it. */
const localThread = (message: QueueMessage): string => `${message.conversation}:${message.thread ?? message.id}`

/**
 * The Trigger of one queue message; the agent's own messages produce none.
 * The id derives from the conversation and message id, so a re-read after an interrupted round deduplicates.
 */
export function localboardTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me || message.sender.bot && message.sender.id === me) return undefined
  const thread = localThread(message)
  return {
    id: key(SOURCE, message.conversation, message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { conversation: message.conversation, message: message.id } },
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}

/** Replies under a message once per idempotency key; a deleted conversation answers 410, which is `gone`. */
export async function sendLocalboard(host: { commands: SourceContext['commands']; config?: LocalboardConfig }, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing localboard reply target')
  // The host process may not find the CLI by name on its PATH; run the configured path when there is one.
  const cli = host.config?.cli || 'hookq'
  try {
    await host.commands.run(cli, ['reply', '--conversation', conversation, '--to', to, '--key', message.id, '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}

/** Reads the queue after the cursor, takes in each message, then moves the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal, cli = 'hookq'): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.localboard.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run(cli, ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The localboard Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = localboardTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '看板', en: 'Board' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label: `${message.data.conversation}/${trigger.meta.root}`, facts: { conversation } })
  }
  ctx.state.set(KV.localboard.cursor, page.next)
  return { read: page.items.length, unreadable }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-innate-agent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<LocalboardConfig>(SOURCE)
    if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      const cli = config.cli || 'hookq'
      try {
        const { read, unreadable } = await pollQueue(ctx, signal, cli)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One failed CLI run is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const localboardKind: SourceKind<LocalboardConfig> = {
  kind: SOURCE,
  title: { zh: '本地看板', en: 'Local board' },
  description: { zh: '接收本地看板（hookq CLI）里下列对话的消息；无需 GitHub 即可实验完整的接单-执行-回复回路。',
    en: 'Receives the messages of these conversations from a local issue-board (the hookq CLI); an experiment loop without GitHub.' },
  schema: ConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'hookq CLI', en: 'hookq CLI' },
      hint: { zh: '命令名或绝对路径，通常指向 cli/hookq.mjs 的包装脚本。本地看板的存储在 $LOCALBOARD_HOME。', en: 'A command name or absolute path, usually a wrapper around cli/hookq.mjs. The board stores its data under $LOCALBOARD_HOME.' } },
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [SOURCE],
  // What the Source observes in a conversation it receives in full; elsewhere, only what addresses the agent.
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendLocalboard,
    link: address => ({ url: '', label: { zh: `本地看板 ${address.conversation}`, en: `Local board ${address.conversation}` } }),
  },
  // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
  // Who may ask: the senders named on the Source's part of the Policy.
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_LOCALBOARD_CONVERSATION', description: {
      zh: '接下工单的看板对话；工单不是从本地看板来的时为空',
      en: 'The localboard conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_LOCALBOARD_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
  },
}

export const name = 'dsh-innate-localboard'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(localboardKind), 'localboard: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, localboardKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) } as Health) })
    return async () => { controller.abort(); await running }
  })
}
