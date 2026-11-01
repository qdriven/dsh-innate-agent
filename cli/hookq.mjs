#!/usr/bin/env node
// localboard: a single-file local issue-board service that stands in for a forge.
// The localboard Source of dsh-innate-agent polls it with the hookq CLI contract:
//   hookq pull --after <n> --json        messages after position n, oldest first
//   hookq reply --conversation <id> --to <message id> --key <key> --text <text>
//   hookq thread --conversation <id> --root <message id> --json [--after <cursor>]
// Plus human commands for the experiment:
//   hookq post --conversation <id> --sender <user> [--mention] --text <text>
//   hookq comment --on <message id> --sender <user> [--mention] --text <text>
//   hookq list [--conversation <id>]
// Storage: one JSON file per conversation under $LOCALBOARD_HOME (default ~/.localboard).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.LOCALBOARD_HOME || join(homedir(), '.localboard')
const AGENT = process.env.LOCALBOARD_AGENT || 'agent'
const DIR = join(HOME, 'conversations')

class Gone extends Error {
  constructor(message) { super(message); this.code = 410 }
}

const conversationPath = id => join(DIR, `${id}.json`)
const boards = () => readdirSync(DIR).map(name => JSON.parse(readFileSync(join(DIR, name), 'utf8')))
const load = id => {
  if (!existsSync(conversationPath(id))) throw new Gone(`conversation ${id} is gone`)
  return JSON.parse(readFileSync(conversationPath(id), 'utf8'))
}
const store = board => { mkdirSync(DIR, { recursive: true }); writeFileSync(conversationPath(board.id), JSON.stringify(board, null, 2) + '\n') }

function post(board, sender, text, { mention = false, replyTo = null } = {}) {
  const id = `m${String(board.nextId++).padStart(4, '0')}`
  const message = { id, conversation: board.id, seq: board.seq++,
    sender: { id: sender, bot: sender === AGENT || sender.endsWith('[bot]') || sender.endsWith('-bot') },
    mentions_me: mention, text, at: new Date().toISOString(), ...(replyTo ? { thread: replyTo } : {}) }
  board.messages.push(message)
  return message
}

const argument = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined
}
const flag = name => process.argv.includes(`--${name}`)

function fail(error) {
  if (error instanceof Gone) process.stderr.write(`${JSON.stringify({ error: { code: 410, message: error.message } })}\n`)
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

try {
  mkdirSync(DIR, { recursive: true })
  const [command] = process.argv.slice(2)
  if (!command || command === 'help') {
    process.stdout.write('usage: hookq <pull|reply|thread|post|comment|list> [options]\n')
  } else if (command === 'pull') {
    const after = Number(argument('after') ?? 0)
    const all = boards().flatMap(board => board.messages).sort((a, b) => a.seq - b.seq)
    const items = all.filter(item => item.seq > after)
    process.stdout.write(`${JSON.stringify({ me: AGENT, items, next: items.length ? items.at(-1).seq : after })}\n`)
  } else if (command === 'reply') {
    const [conversation, to, key, text] = ['conversation', 'to', 'key', 'text'].map(argument)
    if (!conversation || !to || !key || text === undefined) throw new Error('reply needs --conversation --to --key --text')
    const board = load(conversation)
    if (board.replies[key]) { process.stdout.write('{"ok":true,"deduplicated":true}\n'); process.exit(0) }
    if (!board.messages.some(item => item.id === to)) throw new Gone(`message ${to} is gone`)
    const message = post(board, AGENT, text, { replyTo: to })
    board.replies[key] = message.id
    store(board)
    process.stdout.write('{"ok":true}\n')
  } else if (command === 'thread') {
    const [conversation, root] = ['conversation', 'root'].map(argument)
    if (!conversation || !root) throw new Error('thread needs --conversation --root')
    const board = load(conversation)
    const after = argument('after')
    const thread = board.messages.filter(item => item.id === root || item.thread === root)
    const page = thread.filter(item => !after || item.at > after).slice(0, 50)
    const last = page.at(-1)?.at ?? ''
    process.stdout.write(`${JSON.stringify({ items: page, ...(thread.some(item => item.at > last && item.id !== page.at(-1)?.id) ? { next: last } : {}) })}\n`)
  } else if (command === 'post') {
    const [conversation, sender, text] = ['conversation', 'sender', 'text'].map(argument)
    if (!conversation || !sender || text === undefined) throw new Error('post needs --conversation --sender --text')
    if (sender === AGENT) throw new Error('the agent does not post')
    let board
    try { board = load(conversation) } catch (error) {
      if (!(error instanceof Gone)) throw error
      board = { id: conversation, agent: AGENT, nextId: 1, seq: 1, replies: {}, messages: [] }
    }
    const message = post(board, sender, text, { mention: flag('mention') })
    store(board)
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } else if (command === 'comment') {
    const [on, sender, text] = ['on', 'sender', 'text'].map(argument)
    if (!on || !sender || text === undefined) throw new Error('comment needs --on --sender --text')
    if (sender === AGENT) throw new Error('the agent does not comment')
    const board = boards().find(candidate => candidate.messages.some(item => item.id === on))
    if (!board) throw new Gone(`message ${on} is gone`)
    const message = post(board, sender, text, { mention: flag('mention'), replyTo: on })
    store(board)
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } else if (command === 'list') {
    const conversation = argument('conversation')
    for (const board of conversation ? [load(conversation)] : boards()) {
      for (const message of board.messages) {
        process.stdout.write(`${board.id}\t${message.id}\t${message.sender.id}${message.mentions_me ? ' @agent' : ''}\t${message.at}\t${message.text.replaceAll('\n', ' ⏎ ')}\n`)
      }
    }
  } else {
    throw new Error(`unknown command: ${command}`)
  }
} catch (error) { fail(error) }
