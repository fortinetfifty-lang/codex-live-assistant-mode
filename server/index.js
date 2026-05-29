import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const localDir = join(rootDir, '.local')
const sessionFile = join(localDir, 'sessions.json')
const settingsFile = join(localDir, 'settings.json')

await loadDotEnv(join(rootDir, '.env'))

const defaultCodexWorkspace = join(localDir, 'codex-workspace')
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8787)
const reasoningEfforts = new Set(['medium', 'high', 'xhigh'])
const modePresets = new Set(['fast', 'normal', 'deep'])

if (host !== '127.0.0.1' && process.env.ALLOW_REMOTE_LISTEN !== 'true') {
  throw new Error('Remote listening is disabled. Set ALLOW_REMOTE_LISTEN=true only for hardened deployments.')
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'],
])

async function loadDotEnv(filePath) {
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equalsIndex = line.indexOf('=')
    if (equalsIndex === -1) continue
    const key = line.slice(0, equalsIndex).trim()
    let value = line.slice(equalsIndex + 1).trim()
    if (!key || process.env[key] !== undefined) continue
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function sendNdjson(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`)
}

function sendTerminal(response, level, text) {
  sendNdjson(response, {
    type: 'terminal',
    level,
    text,
  })
}

async function readJson(request, limitBytes = 24 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function readSessions() {
  try {
    return JSON.parse(await readFile(sessionFile, 'utf8'))
  } catch {
    return {}
  }
}

async function writeSessions(sessions) {
  await mkdir(localDir, { recursive: true })
  await writeFile(sessionFile, JSON.stringify(sessions, null, 2))
}

async function readLocalSettings() {
  try {
    return JSON.parse(await readFile(settingsFile, 'utf8'))
  } catch {
    return {}
  }
}

async function writeLocalSettings(settings) {
  await mkdir(localDir, { recursive: true })
  await writeFile(settingsFile, JSON.stringify(settings, null, 2))
}

function trimString(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.trim()
}

function normalizeReasoningEffort(value, fallback = 'xhigh') {
  const normalized = trimString(value, fallback).toLowerCase()
  return reasoningEfforts.has(normalized) ? normalized : fallback
}

function normalizeModePreset(value, fallback = 'deep') {
  const normalized = trimString(value, fallback).toLowerCase()
  return modePresets.has(normalized) ? normalized : fallback
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function normalizeSpeed(value, fallback = 1.1) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return fallback
  return Math.min(1.5, Math.max(0.5, speed))
}

function getEnvSettings() {
  return {
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      sttModel: process.env.OPENROUTER_STT_MODEL || 'openai/gpt-4o-transcribe',
      sttLanguage: process.env.OPENROUTER_STT_LANGUAGE || '',
      ttsModel: process.env.OPENROUTER_TTS_MODEL || 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: process.env.OPENROUTER_TTS_VOICE || 'nova',
      speed: normalizeSpeed(process.env.OPENROUTER_TTS_SPEED, 1.1),
    },
    voice: {
      waitingCueEnabled: true,
    },
    codex: {
      model: process.env.CODEX_MODEL || 'gpt-5.5',
      reasoningEffort: normalizeReasoningEffort(process.env.CODEX_REASONING_EFFORT, 'xhigh'),
      modePreset: normalizeModePreset(process.env.CODEX_MODE_PRESET, 'deep'),
      searchEnabled: process.env.CODEX_ENABLE_SEARCH !== 'false',
      workspace: process.env.CODEX_WORKDIR || defaultCodexWorkspace,
    },
  }
}

async function getResolvedSettings() {
  const env = getEnvSettings()
  const local = await readLocalSettings()
  const openrouter = local.openrouter || {}
  const voice = local.voice || {}
  const codex = local.codex || {}

  return {
    openrouter: {
      apiKey: trimString(openrouter.apiKey, env.openrouter.apiKey),
      sttModel: trimString(openrouter.sttModel, env.openrouter.sttModel),
      sttLanguage: trimString(openrouter.sttLanguage, env.openrouter.sttLanguage),
      ttsModel: trimString(openrouter.ttsModel, env.openrouter.ttsModel),
      voice: trimString(openrouter.voice, env.openrouter.voice),
      speed: normalizeSpeed(openrouter.speed, env.openrouter.speed),
    },
    voice: {
      waitingCueEnabled: normalizeBoolean(voice.waitingCueEnabled, env.voice.waitingCueEnabled),
    },
    codex: {
      model: trimString(codex.model, env.codex.model),
      reasoningEffort: normalizeReasoningEffort(codex.reasoningEffort, env.codex.reasoningEffort),
      modePreset: normalizeModePreset(codex.modePreset, env.codex.modePreset),
      searchEnabled: normalizeBoolean(codex.searchEnabled, env.codex.searchEnabled),
      workspace: trimString(codex.workspace, env.codex.workspace) || defaultCodexWorkspace,
    },
    storage: {
      localSettings: Boolean(Object.keys(local).length),
    },
  }
}

function serializeSettings(settings, workspaceInfo = {}) {
  return {
    openrouter: {
      configured: Boolean(settings.openrouter.apiKey),
      sttModel: settings.openrouter.sttModel,
      sttLanguage: settings.openrouter.sttLanguage,
      ttsModel: settings.openrouter.ttsModel,
      voice: settings.openrouter.voice,
      speed: settings.openrouter.speed,
    },
    voice: {
      waitingCueEnabled: settings.voice.waitingCueEnabled,
    },
    codex: {
      model: settings.codex.model,
      reasoningEffort: settings.codex.reasoningEffort,
      modePreset: settings.codex.modePreset,
      searchEnabled: settings.codex.searchEnabled,
      workspace: settings.codex.workspace,
      workspaceExists: Boolean(workspaceInfo.exists),
      workspaceWarning: workspaceInfo.warning,
    },
    storage: settings.storage,
  }
}

async function getWorkspaceInfo(workspace) {
  try {
    const info = await stat(workspace)
    return info.isDirectory() ? { exists: true } : { exists: false, warning: 'Path is not a directory.' }
  } catch {
    return { exists: false, warning: 'Workspace path does not exist yet.' }
  }
}

function safePreview(input, maxLength = 220) {
  return String(input || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)\S+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function execVersion(command, args) {
  return new Promise((resolveVersion) => {
    const child = spawn(command, args, { shell: process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolveVersion({ available: false, error: error.message })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolveVersion({ available: true, version: stdout.trim() })
        return
      }
      resolveVersion({ available: false, error: stderr.trim() || `Exited with code ${code}` })
    })
  })
}

function execSafeCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { shell: process.platform === 'win32' })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolveResult({ ok: false, code: null, stdout: safePreview(stdout), stderr: 'Command timed out' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveResult({ ok: false, code: null, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveResult({
        ok: code === 0,
        code,
        stdout: safePreview(stdout, 500),
        stderr: safePreview(stderr, 500),
      })
    })
  })
}

function stopProcessTree(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => child.kill())
    return
  }
  child.kill()
}

function requireOpenRouterKey(settings) {
  const apiKey = settings.openrouter.apiKey
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured')
  return apiKey
}

function clampSpeechSpeed(value, fallback = 1.1) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return fallback
  return Math.min(1.5, Math.max(0.5, speed))
}

function sanitizeSpeechText(input) {
  return String(input || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{2,}.*$/gm, ' ')
    .replace(/^\s*(const|let|var|function|class|import|export|return|if|for|while)\b.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectActivityFromText(text) {
  const normalized = String(text || '').toLowerCase()
  const domainLike = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|app|co|tr|news|site|tech|gg)\b/i.test(text)
  const namedSite = /\b(webtekno|shiftdelete|donanimhaber|technopat|reddit|github|x\.com|twitter|youtube|medium|producthunt)\b/i.test(text)
  const searchIntent =
    /https?:\/\//i.test(text) ||
    domainLike ||
    namedSite ||
    /\b(search|web|source|sources|link|links|cite|citation|research|latest|current|news|article|headline|site|website|visit|open|browse|check|lookup|look up|show me|read)\b/.test(normalized) ||
    /\b(araştır|araştırma|arama|kaynak|link|güncel|internetten|web|haber|haberler|son haber|siteye|sitesine|sitesi|gir|girebilir|incele|inceleyebilir|göster|gosterebilir|bak|bakar mısın|kontrol et|oku)\b/.test(normalized)

  if (
    searchIntent
  ) {
    return {
      kind: 'searching',
      title: 'Searching web',
      detail: 'Detected a search or source-heavy turn.',
    }
  }

  if (
    /```|`[^`]+`/.test(text) ||
    /\b(tool|command|terminal|shell|mcp|code|file|repo|build|test)\b/.test(normalized) ||
    /\b(kod|komut|dosya|repo|test|araç)\b/.test(normalized)
  ) {
    return {
      kind: 'tools',
      title: 'Using tools',
      detail: 'Detected code, tool, or command-oriented content.',
    }
  }

  return undefined
}

function activityLabel(activity) {
  if (!activity) return 'Codex'
  return activity.kind === 'searching' ? 'Web search' : activity.kind === 'tools' ? 'Tool use' : 'Codex'
}

function activityTerminalPrefix(activity) {
  if (!activity) return 'codex'
  return activity.kind === 'searching' ? 'web search' : activity.kind === 'tools' ? 'tool' : 'codex'
}

function terminalStatusText(activity, status) {
  const prefix = activityTerminalPrefix(activity)
  if (status === 'done') return `${prefix} completed`
  if (status === 'error') return `${prefix} failed`
  return `${prefix} active`
}

function bridgeActivityPayload(activity, eventId, status = 'active', detail) {
  return {
    ...activity,
    detail: detail || activity.detail,
    status,
    source: 'bridge',
    eventId,
    label: activityLabel(activity),
  }
}

function heartbeatPreview(activity, count) {
  if (activity?.kind === 'searching') {
    const steps = [
      ['Searching web', 'Codex is expected to use web search for this turn.'],
      ['Reading sources', 'Waiting for Codex to inspect sources and collect useful context.'],
      ['Waiting for Codex output', 'The bridge is still waiting for live Codex search output.'],
    ]
    const [title, detail] = steps[(count - 1) % steps.length]
    return { title, detail, preview: `${title} (${count})` }
  }

  if (activity?.kind === 'tools') {
    const steps = [
      ['Using tools', 'Codex is expected to use a local tool or command for this turn.'],
      ['Watching tool output', 'Waiting for Codex to emit command or tool progress.'],
      ['Waiting for Codex output', 'The bridge is still waiting for live Codex tool output.'],
    ]
    const [title, detail] = steps[(count - 1) % steps.length]
    return { title, detail, preview: `${title} (${count})` }
  }

  return {
    title: 'Waiting for Codex',
    detail: 'The local bridge is still waiting for streamed Codex output.',
    preview: `Waiting for Codex output (${count})`,
  }
}

function getAudioFormat(mimeType, fileName) {
  const normalizedMime = String(mimeType || '').toLowerCase().split(';')[0]
  const mimeMap = new Map([
    ['audio/flac', 'flac'],
    ['audio/mp4', 'mp4'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/mpga', 'mpga'],
    ['audio/m4a', 'm4a'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/webm', 'webm'],
  ])

  if (mimeMap.has(normalizedMime)) return mimeMap.get(normalizedMime)

  const extension = extname(String(fileName || '')).replace('.', '').toLowerCase()
  if (extension) return extension === 'mpeg' ? 'mp3' : extension

  return 'webm'
}

async function handleHealth(_request, response) {
  const codex = await execVersion('codex', ['--version'])
  const settings = await getResolvedSettings()
  const workspaceInfo = await getWorkspaceInfo(settings.codex.workspace)
  sendJson(response, 200, {
    server: {
      host,
      port,
      localOnly: host === '127.0.0.1',
    },
    codex,
    openrouter: {
      configured: Boolean(settings.openrouter.apiKey),
      sttModel: settings.openrouter.sttModel,
      ttsModel: settings.openrouter.ttsModel,
      voice: settings.openrouter.voice,
      speed: settings.openrouter.speed,
    },
    settings: {
      codex: {
        model: settings.codex.model,
        reasoningEffort: settings.codex.reasoningEffort,
        modePreset: settings.codex.modePreset,
        searchEnabled: settings.codex.searchEnabled,
        workspace: settings.codex.workspace,
        workspaceExists: Boolean(workspaceInfo.exists),
      },
      voice: {
        waitingCueEnabled: settings.voice.waitingCueEnabled,
      },
    },
  })
}

async function handleCodexUsage(_request, response) {
  const loginStatus = await execSafeCommand('codex', ['login', 'status'], 5000)
  const loginSummary = `${loginStatus.stdout} ${loginStatus.stderr}`
  const loggedIn = loginStatus.ok && !/\b(not logged in|logged out|no login)\b/i.test(loginSummary)

  sendJson(response, 200, {
    source: 'codex-cli',
    available: false,
    reason: 'Codex CLI does not expose remaining usage limits through a safe official command.',
    fiveHour: {
      label: '5h',
      status: 'unavailable',
      remaining: null,
      resetAt: null,
    },
    weekly: {
      label: 'Weekly',
      status: 'unavailable',
      remaining: null,
      resetAt: null,
    },
    auth: {
      loggedIn,
      status: loggedIn ? 'logged-in' : 'unknown',
    },
    updatedAt: new Date().toISOString(),
  })
}

async function handleTranscribe(request, response) {
  const { audioBase64, mimeType = 'audio/webm', fileName = 'voice-message.webm' } = await readJson(request)
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    sendJson(response, 400, { error: 'audioBase64 is required' })
    return
  }

  const settings = await getResolvedSettings()
  if (!settings.openrouter.apiKey) {
    sendJson(response, 503, { error: 'OPENROUTER_API_KEY is not configured' })
    return
  }

  const apiKey = requireOpenRouterKey(settings)
  const { sttModel, sttLanguage } = settings.openrouter
  const transcriptionRequest = {
    model: sttModel,
    input_audio: {
      data: audioBase64,
      format: getAudioFormat(mimeType, fileName),
    },
  }
  if (sttLanguage) {
    transcriptionRequest.language = sttLanguage
  }

  const upstream = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://127.0.0.1',
      'X-Title': 'Codex Live Assistant Mode',
    },
    body: JSON.stringify(transcriptionRequest),
  })
  const payload = await upstream.json().catch(() => ({}))
  if (!upstream.ok) {
    sendJson(response, upstream.status, { error: payload.error?.message || 'OpenRouter transcription failed' })
    return
  }

  sendJson(response, 200, { text: payload.text || payload.transcription || '' })
}

async function handleSpeech(request, response) {
  const { text, speed } = await readJson(request, 2 * 1024 * 1024)
  if (!text || typeof text !== 'string') {
    sendJson(response, 400, { error: 'text is required' })
    return
  }

  const settings = await getResolvedSettings()
  if (!settings.openrouter.apiKey) {
    sendJson(response, 503, { error: 'OPENROUTER_API_KEY is not configured' })
    return
  }

  const apiKey = requireOpenRouterKey(settings)
  const { ttsModel, voice } = settings.openrouter
  const input = sanitizeSpeechText(text)
  if (!input) {
    sendJson(response, 400, { error: 'No speakable text remains after removing links and code' })
    return
  }

  const upstream = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://127.0.0.1',
      'X-Title': 'Codex Live Assistant Mode',
    },
    body: JSON.stringify({
      model: ttsModel,
      voice,
      input,
      response_format: 'mp3',
      speed: clampSpeechSpeed(speed, settings.openrouter.speed),
    }),
  })

  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => ({}))
    sendJson(response, upstream.status, { error: payload.error?.message || 'OpenRouter speech failed' })
    return
  }

  const audio = Buffer.from(await upstream.arrayBuffer())
  sendJson(response, 200, {
    audioBase64: audio.toString('base64'),
    mimeType: upstream.headers.get('content-type') || 'audio/mpeg',
  })
}

async function handleGetSettings(_request, response) {
  const settings = await getResolvedSettings()
  const workspaceInfo = await getWorkspaceInfo(settings.codex.workspace)
  sendJson(response, 200, serializeSettings(settings, workspaceInfo))
}

async function handlePutSettings(request, response) {
  const body = await readJson(request, 256 * 1024)
  const current = await readLocalSettings()
  const currentResolved = await getResolvedSettings()
  const next = {
    openrouter: { ...(current.openrouter || {}) },
    voice: { ...(current.voice || {}) },
    codex: { ...(current.codex || {}) },
  }

  if (body.openrouter && typeof body.openrouter === 'object') {
    const input = body.openrouter
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.openrouter.apiKey = input.apiKey.trim()
    if (input.clearApiKey === true) delete next.openrouter.apiKey
    if (typeof input.sttModel === 'string') next.openrouter.sttModel = trimString(input.sttModel, currentResolved.openrouter.sttModel)
    if (typeof input.sttLanguage === 'string') next.openrouter.sttLanguage = trimString(input.sttLanguage, '')
    if (typeof input.ttsModel === 'string') next.openrouter.ttsModel = trimString(input.ttsModel, currentResolved.openrouter.ttsModel)
    if (typeof input.voice === 'string') next.openrouter.voice = trimString(input.voice, currentResolved.openrouter.voice)
    if (input.speed !== undefined) next.openrouter.speed = normalizeSpeed(input.speed, currentResolved.openrouter.speed)
  }

  if (body.voice && typeof body.voice === 'object') {
    if (body.voice.waitingCueEnabled !== undefined) {
      next.voice.waitingCueEnabled = normalizeBoolean(body.voice.waitingCueEnabled, currentResolved.voice.waitingCueEnabled)
    }
  }

  if (body.codex && typeof body.codex === 'object') {
    const input = body.codex
    if (typeof input.model === 'string') next.codex.model = trimString(input.model, currentResolved.codex.model)
    if (typeof input.reasoningEffort === 'string') {
      next.codex.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort, currentResolved.codex.reasoningEffort)
    }
    if (typeof input.modePreset === 'string') next.codex.modePreset = normalizeModePreset(input.modePreset, currentResolved.codex.modePreset)
    if (input.searchEnabled !== undefined) next.codex.searchEnabled = normalizeBoolean(input.searchEnabled, currentResolved.codex.searchEnabled)
    if (typeof input.workspace === 'string') next.codex.workspace = trimString(input.workspace, currentResolved.codex.workspace) || defaultCodexWorkspace
  }

  await writeLocalSettings(next)
  const settings = await getResolvedSettings()
  const workspaceInfo = await getWorkspaceInfo(settings.codex.workspace)
  sendJson(response, 200, serializeSettings(settings, workspaceInfo))
}

async function handleGetSessions(_request, response) {
  const sessions = await readSessions()
  const settings = await getResolvedSettings()
  sendJson(response, 200, {
    currentWorkspace: settings.codex.workspace,
    sessions: Object.values(sessions)
      .map((session) => ({
        appSessionId: session.appSessionId,
        codexSessionId: session.codexSessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turns: session.turns || 0,
        lastMode: session.lastMode,
        workspace: session.workspace || settings.codex.workspace,
      }))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))),
  })
}

async function handleCodexLogout(request, response) {
  const body = await readJson(request, 8 * 1024)
  if (body.confirm !== 'logout') {
    sendJson(response, 400, { error: 'Explicit confirmation is required.' })
    return
  }

  const result = await execVersion('codex', ['logout'])
  if (!result.available) {
    sendJson(response, 500, { error: result.error || 'Codex logout failed' })
    return
  }
  sendJson(response, 200, { ok: true })
}

function buildModePrompt(mode, text) {
  const modeText = {
    talk: 'Talk mode: answer naturally, warmly, and concisely for spoken conversation.',
    research: 'Research mode: use web search when useful, compare sources, and keep citations or source names concise.',
    code: 'Code mode: help with code in read-only mode. Do not write files or ask to run destructive commands.',
    'deep-think': 'Deep Think mode: reason carefully, surface tradeoffs, and avoid rushing to a shallow answer.',
  }[mode] || 'Talk mode: answer naturally and concisely for spoken conversation.'

  return `${modeText}

You are responding through Codex Live Assistant Mode, an unofficial local voice interface.
Keep the final answer voice-friendly. Do not mention internal JSON events. If a task is risky, explain the boundary clearly.
Do not write raw URLs in the main prose unless the user explicitly needs them. Prefer source names and short summaries for spoken answers.

User transcript:
${text}`
}

function buildCodexArgs({ codexSessionId, outputFile, settings }) {
  const { model, reasoningEffort, searchEnabled, workspace } = settings.codex
  const args = []

  if (searchEnabled) args.push('--search')
  args.push('--ask-for-approval', 'never')

  if (codexSessionId) {
    args.push('exec', 'resume', '--json', '--skip-git-repo-check', '--output-last-message', outputFile)
    if (model) args.push('-m', model)
    if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
    args.push(codexSessionId, '-')
    return args
  }

  args.push(
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-last-message',
    outputFile,
    '-C',
    workspace,
  )
  if (model) args.push('-m', model)
  if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
  args.push('-')
  return args
}

function findSessionId(value) {
  if (!value || typeof value !== 'object') return undefined
  for (const [key, nested] of Object.entries(value)) {
    if (
      typeof nested === 'string' &&
      /session|conversation|thread/i.test(key) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nested)
    ) {
      return nested
    }
    if (nested && typeof nested === 'object') {
      const found = findSessionId(nested)
      if (found) return found
    }
  }
  return undefined
}

function getCodexEventType(event) {
  return String(
    event?.item?.type ||
      event?.type ||
      event?.event ||
      event?.kind ||
      event?.status ||
      'codex_event',
  )
}

function getCodexEventId(event) {
  return String(event?.item?.id || event?.id || event?.thread_id || getCodexEventType(event))
}

function getCodexEventStatus(event) {
  const statusText = [
    event?.type,
    event?.event,
    event?.kind,
    event?.status,
    event?.item?.status,
  ].filter(Boolean).join(' ').toLowerCase()

  if (/\b(failed|error|errored|cancelled|canceled)\b/.test(statusText)) return 'error'
  if (/\b(completed|complete|done|succeeded|success|finished)\b/.test(statusText)) return 'done'
  return 'active'
}

function classifyCodexEvent(event) {
  const serialized = JSON.stringify(event).toLowerCase()
  const eventType = getCodexEventType(event)
  const status = getCodexEventStatus(event)
  const itemType = String(event?.item?.type || '').toLowerCase()
  const searchLike =
    /web[_-]?search|search_query|search result|search_result|citation|source_url|source-url/.test(serialized)
  const toolLike =
    itemType === 'command_execution' ||
    /tool|function_call|command|exec|shell|terminal|mcp|local_shell|apply_patch/.test(serialized)

  if (itemType === 'agent_message') {
    return { domain: 'answer', eventType, status }
  }

  if (/thread\.started|turn\.started|turn\.completed/.test(eventType)) {
    return { domain: 'thinking', eventType, status }
  }

  if (searchLike) {
    return { domain: 'search', eventType, status }
  }

  if (toolLike) {
    return { domain: 'tool', eventType, status }
  }

  if (status === 'error') {
    return { domain: 'error', eventType, status }
  }

  return { domain: 'thinking', eventType, status }
}

function normalizeCodexEvent(event) {
  const classification = classifyCodexEvent(event)
  const eventType = classification.eventType
  const item = event?.item || {}
  const eventId = getCodexEventId(event)
  const command = safePreview(item.command || item.name || '')
  const outputPreview = safePreview(item.aggregated_output || item.output || item.text || '')

  if (classification.domain === 'search') {
    return {
      kind: 'searching',
      title: classification.status === 'done' ? 'Search complete' : classification.status === 'error' ? 'Search failed' : 'Searching web',
      detail: classification.status === 'done' ? 'Codex finished a search-related step.' : classification.status === 'error' ? 'Codex reported a search error.' : 'Codex is using a search-related step.',
      status: classification.status,
      source: 'codex',
      eventId,
      label: 'Web search',
      preview: outputPreview,
    }
  }

  if (classification.domain === 'tool') {
    return {
      kind: 'tools',
      title: classification.status === 'done' ? 'Tool complete' : classification.status === 'error' ? 'Tool failed' : 'Using tools',
      detail: command || (classification.status === 'done' ? 'Codex finished a tool or command step.' : classification.status === 'error' ? 'Codex reported a tool or command error.' : 'Codex is using a tool or command step.'),
      status: classification.status,
      source: 'codex',
      eventId,
      label: item.type === 'command_execution' ? 'Command' : 'Tool',
      preview: outputPreview,
    }
  }

  if (classification.domain === 'answer') {
    return {
      kind: 'thinking',
      title: 'Drafting answer',
      detail: 'Codex is preparing a response.',
      status: classification.status,
      source: 'codex',
      eventId,
      label: 'Agent message',
      preview: outputPreview,
    }
  }

  if (classification.domain === 'error') {
    return {
      kind: 'error',
      title: 'Codex event failed',
      detail: `Codex event: ${eventType}`,
      status: 'error',
      source: 'codex',
      eventId,
      label: eventType,
      preview: outputPreview,
    }
  }

  if (eventType === 'thread.started') {
    return {
      kind: 'thinking',
      title: 'Thread started',
      detail: event.thread_id ? `Codex thread ${String(event.thread_id).slice(0, 8)}...` : 'Codex opened a thread.',
      status: 'active',
      source: 'codex',
      eventId,
      label: 'Thread',
    }
  }

  if (eventType === 'turn.started') {
    return {
      kind: 'thinking',
      title: 'Turn started',
      detail: 'Codex accepted the prompt and started working.',
      status: 'active',
      source: 'codex',
      eventId,
      label: 'Turn',
    }
  }

  if (eventType === 'turn.completed') {
    return {
      kind: 'thinking',
      title: 'Turn complete',
      detail: event.usage?.output_tokens ? `Codex finished with ${event.usage.output_tokens} output tokens.` : 'Codex completed the turn.',
      status: 'done',
      source: 'codex',
      eventId,
      label: 'Turn',
    }
  }

  return {
    kind: 'thinking',
    title: 'Thinking',
    detail: `Codex event: ${eventType}`,
    status: classification.status,
    source: 'codex',
    eventId,
    label: eventType,
    preview: outputPreview,
  }
}

function getTerminalEvent(event) {
  const classification = classifyCodexEvent(event)
  const statusText = classification.status === 'done' ? 'completed' : classification.status
  const item = event?.item || {}
  const command = safePreview(item.command || item.name || '')

  if (classification.domain === 'search') {
    return {
      level: classification.status === 'error' ? 'error' : 'search',
      text: `web search ${statusText}`,
    }
  }

  if (classification.domain === 'tool') {
    return {
      level: classification.status === 'error' ? 'error' : 'tool',
      text: command ? `tool ${statusText}: ${command}` : `tool ${statusText}`,
    }
  }

  if (classification.domain === 'answer') {
    return {
      level: 'info',
      text: `answer ${statusText}`,
    }
  }

  if (classification.domain === 'error') {
    return {
      level: 'error',
      text: `codex ${statusText}`,
    }
  }

  return {
    level: 'info',
    text: `codex ${classification.status === 'done' ? 'completed' : classification.eventType}`,
  }
}

async function handleCodexMessage(request, response) {
  const body = await readJson(request, 2 * 1024 * 1024)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const mode = typeof body.mode === 'string' ? body.mode : 'talk'
  const appSessionId = typeof body.appSessionId === 'string' && body.appSessionId ? body.appSessionId : randomUUID()

  if (!text) {
    sendJson(response, 400, { error: 'text is required' })
    return
  }

  const settings = await getResolvedSettings()
  await mkdir(settings.codex.workspace, { recursive: true })
  await mkdir(localDir, { recursive: true })

  const sessions = await readSessions()
  const session = sessions[appSessionId] || {
    appSessionId,
    codexSessionId: undefined,
    createdAt: new Date().toISOString(),
    turns: 0,
  }
  const outputFile = join(localDir, `codex-final-${randomUUID()}.txt`)
  const args = buildCodexArgs({ codexSessionId: session.codexSessionId, outputFile, settings })
  const prompt = buildModePrompt(mode, text)
  const bridgeTurnId = randomUUID()
  const requestedActivity = detectActivityFromText(text)
  const requestedActivityId = requestedActivity ? `bridge:${bridgeTurnId}:${requestedActivity.kind}` : undefined

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const canWrite = () => !response.writableEnded && !response.destroyed
  const terminalEventKeys = new Set()
  const sendActivity = (payload) => {
    if (canWrite()) sendNdjson(response, { type: 'activity', ...payload })
  }
  const sendTerminalEvent = (level, message, key) => {
    if (key) {
      if (terminalEventKeys.has(key)) return
      terminalEventKeys.add(key)
    }
    if (canWrite()) sendTerminal(response, level, message)
  }
  const sendErrorEvent = (message) => {
    if (canWrite()) sendNdjson(response, { type: 'error', message })
  }
  const endResponse = () => {
    if (canWrite()) response.end()
  }

  sendNdjson(response, {
    type: 'session',
    appSessionId,
    codexSessionId: session.codexSessionId,
  })
  sendActivity({
    kind: 'thinking',
    title: session.codexSessionId ? 'Resuming Codex session' : 'Creating Codex session',
    detail: session.codexSessionId ? 'The local bridge is resuming the saved Codex thread.' : 'The local bridge is starting a persistent Codex thread.',
    status: 'active',
    source: 'bridge',
  })
  sendTerminalEvent(
    'info',
    session.codexSessionId
      ? `resume codex session ${session.codexSessionId}`
      : 'start codex exec --sandbox read-only',
  )

  if (requestedActivity && requestedActivityId) {
    sendActivity(bridgeActivityPayload(requestedActivity, requestedActivityId, 'active'))
    sendTerminalEvent(
      requestedActivity.kind === 'searching' ? 'search' : 'tool',
      `${activityTerminalPrefix(requestedActivity)} requested`,
      `${requestedActivityId}:requested`,
    )
    sendTerminalEvent(
      requestedActivity.kind === 'searching' ? 'search' : 'tool',
      terminalStatusText(requestedActivity, 'active'),
      `${requestedActivityId}:active`,
    )
  }

  const child = spawn('codex', args, {
    cwd: rootDir,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let codexSessionId = session.codexSessionId
  let closed = false
  let heartbeatCount = 0
  const heartbeatEventId = requestedActivityId || `bridge:${bridgeTurnId}:waiting`
  const heartbeatTimer = setInterval(() => {
    heartbeatCount += 1
    if (!canWrite() || closed) return
    if (requestedActivity) {
      const heartbeat = heartbeatPreview(requestedActivity, heartbeatCount)
      sendActivity({
        ...bridgeActivityPayload(requestedActivity, heartbeatEventId, 'active', heartbeat.detail),
        title: heartbeat.title,
        preview: heartbeat.preview,
      })
      return
    }

    const heartbeat = heartbeatPreview(undefined, heartbeatCount)
    sendActivity({
      kind: 'thinking',
      title: heartbeat.title,
      detail: heartbeat.detail,
      status: 'active',
      source: 'bridge',
      eventId: heartbeatEventId,
      label: 'Bridge heartbeat',
      preview: heartbeat.preview,
    })
  }, 2000)

  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer)
  }

  const abortChild = () => {
    if (!closed) {
      stopHeartbeat()
      stopProcessTree(child)
    }
  }

  request.on('close', abortChild)
  response.on('close', abortChild)

  child.stdin.write(prompt)
  child.stdin.end()

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        codexSessionId = codexSessionId || findSessionId(event)
        sendActivity(normalizeCodexEvent(event))
        const terminalEvent = getTerminalEvent(event)
        sendTerminalEvent(terminalEvent.level, terminalEvent.text, `${terminalEvent.level}:${terminalEvent.text}`)
      } catch {
        sendActivity({
          kind: 'thinking',
          title: 'Thinking',
          detail: 'Codex emitted progress output.',
          status: 'active',
          source: 'codex',
        })
        sendTerminalEvent('info', 'codex emitted progress output')
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString()
  })

  child.on('error', (error) => {
    stopHeartbeat()
    if (requestedActivity && requestedActivityId) {
      sendActivity(bridgeActivityPayload(requestedActivity, requestedActivityId, 'error'))
      sendTerminalEvent('error', terminalStatusText(requestedActivity, 'error'), `${requestedActivityId}:error`)
    }
    sendErrorEvent(error.message)
    endResponse()
  })

  child.on('close', async (code) => {
    closed = true
    stopHeartbeat()
    if (code !== 0) {
      if (requestedActivity && requestedActivityId) {
        sendActivity(bridgeActivityPayload(requestedActivity, requestedActivityId, 'error'))
        sendTerminalEvent('error', terminalStatusText(requestedActivity, 'error'), `${requestedActivityId}:error`)
      }
      sendErrorEvent(stderrBuffer.trim() || `Codex exited with code ${code}`)
      endResponse()
      return
    }

    let finalText = ''
    try {
      finalText = (await readFile(outputFile, 'utf8')).trim()
    } catch {
      finalText = ''
    }
    await unlink(outputFile).catch(() => undefined)

    session.codexSessionId = codexSessionId
    session.updatedAt = new Date().toISOString()
    session.turns += 1
    session.lastMode = mode
    session.workspace = settings.codex.workspace
    sessions[appSessionId] = session
    await writeSessions(sessions)

    if (requestedActivity && requestedActivityId) {
      sendActivity(bridgeActivityPayload(requestedActivity, requestedActivityId, 'done'))
      sendTerminalEvent(
        requestedActivity.kind === 'searching' ? 'search' : 'tool',
        terminalStatusText(requestedActivity, 'done'),
        `${requestedActivityId}:done`,
      )
    } else {
      const finalActivity = detectActivityFromText(finalText)
      if (finalActivity) {
        sendActivity({
          ...finalActivity,
          status: 'done',
          source: 'codex',
          eventId: `codex:${bridgeTurnId}:final:${finalActivity.kind}`,
          label: activityLabel(finalActivity),
        })
      }
    }

    if (canWrite()) {
      sendNdjson(response, {
        type: 'final',
        appSessionId,
        codexSessionId,
        text: finalText,
      })
    }
    endResponse()
  })
}

async function serveStatic(request, response) {
  const distDir = join(rootDir, 'dist')
  const url = new URL(request.url || '/', `http://${host}:${port}`)
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname
  const filePath = resolve(join(distDir, requestedPath))

  if (!filePath.startsWith(distDir)) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('Not a file')
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
    })
    createReadStream(filePath).pipe(response)
  } catch {
    const fallback = join(distDir, 'index.html')
    try {
      await stat(fallback)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      createReadStream(fallback).pipe(response)
    } catch {
      sendJson(response, 404, { error: 'Build output not found. Run npm run build or use npm run dev.' })
    }
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`)
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await handleHealth(request, response)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/codex/usage') {
      await handleCodexUsage(request, response)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      await handleGetSettings(request, response)
      return
    }
    if (request.method === 'PUT' && url.pathname === '/api/settings') {
      await handlePutSettings(request, response)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      await handleGetSessions(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/codex/logout') {
      await handleCodexLogout(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      await handleTranscribe(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/speech') {
      await handleSpeech(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/codex/message') {
      await handleCodexMessage(request, response)
      return
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Unknown API endpoint' })
      return
    }
    await serveStatic(request, response)
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Internal server error',
    })
  }
})

server.listen(port, host, () => {
  console.log(`Codex Live Assistant Mode server listening at http://${host}:${port}`)
})
