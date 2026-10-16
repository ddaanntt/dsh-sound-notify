/**
 * dsh-sound-notify — host half.
 *
 * Announces two moments, each with its own sound:
 *
 *   1. `turnEnd`   — a top-level session's agent went idle: the assistant
 *                    finished its turn and is waiting for the next message.
 *   2. `attention` — the agent is blocked on the user: a tool approval request
 *                    (`approval/request`) or a structured question
 *                    (`user-questions/request`, the `ask_user_question` tool).
 *
 * A chime is suppressed when a browser says the user is already there: that
 * window is focused and visible, and the session in question is one of the
 * conversations it is displaying. The browser half (`./client.js`) registers an
 * invisible probe in the session-scoped `conversation.input.dock` slot — so it
 * knows which conversations are on screen — and POSTs to
 * `/sound-notify/presence`.
 *
 * Presence is tracked per browser client (each page generates an id) so two
 * windows cannot overwrite each other, and a report older than `presenceTtlMs`
 * is ignored: a closed, frozen, or minimized-forever tab can never silence
 * notifications permanently. Until any client has reported, every chime fires.
 *
 * Delegated subagent runs are always silent: they are published children
 * (`subagent/start`), not conversations the user is watching, and their
 * approvals are auto-rejected rather than answered by a human.
 *
 * `webServer` is treated as optional rather than injected: a hard injection
 * would leave this row pending in a composition without a webserver, and the
 * boot activation audit fails the whole launch on a pending row. Without a
 * webserver the plugin still chimes — it just cannot see the browser.
 *
 * Config (all optional):
 *   onTurnEnd                       boolean  default true
 *   onUserInputNeeded               boolean  default true
 *   startupChime                    boolean  default false  (true = confirm on every mount)
 *   turnEndSound                    string   default <media>/Windows Notify System Generic.wav
 *   attentionSound                  string   default <media>/chimes.wav
 *   minIntervalMs                   number   default 700      (same-sound anti-flutter window)
 *   suppressTurnEndAfterAttentionMs number   default 5000     (don't double-chime a blocked turn)
 *   presenceTtlMs                   number   default 20000    (a client report older than this is ignored)
 *   debugLog                        string   default ''       (append one line per decision)
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Windows media directory; falls back to the conventional location. */
const MEDIA_DIR = join(process.env.windir ?? process.env.SystemRoot ?? 'C:\\Windows', 'Media')

const DEFAULTS = {
  onTurnEnd: true,
  onUserInputNeeded: true,
  startupChime: false,
  turnEndSound: join(MEDIA_DIR, 'Windows Notify System Generic.wav'),
  attentionSound: join(MEDIA_DIR, 'chimes.wav'),
  minIntervalMs: 700,
  suppressTurnEndAfterAttentionMs: 5000,
  presenceTtlMs: 20000,
  debugLog: '',
}

/** Presence endpoint the browser half posts to. */
const PRESENCE_PATH = '/sound-notify/presence'
/** Refuse an oversized presence body rather than buffering it. */
const MAX_BODY_BYTES = 4096

/** PowerShell single-quoted literal: backslashes are safe, `'` doubles. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Start a detached helper process; never throws into the event dispatch. */
function launch(command, args) {
  try {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Play one audio file through the platform's own player. */
function playFile(file) {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';"
      + `try { (New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync() }`
      + 'catch { [console]::beep(880, 200) }'
    return launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script])
  }
  if (process.platform === 'darwin') return launch('afplay', [file])
  return launch('paplay', [file]) || launch('aplay', ['-q', file])
}

/** Last-resort audible cue when the configured file is missing. */
function playFallbackTone() {
  if (process.platform === 'win32') {
    return launch('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', '[console]::beep(880, 200)',
    ])
  }
  try {
    process.stdout.write('\u0007')
    return true
  } catch {
    return false
  }
}

function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULTS, ...config }
  for (const key of Object.keys(DEFAULTS)) {
    if (merged[key] === undefined || merged[key] === null) merged[key] = DEFAULTS[key]
  }
  return merged
}

/** Read a small JSON request body; resolves to undefined on anything unusable. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/** Normalize one report's session list, accepting both the set and single forms. */
function sessionIdsOf(body) {
  const raw = Array.isArray(body.sessionIds)
    ? body.sessionIds
    : body.sessionId === undefined || body.sessionId === null ? [] : [body.sessionId]
  return raw.filter((id) => id !== undefined && id !== null).map(String)
}

export const name = 'sound-notify'

