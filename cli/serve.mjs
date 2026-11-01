#!/usr/bin/env node
// hookq serve: a one-page web demo for the dsh-innate-agent loop.
// Serves a step-by-step UI at / and a tiny JSON API over the same board the Source polls:
//   GET  /api/board                      the conversation's messages
//   POST /api/board {sender,text,mention} post a message to the board
//   GET  /api/health                     the orchestrator's /state health, proxied read-only
//   GET  /api/trace?limit=n              the domain-event trace, read from the SQLite state
// Usage: hookq serve [--port 4080] [--conversation ops] [--state <orchestrator.sqlite>] [--api http://127.0.0.1:3082]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argument = name => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined
}

const PORT = Number(argument('port') ?? 4080)
const CONVERSATION = argument('conversation') ?? 'ops'
const BOARD_HOME = process.env.LOCALBOARD_HOME || join(homedir(), '.localboard')
const BOARD_FILE = join(BOARD_HOME, 'conversations', `${CONVERSATION}.json`)
const STATE = argument('state') || join(homedir(), '.dsh', 'state', 'superagent', 'orchestrator.sqlite')
const API = argument('api') || 'http://127.0.0.1:3082'

const board = () => existsSync(BOARD_FILE) ? JSON.parse(readFileSync(BOARD_FILE, 'utf8')) : { messages: [] }

