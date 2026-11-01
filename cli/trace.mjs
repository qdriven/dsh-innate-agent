#!/usr/bin/env node
// trace: reads the bounded domain-event trace dsh-innate-agent keeps in its SQLite state.
//   trace [--state <orchestrator.sqlite>] [--ticket <id>] [--limit <n>] [--follow]
// The same records the panel could show: every Trigger, Eval, Decision, Ticket, Assignment,
// input delivery and worker report, with its arrival sequence number and timestamp.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const argument = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined
}

const state = argument('state') || join(homedir(), '.dsh', 'state', 'superagent', 'orchestrator.sqlite')
const ticket = argument('ticket')
const limit = Number(argument('limit') ?? 50)
const follow = process.argv.includes('--follow')

if (!existsSync(state)) {
  process.stderr.write(`no state database at ${state} (pass --state <orchestrator.sqlite>)\n`)
  process.exit(1)
}

const read = () => {
  const db = new DatabaseSync(state, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key='trace:events'").get()
    return row ? JSON.parse(row.value) : []
  } finally { db.close() }
}

const short = id => String(id ?? '').slice(0, 8)
const render = entry => {
  const { seq, at, type, data } = entry
  const time = at.slice(11, 19)
  if (type === 'worker.todos') {
    const counts = { pending: 0, 'in_progress': 0, completed: 0 }
    for (const todo of data.todos) counts[todo.status] = (counts[todo.status] ?? 0) + 1
    const current = data.todos.filter(todo => todo.status === 'in_progress').map(todo => todo.content).join(' | ')
    return `${String(seq).padStart(5)}  ${time}  ${type.padEnd(20)} ticket=${short(data.ticketId)} [${counts.completed}✓ ${counts['in_progress']}▶ ${counts.pending}○]${current ? ' ' + current.slice(0, 90) : ''}`
  }
  if (type === 'worker.tool') {
    return `${String(seq).padStart(5)}  ${time}  ${type.padEnd(20)} ticket=${short(data.ticketId)} ${data.name} (turn ${data.turn} step ${data.step})`
  }
  const parts = { ticket: 'ticketId' in data ? short(data.ticketId) : '', assignment: 'assignmentId' in data ? short(data.assignmentId) : '',
    trigger: 'triggerId' in data ? short(data.triggerId) : '', kind: 'kind' in data ? data.kind : '', state: 'state' in data ? data.state : '' }
  const extra = Object.entries(parts).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join(' ')
  const summary = 'summary' in data ? ` ${String(data.summary).slice(0, 80)}` : ''
  return `${String(seq).padStart(5)}  ${time}  ${type.padEnd(20)} ${extra}${summary}`
}

let printed = 0
const show = () => {
  const events = read().filter(entry => !ticket || ('ticketId' in entry.data && entry.data.ticketId === ticket))
  for (const entry of events.slice(printed)) process.stdout.write(`${render(entry)}\n`)
  printed = events.length
}
show()
if (follow) {
  process.stdout.write('… following; Ctrl-C to stop\n')
  setInterval(show, 2000)
}