export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  const logger = (() => {
    try {
      return ctx.get('logger')
    } catch {
      return undefined
    }
  })()

  const log = (message) => {
    const line = `[sound-notify] ${new Date().toISOString()} ${message}`
    if (typeof cfg.debugLog === 'string' && cfg.debugLog) {
      try {
        appendFileSync(cfg.debugLog, `${line}\n`)
      } catch {
        // A logging failure must never break the notification itself.
      }
    }
    try {
      logger?.info?.(line)
    } catch {
      // Same: logging is best-effort.
    }
  }

  /**
   * Latest report per browser client. Keyed by the id each page generates, so
   * two windows cannot overwrite each other. Empty means no page has ever
   * reported — the safe state, where every chime fires.
   */
  const clients = new Map()

  /** Session ids of published subagent children — never announced. */
  const delegated = new Set()
  const lastPlayedAt = { turnEnd: 0, attention: 0 }
  let lastAttentionAt = 0

  const isDelegated = (id) => id !== undefined && id !== null && delegated.has(String(id))

  /** Drop reports older than the TTL and return the ones still live. */
  const liveClients = () => {
    const cutoff = Date.now() - cfg.presenceTtlMs
    const live = []
    for (const [key, value] of clients) {
      if (value.at < cutoff) clients.delete(key)
      else live.push(value)
    }
    return live
  }

  /**
   * True when a live browser report says the user is looking at this session:
   * that window is focused and visible, and it is displaying this conversation.
   */
  const isWatching = (sessionId) => {
    if (sessionId === undefined || sessionId === null) return false
    const target = String(sessionId)
    for (const client of liveClients()) {
      if (!client.visible || !client.focused) continue
      if (client.sessionIds.includes(target)) return true
    }
    return false
  }

  const fire = (kind, file, why, sessionId) => {
    const now = Date.now()
    if (isWatching(sessionId)) {
      log(`skip ${kind} (${why}) — the user is already looking at this session`)
      return
    }
    if (kind === 'turnEnd' && now - lastAttentionAt < cfg.suppressTurnEndAfterAttentionMs) {
      log(`skip turnEnd (${why}) — the user was just asked something`)
      return
    }
    if (now - lastPlayedAt[kind] < cfg.minIntervalMs) {
      log(`skip ${kind} (${why}) — inside the ${cfg.minIntervalMs}ms window`)
      return
    }
    lastPlayedAt[kind] = now
    if (kind === 'attention') lastAttentionAt = now

    const playable = typeof file === 'string' && file.length > 0 && existsSync(file)
    const played = playable ? playFile(file) : playFallbackTone()
    log(`play ${kind} (${why}) via ${playable ? file : 'fallback tone'} ok=${played}`)
  }

  // Presence channel: the browser half is the only writer. The webserver is an
  // optional capability, so this never blocks activation.
  let routeRegistered = false
  const registerRoute = (webServer) => {
    if (routeRegistered || webServer === undefined || webServer === null) return
    routeRegistered = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PRESENCE_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            clients: liveClients().map((client) => ({
              id: client.id,
              ageMs: Date.now() - client.at,
              visible: client.visible,
              focused: client.focused,
              sessionIds: client.sessionIds,
            })),
            reports: [...clients.values()].reduce((total, client) => total + client.reports, 0),
          }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
          return
        }
        const body = await readJsonBody(req)
        if (body !== undefined) {
          const id = body.clientId === undefined || body.clientId === null ? 'anonymous' : String(body.clientId)
          const previous = clients.get(id)
          clients.set(id, {
            id,
            at: Date.now(),
            visible: body.visible === true,
            focused: body.focused === true,
            sessionIds: sessionIdsOf(body),
            reports: (previous === undefined ? 0 : previous.reports) + 1,
          })
        }
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      },
    }), 'sound-notify: presence route')
  }

  try {
    registerRoute(ctx.get('webServer'))
    if (!routeRegistered) {
      // The webserver may still be mounting; take it whenever it appears.
      ctx.on('internal/service', (serviceName, value) => {
        if (serviceName === 'webServer') registerRoute(value)
      })
    }
  } catch (error) {
    log(`presence route unavailable: ${String(error && error.message ? error.message : error)}`)
  }

  // Published subagent children: remembered for the process lifetime, since a
  // child's final idle transition may be dispatched after `subagent/end`.
  ctx.on('subagent/start', (info) => {
    try {
      const id = info && info.id
      if (id !== undefined && id !== null) delegated.add(String(id))
    } catch {
      // Live runtime payload: read the one leaf field we need, never inspect it.
    }
  })

  // 1. A top-level session finished its turn and is waiting for the user.
  ctx.on('agent/status', (payload) => {
    if (!cfg.onTurnEnd) return
    try {
      if (!payload || payload.status !== 'idle') return
      const id = payload.agent && payload.agent.id
      if (isDelegated(id)) {
        log(`skip turnEnd — ${String(id)} is a delegated subagent`)
        return
      }
      fire('turnEnd', cfg.turnEndSound, `agent ${String(id)} went idle`, id)
    } catch (error) {
      log(`turnEnd listener failed: ${String(error && error.message ? error.message : error)}`)
    }
  })

  // 2a. A tool call needs an approval decision. Waterfall: always delegate on.
  ctx.on('approval/request', (req, next) => {
    try {
      if (cfg.onUserInputNeeded) {
        const id = req && req.agent && req.agent.id
        if (isDelegated(id)) log('skip attention — delegated subagent approval')
        else fire('attention', cfg.attentionSound, `approval for ${req && req.toolName ? String(req.toolName) : 'a tool'}`, id)
      }
    } catch (error) {
      log(`approval listener failed: ${String(error && error.message ? error.message : error)}`)
    }
    return next()
  })

  // 2b. A structured question needs an answer. Waterfall: always delegate on.
  ctx.on('user-questions/request', (request, next) => {
    try {
      if (cfg.onUserInputNeeded) {
        const id = request && request.agent && request.agent.id
        if (isDelegated(id)) log('skip attention — delegated subagent question')
        else fire('attention', cfg.attentionSound, 'user question', id)
      }
    } catch (error) {
      log(`question listener failed: ${String(error && error.message ? error.message : error)}`)
    }
    return next()
  })

  log(`mounted (turnEnd=${cfg.onTurnEnd} attention=${cfg.onUserInputNeeded} startupChime=${cfg.startupChime} presence=${routeRegistered ? PRESENCE_PATH : 'disabled'})`)
  if (cfg.startupChime) {
    const file = cfg.turnEndSound
    const playable = typeof file === 'string' && file.length > 0 && existsSync(file)
    const played = playable ? playFile(file) : playFallbackTone()
    log(`startup chime ok=${played}`)
  }
}