const readTrace = limit => {
  if (!existsSync(STATE)) return { error: `no state database at ${STATE}` }
  const sqlite = require('node:sqlite')
  const db = new sqlite.DatabaseSync(STATE, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key='trace:events'").get()
    const events = row ? JSON.parse(row.value) : []
    return events.slice(-limit).reverse()
  } finally { db.close() }
}
// createRequire for a self-contained ESM file
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
const readBody = req => new Promise(resolve => {
  let body = ''
  req.on('data', chunk => { body += chunk; if (body.length > 1 << 16) req.destroy() })
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/' ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/api/board' && req.method === 'GET') return json(res, 200, { conversation: CONVERSATION, messages: board().messages })
  if (url.pathname === '/api/board' && req.method === 'POST') {
    const { sender, text, mention } = await readBody(req)
    if (!sender || !text) return json(res, 400, { error: 'sender and text are required' })
    const { spawn } = await import('node:child_process')
    const argv = [new URL(import.meta.url).pathname.replace(/\/[^/]*$/, '/hookq.mjs'), 'post', '--conversation', CONVERSATION,
      '--sender', String(sender).slice(0, 40), ...(mention ? ['--mention'] : []), '--text', String(text).slice(0, 2000)]
    const child = spawn(process.execPath, argv, { env: { ...process.env, LOCALBOARD_HOME: BOARD_HOME } })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => code === 0 ? json(res, 200, { posted: true }) : json(res, 500, { error: stderr || `exit ${code}` }))
    return
  }
  if (url.pathname === '/api/health') {
    try {
      const answer = await fetch(`${API}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(3000) })
      const value = await answer.json()
      return json(res, 200, { reachable: true, health: value.health, load: value.load, paused: value.paused })
    } catch (error) {
      return json(res, 200, { reachable: false, error: String(error).slice(0, 120) })
    }
  }
  if (url.pathname === '/api/trace') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 40), 300)
    return json(res, 200, readTrace(limit))
  }
  res.writeHead(404); res.end('not found')
})
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`hookq demo UI: http://127.0.0.1:${PORT}/ (board=${CONVERSATION})\n`))

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-innate-agent 演示</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; margin: 0; background: #0f1117; color: #e6e8ee; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 20px; } h1 small { color: #8b93a7; font-weight: normal; margin-left: 8px; }
  .steps { display: grid; gap: 14px; }
  .step { border: 1px solid #262b3a; border-radius: 10px; padding: 14px 16px; background: #151824; }
  .step h2 { font-size: 15px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .num { display: inline-flex; width: 22px; height: 22px; border-radius: 50%; background: #2b3450; align-items: center; justify-content: center; font-size: 12px; }
  .hint { color: #8b93a7; font-size: 12.5px; line-height: 1.6; margin: 6px 0; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  input[type=text] { flex: 1; min-width: 200px; background: #0f1117; color: #e6e8ee; border: 1px solid #2b3450; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
  button { background: #3b5bfd; color: white; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #262b3a; }
  button:disabled { opacity: .5; cursor: default; }
  pre { background: #0a0c12; border: 1px solid #232737; border-radius: 8px; padding: 10px; font-size: 12px; overflow: auto; max-height: 340px; margin: 8px 0 0; line-height: 1.55; }
  .chat { display: grid; gap: 8px; margin-top: 8px; }
  .msg { border: 1px solid #232737; border-radius: 10px; padding: 8px 12px; background: #0f1420; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }
  .msg .meta { color: #8b93a7; font-size: 11.5px; margin-bottom: 3px; }
  .msg.agent { border-color: #2d3d2f; background: #101a12; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; border: 1px solid #2b3450; color: #8b93a7; }
  .badge.ok { color: #67c23a; border-color: #2d5a2d; }
  .badge.bad { color: #f56c6c; border-color: #6b2d2d; }
  .okline { color: #67c23a; font-size: 12.5px; }
  .errline { color: #f56c6c; font-size: 12.5px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>dsh-innate-agent 本地演示 <small>无 GitHub · localboard · magpie 模型</small></h1>

  <div class="steps">
    <section class="step">
      <h2><span class="num">1</span> 服务健康 <span class="badge" id="h-badge">…</span></h2>
      <p class="hint">检查 orchestrator 是否在运行、各组件状态。全 ready（或 github=paused）即可进入下一步。</p>
      <div class="row"><button class="secondary" onclick="loadHealth()">刷新</button></div>
      <pre id="health">（点“刷新”检查）</pre>
    </section>

    <section class="step">
      <h2><span class="num">2</span> 发起请求 <span class="badge" id="p-badge">未发送</span></h2>
      <p class="hint">以 allowed 用户（patrick）在看板上 @agent 发一个修复请求。也可以改文字试试别的任务。</p>
      <div class="row">
        <input type="text" id="sender" value="patrick" style="max-width:110px" title="发送者">
        <input type="text" id="text" value="把 README.md 的标题改成 Welcome to Widget Demo">
        <label class="hint" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="mention" checked> @agent</label>
        <button onclick="post()">发送到看板</button>
      </div>
      <p class="hint" id="post-result"></p>
    </section>

    <section class="step">
      <h2><span class="num">3</span> 执行轨迹（trace） <span class="badge" id="t-badge">自动刷新</span></h2>
      <p class="hint">触发到达 → 评估接单 → 工单创建 → worker 工具调用 → ready 报告 → 工单结束。每 3 秒自动刷新。</p>
      <pre id="trace">（等待数据…）</pre>
    </section>

    <section class="step">
      <h2><span class="num">4</span> 看板对话 <span class="badge" id="b-badge">自动刷新</span></h2>
      <p class="hint">agent 的确认（“收到…”）和最终交付（“已改好…”）都会回到原对话。</p>
      <div class="chat" id="board"></div>
    </section>

    <section class="step">
      <h2><span class="num">5</span> 交付物 <span class="badge">worktree 分支</span></h2>
      <p class="hint">无 GitHub 部署没有 PR；改动提交在工单自己的 worktree 分支（agent/&lt;名字&gt;）。上方 trace 的 worker.reported 里会写明分支与 commit。</p>
    </section>
  </div>
</div>
<script>
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))

async function loadHealth() {
  const badge = $('h-badge'); badge.textContent = '…'; badge.className = 'badge'
  try {
    const r = await fetch('/api/health'); const d = await r.json()
    if (!d.reachable) { badge.textContent = '服务未运行'; badge.className = 'badge bad'
      $('health').textContent = "连不上 orchestrator（127.0.0.1:3082）。\\n先启动：\\n  cd …/dsh-innate-agent && export $(grep -v '^#' ~/.dsh/.env | xargs) && ./scripts/dsh-superagent-local start"; return }
    const entries = Object.entries(d.health ?? {})
    const bad = entries.filter(([,v]) => v.state === 'error')
    badge.textContent = bad.length ? \`\${bad.length} 个组件异常\` : '全部正常'
    badge.className = bad.length ? 'badge bad' : 'badge ok'
    $('health').textContent = entries.map(([k,v]) => \`\${k.padEnd(12)} \${v.state}\${v.detail ? '  · ' + v.detail.slice(0,80) : ''}\`).join('\\n')
      + '\\n\\nload: ' + JSON.stringify(d.load ?? {}) + '  paused: ' + d.paused
  } catch (e) { badge.textContent = '检查失败'; badge.className = 'badge bad'; $('health').textContent = String(e) }
}

async function post() {
  const btn = event.target; btn.disabled = true
  const badge = $('p-badge'); badge.textContent = '发送中…'
  try {
    const body = { sender: $('sender').value.trim(), text: $('text').value.trim(), mention: $('mention').checked }
    const r = await fetch('/api/board', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) })
    const d = await r.json()
    if (d.posted) { badge.textContent = '已发送 ✓'; badge.className = 'badge ok'; $('post-result').textContent = '消息已上看板，看第 3 步的 trace 跟进。' }
    else { badge.textContent = '失败'; badge.className = 'badge bad'; $('post-result').textContent = d.error ?? String(d) }
  } catch (e) { badge.textContent = '失败'; badge.className = 'badge bad'; $('post-result').textContent = String(e) }
  btn.disabled = false
}

const render = entry => {
  const t = (entry.at ?? '').slice(11,19)
  if (entry.type === 'worker.todos') {
    const todos = entry.data.todos ?? []
    const counts = { completed: 0, 'in_progress': 0, pending: 0 }
    for (const x of todos) counts[x.status] = (counts[x.status] ?? 0) + 1
    const now = todos.filter(x => x.status === 'in_progress').map(x => x.content).join(' | ')
    return \`\${t}  worker.todos        [\${counts.completed}✓ \${counts['in_progress']}▶ \${counts.pending}○]\${now ? ' ' + now.slice(0,90) : ''}\`
  }
  if (entry.type === 'worker.tool')
    return \`\${t}  worker.tool         \${entry.data.name} (turn \${entry.data.turn} step \${entry.data.step})\`
  const d = entry.data ?? {}
  const bits = []
  for (const k of ['ticketId','assignmentId','triggerId','kind','state'])
    if (d[k] !== undefined) bits.push(k + '=' + String(d[k]).slice(0,8))
  if (d.summary) bits.push(String(d.summary).slice(0,80))
  return \`\${t}  \${(entry.type || '').padEnd(19)} \${bits.join(' ')}\`
}

async function loadTrace() {
  try {
    const r = await fetch('/api/trace?limit=60'); const events = await r.json()
    if (Array.isArray(events)) {
      $('trace').textContent = events.map(render).join('\\n') || '（暂无事件——发一个请求试试）'
      const last = events[0]
      $('t-badge').textContent = last ? \`\${events.length} 条 · 最新: \${last.type}\` : '空'
    } else $('trace').textContent = events.error ?? String(events)
  } catch (e) { $('trace').textContent = String(e) }
}

async function loadBoard() {
  try {
    const r = await fetch('/api/board'); const d = await r.json()
    const box = $('board'); box.innerHTML = ''
    for (const m of (d.messages ?? []).slice(-30)) {
      const div = document.createElement('div')
      div.className = 'msg' + (m.sender?.bot ? ' agent' : '')
      const who = m.sender?.bot ? '🤖 agent' : '👤 ' + (m.sender?.id ?? '?')
      div.innerHTML = \`<div class="meta">\${who} · \${(m.at ?? '').slice(11,19)} · \${m.id}\${m.mentions_me ? ' · @agent' : ''}</div>\${esc(m.text)}\`
      box.appendChild(div)
    }
    $('b-badge').textContent = \`\${(d.messages ?? []).length} 条\`
  } catch (e) { $('board').innerHTML = '<p class="errline">' + esc(String(e)) + '</p>' }
}

loadHealth(); loadTrace(); loadBoard()
setInterval(loadTrace, 3000); setInterval(loadBoard, 3000)
</script>
</body>
</html>`
