import {
  Activity,
  Brain,
  CircleStop,
  Code2,
  FolderOpen,
  KeyRound,
  Loader2,
  LogOut,
  Mic,
  Radio,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Volume2,
  Waves,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import type {
  ActivityItem,
  AppSessionSummary,
  AppSettings,
  CodexStreamEvent,
  CodexUsageStatus,
  HealthStatus,
  Message,
  ModeId,
  ModePreset,
  ReasoningEffort,
  SessionsResponse,
} from './types'

const workingHints = [
  'Thinking through the request',
  'Holding the conversation context',
  'Watching Codex activity',
  'Preparing a voice-friendly answer',
]

const appSessionStorageKey = 'codex-live-assistant-mode.session-id'
const waitCueStorageKey = 'codex-live-assistant-mode.wait-cue'

const liveTurnConfig = {
  endSilenceMs: 1600,
  minSpeechMs: 280,
  minRecordingMs: 1200,
  noSpeechTimeoutMs: 10000,
  maxTurnMs: 45000,
}

const liveVadConfig = {
  initialNoiseFloor: 0.01,
  minNoiseFloor: 0.004,
  maxNoiseFloor: 0.05,
  voiceMultiplier: 2.05,
  minVoiceThreshold: 0.01,
  releaseMultiplier: 1.35,
  minReleaseThreshold: 0.006,
  fallbackMinBytes: 12 * 1024,
  fallbackMinPeak: 0.08,
}

const bargeInConfig = {
  holdMs: 420,
  noiseMultiplier: 3.2,
  minThreshold: 0.022,
}

const activityStages: Array<{
  kind: ActivityItem['kind']
  title: string
  detail: string
  icon: typeof Brain
}> = [
  {
    kind: 'thinking',
    title: 'Thinking',
    detail: 'Analyzing the request and planning the next step.',
    icon: Brain,
  },
  {
    kind: 'searching',
    title: 'Searching web',
    detail: 'Checking sources and current context when needed.',
    icon: Search,
  },
  {
    kind: 'tools',
    title: 'Using tools',
    detail: 'Watching Codex tool, shell, or bridge activity.',
    icon: Code2,
  },
]

type AudioPayload = {
  audioBase64: string
  mimeType: string
}

type TerminalEntry = {
  id: string
  level: 'info' | 'search' | 'tool' | 'error'
  text: string
  time: string
}

type RecordingOptions = {
  autoStop?: boolean
  allowDuringPlayback?: boolean
  replaceCurrentTurn?: boolean
}

type SettingsTab = 'voice' | 'codex' | 'sessions' | 'auth'
type TurnPhase = 'idle' | 'recording' | 'transcribing' | 'codex' | 'speaking'

type SettingsDraft = {
  openrouter: {
    apiKey: string
    sttModel: string
    sttLanguage: string
    ttsModel: string
    voice: string
    speed: number
  }
  voice: {
    waitingCueEnabled: boolean
  }
  codex: {
    model: string
    reasoningEffort: ReasoningEffort
    modePreset: ModePreset
    searchEnabled: boolean
    workspace: string
  }
}

const emptySettingsDraft: SettingsDraft = {
  openrouter: {
    apiKey: '',
    sttModel: 'openai/gpt-4o-transcribe',
    sttLanguage: '',
    ttsModel: 'openai/gpt-4o-mini-tts-2025-12-15',
    voice: 'nova',
    speed: 1.1,
  },
  voice: {
    waitingCueEnabled: true,
  },
  codex: {
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    modePreset: 'deep',
    searchEnabled: true,
    workspace: '',
  },
}

function createId() {
  return crypto.randomUUID()
}

function getTimeLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatUsageUpdated(value?: string) {
  if (!value) return 'Checking'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Unknown'
  return getTimeLabel(parsed)
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = String(reader.result ?? '')
      resolve(result.includes(',') ? result.split(',')[1] : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

function getAudioConstraints(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }
}

function createSettingsDraft(settings: AppSettings | null): SettingsDraft {
  if (!settings) return emptySettingsDraft
  return {
    openrouter: {
      apiKey: '',
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
    },
  }
}

function addActivity(
  setActivity: Dispatch<SetStateAction<ActivityItem[]>>,
  item: Omit<ActivityItem, 'id' | 'time'>,
) {
  setActivity((current) => {
    const incomingActive = Boolean(item.active) && item.status !== 'done' && item.status !== 'error'
    const keepCurrentActive =
      item.kind === 'thinking' &&
      item.source === 'codex' &&
      current.some((entry) => entry.active && (entry.kind === 'searching' || entry.kind === 'tools'))
    const shouldActivate = incomingActive && !keepCurrentActive

    if (item.eventId) {
      const existing = current.findIndex((entry) => entry.eventId === item.eventId)
      if (existing !== -1) {
        return current.map((entry, index) => {
          if (index === existing) {
            return {
              ...entry,
              ...item,
              active: shouldActivate,
              time: item.status === 'done' || item.status === 'error' ? getTimeLabel() : entry.time,
            }
          }
          if (shouldActivate) return { ...entry, active: false }
          if ((item.status === 'done' || item.status === 'error') && entry.kind === item.kind) {
            return { ...entry, active: false }
          }
          return entry
        })
      }
    }

    return [
      {
        id: createId(),
        time: getTimeLabel(),
        ...item,
        active: shouldActivate,
      },
      ...current.map((entry) => {
        if (shouldActivate) return { ...entry, active: false }
        if ((item.status === 'done' || item.status === 'error') && entry.kind === item.kind) {
          return { ...entry, active: false }
        }
        return entry
      }),
    ].slice(0, 12)
  })
}

function addTerminal(
  setTerminalLog: Dispatch<SetStateAction<TerminalEntry[]>>,
  item: Pick<TerminalEntry, 'level' | 'text'>,
) {
  setTerminalLog((current) => [
    ...current,
    {
      id: createId(),
      time: getTimeLabel(),
      ...item,
    },
  ].slice(-80))
}

function sanitizeSpeechText(input: string) {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{2,}.*$/gm, ' ')
    .replace(/^\s*(const|let|var|function|class|import|export|return|if|for|while)\b.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitSpeechChunks(input: string, maxWords = 34) {
  const text = sanitizeSpeechText(input)
  if (!text) return []

  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  const chunks: string[] = []
  let current: string[] = []

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean)
    if (words.length > maxWords) {
      if (current.length) {
        chunks.push(current.join(' '))
        current = []
      }
      for (let index = 0; index < words.length; index += maxWords) {
        chunks.push(words.slice(index, index + maxWords).join(' '))
      }
      continue
    }

    if (current.length + words.length > maxWords && current.length) {
      chunks.push(current.join(' '))
      current = []
    }
    current.push(...words)
  }

  if (current.length) chunks.push(current.join(' '))
  return chunks
}

export function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [usage, setUsage] = useState<CodexUsageStatus | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([
    {
      id: createId(),
      kind: 'system',
      title: 'Local session ready',
      detail: 'The app will connect to Codex through the local bridge.',
      time: getTimeLabel(),
    },
  ])
  const [terminalLog, setTerminalLog] = useState<TerminalEntry[]>([
    {
      id: createId(),
      level: 'info',
      text: 'local bridge ready',
      time: getTimeLabel(),
    },
  ])
  const [recording, setRecording] = useState(false)
  const [working, setWorking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [turnPhase, setTurnPhase] = useState<TurnPhase>('idle')
  const [liveMode, setLiveMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [hintIndex, setHintIndex] = useState(0)
  const [volume, setVolume] = useState(0)
  const [speechSpeed, setSpeechSpeed] = useState(1.1)
  const [waitCueEnabled, setWaitCueEnabled] = useState(() => localStorage.getItem(waitCueStorageKey) !== 'off')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('voice')
  const [settingsData, setSettingsData] = useState<AppSettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(emptySettingsDraft)
  const [sessions, setSessions] = useState<AppSessionSummary[]>([])
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [logoutConfirm, setLogoutConfirm] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const animationRef = useRef<number | null>(null)
  const bargeInStreamRef = useRef<MediaStream | null>(null)
  const bargeInContextRef = useRef<AudioContext | null>(null)
  const bargeInAnimationRef = useRef<number | null>(null)
  const waitCueContextRef = useRef<AudioContext | null>(null)
  const waitCueTimerRef = useRef<number | null>(null)
  const speechRunRef = useRef(0)
  const requestSequenceRef = useRef(0)
  const activeRequestRef = useRef(0)
  const transcriptListRef = useRef<HTMLDivElement | null>(null)
  const terminalListRef = useRef<HTMLDivElement | null>(null)
  const speechStartedRef = useRef(false)
  const speechActiveRef = useRef(false)
  const speechActiveSinceRef = useRef(0)
  const lastVoiceAtRef = useRef(0)
  const noiseFloorRef = useRef(liveVadConfig.initialNoiseFloor)
  const audioPeakRef = useRef(0)
  const bargeInActiveSinceRef = useRef(0)
  const bargeInNoiseFloorRef = useRef(0.012)

  const recordingRef = useRef(recording)
  const workingRef = useRef(working)
  const speakingRef = useRef(speaking)
  const turnPhaseRef = useRef(turnPhase)
  const liveModeRef = useRef(liveMode)
  const waitCueEnabledRef = useRef(waitCueEnabled)

  const [appSessionId, setAppSessionId] = useState(() => {
    const existing = localStorage.getItem(appSessionStorageKey)
    if (existing) return existing
    const next = createId()
    localStorage.setItem(appSessionStorageKey, next)
    return next
  })

  const activeStageItem = useMemo(() => {
    const activeItems = activity.filter((item) => item.active)
    return (
      activeItems.find((item) => item.kind === 'searching') ??
      activeItems.find((item) => item.kind === 'tools') ??
      activeItems.find((item) => item.kind === 'voice') ??
      activeItems.find((item) => item.kind === 'thinking') ??
      activeItems[0]
    )
  }, [activity])
  const activeStage = activeStageItem?.kind

  useEffect(() => {
    recordingRef.current = recording
    workingRef.current = working
    speakingRef.current = speaking
    turnPhaseRef.current = turnPhase
    liveModeRef.current = liveMode
    waitCueEnabledRef.current = waitCueEnabled
  }, [liveMode, recording, speaking, turnPhase, waitCueEnabled, working])

  useEffect(() => {
    localStorage.setItem(waitCueStorageKey, waitCueEnabled ? 'on' : 'off')
  }, [waitCueEnabled])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHintIndex((current) => (current + 1) % workingHints.length)
    }, 2600)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    async function loadHealth() {
      try {
        const response = await fetch('/api/health')
        if (!response.ok) throw new Error('Health check failed')
        setHealth(await response.json())
      } catch (healthError) {
        setError(healthError instanceof Error ? healthError.message : 'Health check failed')
      }
    }

    void loadHealth()
  }, [])

  useEffect(() => {
    async function loadUsage() {
      try {
        const response = await fetch('/api/codex/usage')
        if (!response.ok) throw new Error('Usage request failed')
        setUsage(await response.json() as CodexUsageStatus)
      } catch {
        setUsage({
          source: 'bridge',
          available: false,
          reason: 'Usage status is unavailable from the local bridge.',
          fiveHour: { label: '5h', status: 'unavailable', remaining: null, resetAt: null },
          weekly: { label: 'Weekly', status: 'unavailable', remaining: null, resetAt: null },
          updatedAt: new Date().toISOString(),
        })
      }
    }

    void loadUsage()
    const timer = window.setInterval(loadUsage, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadSettings = useCallback(async () => {
    const [settingsResponse, sessionsResponse] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/sessions'),
    ])
    if (!settingsResponse.ok) throw new Error('Settings request failed')
    if (!sessionsResponse.ok) throw new Error('Sessions request failed')
    const nextSettings = await settingsResponse.json() as AppSettings
    const nextSessions = await sessionsResponse.json() as SessionsResponse
    setSettingsData(nextSettings)
    setSettingsDraft(createSettingsDraft(nextSettings))
    setSessions(nextSessions.sessions)
    setSpeechSpeed(nextSettings.openrouter.speed)
    setWaitCueEnabled(nextSettings.voice.waitingCueEnabled)
    return nextSettings
  }, [])

  useEffect(() => {
    void loadSettings().catch((settingsError) => {
      setError(settingsError instanceof Error ? settingsError.message : 'Settings request failed')
    })
  }, [loadSettings])

  useEffect(() => {
    const transcriptList = transcriptListRef.current
    if (!transcriptList) return
    const frame = requestAnimationFrame(() => {
      transcriptList.scrollTo({
        top: transcriptList.scrollHeight,
        behavior: 'smooth',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, speaking, transcriptDraft, working])

  useEffect(() => {
    const terminalList = terminalListRef.current
    if (!terminalList) return
    terminalList.scrollTo({
      top: terminalList.scrollHeight,
      behavior: 'smooth',
    })
  }, [terminalLog])

  const cleanupAudioMonitor = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    speechStartedRef.current = false
    speechActiveRef.current = false
    speechActiveSinceRef.current = 0
    audioPeakRef.current = 0
    setVolume(0)
  }, [])

  const cleanupBargeInMonitor = useCallback(() => {
    if (bargeInAnimationRef.current !== null) {
      cancelAnimationFrame(bargeInAnimationRef.current)
      bargeInAnimationRef.current = null
    }
    bargeInContextRef.current?.close().catch(() => undefined)
    bargeInContextRef.current = null
    bargeInStreamRef.current?.getTracks().forEach((track) => track.stop())
    bargeInStreamRef.current = null
    bargeInActiveSinceRef.current = 0
  }, [])

  const stopWaitCue = useCallback(() => {
    if (waitCueTimerRef.current !== null) {
      window.clearInterval(waitCueTimerRef.current)
      waitCueTimerRef.current = null
    }
    waitCueContextRef.current?.close().catch(() => undefined)
    waitCueContextRef.current = null
  }, [])

  const playWaitCuePulse = useCallback((audioContext: AudioContext) => {
    const now = audioContext.currentTime
    const notes = [
      { frequency: 392, offset: 0, peak: 0.012, duration: 0.72 },
      { frequency: 523.25, offset: 0.38, peak: 0.008, duration: 0.82 },
    ]
    for (const note of notes) {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      const filter = audioContext.createBiquadFilter()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, now + note.offset)
      oscillator.frequency.exponentialRampToValueAtTime(note.frequency * 0.985, now + note.offset + note.duration)
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(1400, now + note.offset)
      gain.gain.setValueAtTime(0.0001, now + note.offset)
      gain.gain.linearRampToValueAtTime(note.peak, now + note.offset + 0.16)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.offset + note.duration)
      oscillator.connect(filter)
      filter.connect(gain)
      gain.connect(audioContext.destination)
      oscillator.start(now + note.offset)
      oscillator.stop(now + note.offset + note.duration + 0.05)
    }
  }, [])

  const startWaitCue = useCallback(() => {
    if (!waitCueEnabledRef.current || waitCueTimerRef.current !== null) return
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext }
    const AudioContextCtor = window.AudioContext ?? audioWindow.webkitAudioContext
    if (!AudioContextCtor) return

    const audioContext = new AudioContextCtor()
    waitCueContextRef.current = audioContext
    const tick = () => {
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => undefined)
      }
      playWaitCuePulse(audioContext)
    }
    tick()
    waitCueTimerRef.current = window.setInterval(tick, 2600)
  }, [playWaitCuePulse])

  useEffect(() => {
    if (waitCueEnabled && turnPhase === 'codex' && !recording && !speaking) {
      startWaitCue()
      return stopWaitCue
    }

    stopWaitCue()
    return undefined
  }, [recording, speaking, startWaitCue, stopWaitCue, turnPhase, waitCueEnabled])

  useEffect(() => {
    return () => {
      stopWaitCue()
      cleanupBargeInMonitor()
      cleanupAudioMonitor()
    }
  }, [cleanupAudioMonitor, cleanupBargeInMonitor, stopWaitCue])

  const stopPlayback = useCallback((cancelQueue = true) => {
    if (cancelQueue) speechRunRef.current += 1
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    setSpeaking(false)
  }, [])

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [])

  const cancelCurrentCodexTurn = useCallback((reason: string) => {
    if (!abortRef.current && !workingRef.current && turnPhaseRef.current !== 'codex') return
    requestSequenceRef.current += 1
    activeRequestRef.current = requestSequenceRef.current
    abortRef.current?.abort()
    abortRef.current = null
    stopPlayback(true)
    stopWaitCue()
    setWorking(false)
    addTerminal(setTerminalLog, {
      level: 'info',
      text: reason,
    })
    addActivity(setActivity, {
      kind: 'voice',
      title: 'Correction started',
      detail: 'The previous Codex turn was cancelled and the next voice turn will replace it.',
      status: 'active',
      source: 'voice',
      active: true,
    })
  }, [stopPlayback, stopWaitCue])

  const startAudioMonitor = useCallback((stream: MediaStream, autoStop: boolean) => {
    const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext }
    const AudioContextCtor = window.AudioContext ?? audioWindow.webkitAudioContext
    if (!AudioContextCtor) return

    const audioContext = new AudioContextCtor()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    const source = audioContext.createMediaStreamSource(stream)
    const data = new Uint8Array(analyser.fftSize)
    const startedAt = performance.now()

    source.connect(analyser)
    audioContextRef.current = audioContext
    speechStartedRef.current = false
    speechActiveRef.current = false
    speechActiveSinceRef.current = 0
    lastVoiceAtRef.current = performance.now()
    noiseFloorRef.current = liveVadConfig.initialNoiseFloor
    audioPeakRef.current = 0

    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const sample of data) {
        const centered = (sample - 128) / 128
        sum += centered * centered
      }
      const rms = Math.sqrt(sum / data.length)
      const now = performance.now()
      const noiseFloor = noiseFloorRef.current
      const voiceThreshold = Math.max(liveVadConfig.minVoiceThreshold, noiseFloor * liveVadConfig.voiceMultiplier)
      const releaseThreshold = Math.max(
        liveVadConfig.minReleaseThreshold,
        Math.min(voiceThreshold * 0.72, noiseFloor * liveVadConfig.releaseMultiplier),
      )
      const normalized = Math.min(1, Math.max(0, (rms - noiseFloor * 0.8) * 18))
      audioPeakRef.current = Math.max(audioPeakRef.current, normalized)
      setVolume((current) => current * 0.72 + normalized * 0.28)

      const voiceDetected = speechActiveRef.current ? rms > releaseThreshold : rms > voiceThreshold

      if (!speechStartedRef.current && !speechActiveRef.current && !voiceDetected) {
        const adaptingFast = now - startedAt < 700
        noiseFloorRef.current = Math.min(
          liveVadConfig.maxNoiseFloor,
          Math.max(
            liveVadConfig.minNoiseFloor,
            noiseFloor * (adaptingFast ? 0.82 : 0.96) + rms * (adaptingFast ? 0.18 : 0.04),
          ),
        )
      }

      if (voiceDetected) {
        if (!speechActiveRef.current) {
          speechActiveRef.current = true
          speechActiveSinceRef.current = now
        }
        if (!speechStartedRef.current && now - speechActiveSinceRef.current >= liveTurnConfig.minSpeechMs) {
          speechStartedRef.current = true
          addTerminal(setTerminalLog, {
            level: 'info',
            text: 'speech detected',
          })
        }
        lastVoiceAtRef.current = now
      } else {
        speechActiveRef.current = false
        speechActiveSinceRef.current = 0
      }

      if (
        autoStop &&
        speechStartedRef.current &&
        now - lastVoiceAtRef.current > liveTurnConfig.endSilenceMs &&
        now - startedAt > liveTurnConfig.minRecordingMs
      ) {
        stopRecording()
        return
      }

      if (autoStop && !speechStartedRef.current && now - startedAt > liveTurnConfig.noSpeechTimeoutMs) {
        stopRecording()
        return
      }

      if (autoStop && now - startedAt > liveTurnConfig.maxTurnMs) {
        stopRecording()
        return
      }

      animationRef.current = requestAnimationFrame(tick)
    }

    tick()
  }, [stopRecording])

  const playAudioPayload = useCallback((payload: AudioPayload, runId: number) => {
    return new Promise<void>((resolve, reject) => {
      if (speechRunRef.current !== runId) {
        resolve()
        return
      }

      const audio = new Audio(`data:${payload.mimeType};base64,${payload.audioBase64}`)
      audioRef.current = audio
      setSpeaking(true)
      setTurnPhase('speaking')
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('Audio playback failed'))
      void audio.play().catch(reject)
    })
  }, [])

  const synthesizeChunk = useCallback(async (text: string) => {
    const response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speed: speechSpeed }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error ?? 'Speech generation failed')
    return payload as AudioPayload
  }, [speechSpeed])

  const speak = useCallback(async (text: string) => {
    const chunks = splitSpeechChunks(text)
    if (!chunks.length) return

    const runId = speechRunRef.current + 1
    speechRunRef.current = runId

    try {
      addActivity(setActivity, {
        kind: 'voice',
        title: 'Preparing speech',
        detail: `Generating ${chunks.length} short voice chunk${chunks.length === 1 ? '' : 's'} so playback can start sooner.`,
        active: true,
      })

      let current = await synthesizeChunk(chunks[0])
      let next = chunks[1] ? synthesizeChunk(chunks[1]) : null

      for (let index = 0; index < chunks.length; index += 1) {
        if (speechRunRef.current !== runId) break
        if (index > 0 && next) current = await next
        next = chunks[index + 1] ? synthesizeChunk(chunks[index + 1]) : null
        await playAudioPayload(current, runId)
      }
    } catch (speechError) {
      if (speechRunRef.current === runId) {
        addActivity(setActivity, {
          kind: 'error',
          title: 'Speech failed',
          detail: speechError instanceof Error ? speechError.message : 'Speech generation failed',
        })
      }
    } finally {
      if (speechRunRef.current === runId) {
        setSpeaking(false)
      }
    }
  }, [playAudioPayload, synthesizeChunk])

  const interrupt = useCallback(() => {
    requestSequenceRef.current += 1
    activeRequestRef.current = requestSequenceRef.current
    abortRef.current?.abort()
    abortRef.current = null
    stopPlayback(true)
    stopRecording()
    cleanupAudioMonitor()
    cleanupBargeInMonitor()
    stopWaitCue()
    setRecording(false)
    setWorking(false)
    setTurnPhase('idle')
    addActivity(setActivity, {
      kind: 'system',
      title: 'Interrupted',
      detail: 'The current voice or Codex request was stopped locally.',
    })
    addTerminal(setTerminalLog, {
      level: 'info',
      text: 'interrupt requested',
    })
  }, [cleanupAudioMonitor, cleanupBargeInMonitor, stopPlayback, stopRecording, stopWaitCue])

  const handleCodexStream = useCallback(async (text: string, requestId: number) => {
    const controller = new AbortController()
    abortRef.current = controller
    setWorking(true)
    setTurnPhase('codex')
    addActivity(setActivity, {
      kind: 'thinking',
      title: 'Starting Codex',
      detail: 'Sending the transcript to the local CLI bridge.',
      active: true,
    })

    const response = await fetch('/api/codex/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appSessionId,
        mode: 'talk' satisfies ModeId,
        text,
      }),
      signal: controller.signal,
    })

    if (!response.body) throw new Error('Codex stream did not start')
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'Codex request failed' }))
      throw new Error(payload.error ?? 'Codex request failed')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalText = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        if (activeRequestRef.current !== requestId) return
        const event = JSON.parse(line) as CodexStreamEvent
        if (event.type === 'activity') {
          addActivity(setActivity, {
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            status: event.status,
            source: event.source,
            eventId: event.eventId,
            label: event.label,
            preview: event.preview,
            active: true,
          })
        }
        if (event.type === 'terminal') {
          addTerminal(setTerminalLog, {
            level: event.level,
            text: event.text,
          })
        }
        if (event.type === 'final') {
          finalText = event.text
        }
        if (event.type === 'error') {
          throw new Error(event.message)
        }
      }
    }

    if (activeRequestRef.current !== requestId) return
    if (!finalText.trim()) throw new Error('Codex returned an empty response')

    setMessages((current) => [
      ...current,
      {
        id: createId(),
        role: 'assistant',
        text: finalText,
        createdAt: getTimeLabel(),
      },
    ])
    addActivity(setActivity, {
      kind: 'system',
      title: 'Answer ready',
      detail: 'Codex returned the final message; short voice chunks are queued.',
    })
    setTurnPhase('speaking')
    await speak(finalText)
  }, [appSessionId, speak])

  const sendAudio = useCallback(async (blob: Blob) => {
    const requestId = requestSequenceRef.current + 1
    requestSequenceRef.current = requestId
    activeRequestRef.current = requestId
    setError(null)
    setWorking(true)
    setTurnPhase('transcribing')

    try {
      addActivity(setActivity, {
        kind: 'voice',
        title: 'Transcribing',
        detail: 'Sending recorded audio to OpenRouter transcription.',
        active: true,
      })
      const audioBase64 = await blobToBase64(blob)
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType: blob.type || 'audio/webm',
          fileName: 'voice-message.webm',
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Transcription failed')

      const text = String(payload.text ?? '').trim()
      if (!text) throw new Error('No speech was transcribed')
      setTranscriptDraft(text)
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'user',
          text,
          createdAt: getTimeLabel(),
        },
      ])
      addTerminal(setTerminalLog, {
        level: 'info',
        text: `transcribed ${text.split(/\s+/).length} words`,
      })
      await handleCodexStream(text, requestId)
    } catch (sendError) {
      if (activeRequestRef.current !== requestId) return
      if (sendError instanceof DOMException && sendError.name === 'AbortError') return
      const message = sendError instanceof Error ? sendError.message : 'Voice request failed'
      setError(message)
      addActivity(setActivity, {
        kind: 'error',
        title: 'Request failed',
        detail: message,
      })
    } finally {
      if (activeRequestRef.current === requestId) {
        setWorking(false)
        abortRef.current = null
        setTurnPhase(recordingRef.current ? 'recording' : 'idle')
      }
    }
  }, [handleCodexStream])

  const startRecording = useCallback(async (options?: RecordingOptions) => {
    if (recordingRef.current) return
    const shouldReplaceCurrentTurn = Boolean(options?.replaceCurrentTurn)
    if (!options?.allowDuringPlayback && (workingRef.current || speakingRef.current) && !shouldReplaceCurrentTurn) return
    if (shouldReplaceCurrentTurn) {
      cancelCurrentCodexTurn('correction requested; cancelling current Codex turn')
    }
    setError(null)
    stopPlayback(false)
    stopWaitCue()

    try {
      const autoStop = Boolean(options?.autoStop)
      const stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints())
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      streamRef.current = stream
      chunksRef.current = []
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        const hadSpeech = speechStartedRef.current
        const peakVolume = audioPeakRef.current
        const shouldUseAudioFallback =
          autoStop &&
          !hadSpeech &&
          blob.size >= liveVadConfig.fallbackMinBytes &&
          peakVolume >= liveVadConfig.fallbackMinPeak
        chunksRef.current = []
        cleanupAudioMonitor()
        recordingRef.current = false
        setRecording(false)
        addTerminal(setTerminalLog, {
          level: 'info',
          text: [
            `captured audio ${Math.round(blob.size / 1024)}kb`,
            `speech=${hadSpeech ? 'yes' : 'no'}`,
            `peak=${peakVolume.toFixed(2)}`,
          ].join(', '),
        })
        if (blob.size > 240 && (!autoStop || hadSpeech || shouldUseAudioFallback)) {
          if (shouldUseAudioFallback) {
            addTerminal(setTerminalLog, {
              level: 'info',
              text: 'sending live segment by audio fallback',
            })
          }
          void sendAudio(blob)
          return
        }

        if (autoStop) {
          addTerminal(setTerminalLog, {
            level: 'info',
            text: 'ignored live segment without detected speech',
          })
        }
        setTurnPhase(workingRef.current ? 'codex' : 'idle')
      }
      recorder.start(250)
      recordingRef.current = true
      setRecording(true)
      setTurnPhase('recording')
      startAudioMonitor(stream, autoStop)
      addActivity(setActivity, {
        kind: 'voice',
        title: autoStop ? 'Live listening' : 'Listening',
        detail: autoStop ? 'Live Mode will send the turn after a short silence.' : 'Hold the button while speaking. Release to send.',
        active: true,
      })
      addTerminal(setTerminalLog, {
        level: 'info',
        text: autoStop ? 'live listening started' : 'push-to-talk recording started',
      })
    } catch (recordingError) {
      cleanupAudioMonitor()
      setTurnPhase(workingRef.current ? 'codex' : 'idle')
      const message = recordingError instanceof Error ? recordingError.message : 'Microphone access failed'
      setError(message)
      addActivity(setActivity, {
        kind: 'error',
        title: 'Microphone blocked',
        detail: message,
      })
    }
  }, [cancelCurrentCodexTurn, cleanupAudioMonitor, sendAudio, startAudioMonitor, stopPlayback, stopWaitCue])

  const startBargeInMonitor = useCallback(async () => {
    if (
      bargeInStreamRef.current ||
      recordingRef.current ||
      !liveModeRef.current ||
      (!speakingRef.current && turnPhaseRef.current !== 'codex')
    ) {
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints())
      const audioWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext }
      const AudioContextCtor = window.AudioContext ?? audioWindow.webkitAudioContext
      if (!AudioContextCtor) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      const source = audioContext.createMediaStreamSource(stream)
      const data = new Uint8Array(analyser.fftSize)
      const startedAt = performance.now()
      bargeInStreamRef.current = stream
      bargeInContextRef.current = audioContext
      bargeInNoiseFloorRef.current = 0.012
      bargeInActiveSinceRef.current = 0
      source.connect(analyser)

      const tick = () => {
        const monitoringPlayback = speakingRef.current
        const monitoringCodex = turnPhaseRef.current === 'codex'
        if (!liveModeRef.current || recordingRef.current || (!monitoringPlayback && !monitoringCodex)) {
          cleanupBargeInMonitor()
          return
        }

        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const sample of data) {
          const centered = (sample - 128) / 128
          sum += centered * centered
        }

        const rms = Math.sqrt(sum / data.length)
        const now = performance.now()
        if (now - startedAt < 900) {
          bargeInNoiseFloorRef.current = Math.min(
            0.06,
            Math.max(0.006, bargeInNoiseFloorRef.current * 0.9 + rms * 0.1),
          )
        }

        const threshold = Math.max(
          bargeInConfig.minThreshold,
          bargeInNoiseFloorRef.current * bargeInConfig.noiseMultiplier,
        )
        if (rms > threshold) {
          if (!bargeInActiveSinceRef.current) bargeInActiveSinceRef.current = now
          if (now - bargeInActiveSinceRef.current >= bargeInConfig.holdMs) {
            addTerminal(setTerminalLog, {
              level: 'info',
              text: monitoringPlayback ? 'barge-in detected; cutting playback' : 'correction speech detected; cancelling Codex',
            })
            if (monitoringPlayback) {
              stopPlayback(true)
            } else {
              cancelCurrentCodexTurn('correction speech detected; cancelling current Codex turn')
            }
            cleanupBargeInMonitor()
            void startRecording({ autoStop: true, allowDuringPlayback: true })
            return
          }
        } else {
          bargeInActiveSinceRef.current = 0
        }

        bargeInAnimationRef.current = requestAnimationFrame(tick)
      }

      tick()
    } catch {
      cleanupBargeInMonitor()
      addTerminal(setTerminalLog, {
        level: 'error',
        text: 'barge-in monitor unavailable',
      })
    }
  }, [cancelCurrentCodexTurn, cleanupBargeInMonitor, startRecording, stopPlayback])

  useEffect(() => {
    if (liveMode && !recording && (speaking || turnPhase === 'codex')) {
      void startBargeInMonitor()
      return cleanupBargeInMonitor
    }

    cleanupBargeInMonitor()
    return undefined
  }, [cleanupBargeInMonitor, liveMode, recording, speaking, startBargeInMonitor, turnPhase])

  useEffect(() => {
    if (!liveMode || recording || speaking || turnPhase !== 'idle') return undefined
    const timer = window.setTimeout(() => {
      void startRecording({ autoStop: true })
    }, 550)
    return () => window.clearTimeout(timer)
  }, [liveMode, recording, speaking, startRecording, turnPhase])

  const toggleLiveMode = useCallback(() => {
    setLiveMode((current) => {
      const next = !current
      if (!next) {
        stopRecording()
        stopPlayback(true)
        cleanupBargeInMonitor()
        stopWaitCue()
        if (!workingRef.current) setTurnPhase('idle')
      }
      return next
    })
  }, [cleanupBargeInMonitor, stopPlayback, stopRecording, stopWaitCue])

  const saveSettings = useCallback(async (draft = settingsDraft) => {
    setSettingsSaving(true)
    setSettingsMessage(null)
    try {
      const payload = {
        openrouter: {
          apiKey: draft.openrouter.apiKey,
          sttModel: draft.openrouter.sttModel,
          sttLanguage: draft.openrouter.sttLanguage,
          ttsModel: draft.openrouter.ttsModel,
          voice: draft.openrouter.voice,
          speed: draft.openrouter.speed,
        },
        voice: {
          waitingCueEnabled: draft.voice.waitingCueEnabled,
        },
        codex: {
          model: draft.codex.model,
          reasoningEffort: draft.codex.reasoningEffort,
          modePreset: draft.codex.modePreset,
          searchEnabled: draft.codex.searchEnabled,
          workspace: draft.codex.workspace,
        },
      }
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const nextSettings = await response.json()
      if (!response.ok) throw new Error(nextSettings.error ?? 'Settings save failed')
      setSettingsData(nextSettings)
      setSettingsDraft(createSettingsDraft(nextSettings))
      setSpeechSpeed(nextSettings.openrouter.speed)
      setWaitCueEnabled(nextSettings.voice.waitingCueEnabled)
      setSettingsMessage('Settings saved')
      await loadSettings()
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Settings save failed'
      setSettingsMessage(message)
      throw saveError
    } finally {
      setSettingsSaving(false)
    }
  }, [loadSettings, settingsDraft])

  const toggleWaitCue = useCallback(() => {
    setWaitCueEnabled((current) => {
      const next = !current
      setSettingsDraft((draft) => ({
        ...draft,
        voice: { ...draft.voice, waitingCueEnabled: next },
      }))
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: { waitingCueEnabled: next } }),
      }).then(() => loadSettings()).catch(() => undefined)
      return next
    })
  }, [loadSettings])

  const selectSession = useCallback((nextAppSessionId: string) => {
    localStorage.setItem(appSessionStorageKey, nextAppSessionId)
    setAppSessionId(nextAppSessionId)
    setMessages([])
    setTranscriptDraft('')
    setSettingsMessage('Session selected')
  }, [])

  const createNewSession = useCallback(() => {
    const next = createId()
    localStorage.setItem(appSessionStorageKey, next)
    setAppSessionId(next)
    setMessages([])
    setTranscriptDraft('')
    setSettingsMessage('New local session ready')
  }, [])

  const logoutCodex = useCallback(async () => {
    if (!logoutConfirm) {
      setLogoutConfirm(true)
      setSettingsMessage('Press Logout again to confirm')
      return
    }
    setSettingsSaving(true)
    try {
      const response = await fetch('/api/codex/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'logout' }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Codex logout failed')
      setSettingsMessage('Codex logout complete')
      setLogoutConfirm(false)
    } catch (logoutError) {
      setSettingsMessage(logoutError instanceof Error ? logoutError.message : 'Codex logout failed')
    } finally {
      setSettingsSaving(false)
    }
  }, [logoutConfirm])

  const statusCards = useMemo(() => [
    {
      label: 'Local only',
      value: health?.server.localOnly ? '127.0.0.1' : 'Check host',
      good: health?.server.localOnly ?? true,
    },
    {
      label: 'Codex connected',
      value: health?.codex.available ? health.codex.version ?? 'ready' : 'missing',
      good: health?.codex.available ?? false,
    },
    {
      label: 'OpenRouter voice',
      value: health?.openrouter.configured ? 'configured' : 'needs key',
      good: health?.openrouter.configured ?? false,
    },
  ], [health])

  const visualVolume = recording ? Math.min(0.5, volume * 0.5) : speaking ? 0.28 : turnPhase === 'codex' ? 0.18 : 0.06
  const orbStyle = {
    '--orb-volume': visualVolume.toFixed(3),
  } as CSSProperties

  const currentStatus =
    turnPhase === 'recording'
      ? liveMode
        ? 'Listening naturally'
        : 'Listening now'
      : turnPhase === 'transcribing'
        ? 'Transcribing your voice'
        : turnPhase === 'codex'
          ? activeStageItem?.detail ?? workingHints[hintIndex]
          : turnPhase === 'speaking'
            ? 'Speaking in short chunks'
            : liveMode
              ? 'Live Mode is ready'
              : 'Ready for a live Codex session'
  const canCorrectCodex = turnPhase === 'codex' && !recording && !speaking
  const talkDisabled = recording || speaking || turnPhase === 'transcribing' || (liveMode && !canCorrectCodex)
  const talkLabel = canCorrectCodex ? 'Correct' : 'Hold to speak'
  const orbClassName = [
    'live-orb',
    turnPhase === 'recording' ? 'recording' : '',
    turnPhase === 'transcribing' ? 'transcribing' : '',
    turnPhase === 'codex' ? 'working' : '',
    turnPhase === 'speaking' ? 'speaking' : '',
    activeStage === 'searching' ? 'searching' : '',
    activeStage === 'tools' ? 'tools' : '',
  ].filter(Boolean).join(' ')

  const activeSession = sessions.find((session) => session.appSessionId === appSessionId)
  const fiveHourUsage = usage?.fiveHour.remaining || 'Unavailable'
  const weeklyUsage = usage?.weekly.remaining || 'Unavailable'
  const usageUpdated = formatUsageUpdated(usage?.updatedAt)
  const usageTooltip = usage?.reason || 'Checking Codex usage availability.'

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="Voice assistant workspace">
        <header className="top-bar">
          <div className="brand-title">
            <div className="brand-mark">
              <Waves aria-hidden="true" />
              <span>CL</span>
            </div>
            <div>
              <h1>Codex Live Assistant Mode</h1>
              <p>Local voice bridge for Codex CLI</p>
            </div>
          </div>
          <div className="usage-card" title={usageTooltip} aria-label="Codex usage status">
            <div className="usage-card-heading">
              <span>Codex usage</span>
              <strong>{usage?.available ? 'Live' : 'Best effort'}</strong>
            </div>
            <div className="usage-metrics">
              <div>
                <span>5h</span>
                <strong>{fiveHourUsage}</strong>
              </div>
              <div>
                <span>Weekly</span>
                <strong>{weeklyUsage}</strong>
              </div>
            </div>
            <small>Updated {usageUpdated}</small>
          </div>
          <div className="status-row" aria-label="Connection status">
            {statusCards.map((card) => (
              <div className={card.good ? 'status-card ok' : 'status-card warn'} key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </div>
            ))}
            <button className="icon-button" onClick={() => setSettingsOpen(true)} type="button" aria-label="Settings">
              <Settings aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="content-grid">
          <aside className="terminal-panel" aria-label="Terminal events">
            <div className="panel-heading">
              <div>
                <span>Terminal</span>
                <strong>{terminalLog.length ? `${terminalLog.length} events` : 'Idle'}</strong>
              </div>
              <Terminal aria-hidden="true" />
            </div>
            <div className="terminal-list" ref={terminalListRef}>
              {terminalLog.map((entry) => (
                <article className={`terminal-line ${entry.level}`} key={entry.id}>
                  <time>{entry.time}</time>
                  <code>{entry.text}</code>
                </article>
              ))}
            </div>
          </aside>

          <section className="voice-stage" aria-label="Voice controls">
            <div className={orbClassName} style={orbStyle}>
              <div className="orb-field orb-field-one" />
              <div className="orb-field orb-field-two" />
              <div className="aura aura-one" />
              <div className="aura aura-two" />
              <div className="orbital orbital-one" />
              <div className="orbital orbital-two" />
              <div className="liquid-core">
                <span className="liquid-glow" />
                {turnPhase === 'codex' || turnPhase === 'transcribing' ? <Loader2 aria-hidden="true" /> : <Mic aria-hidden="true" />}
              </div>
            </div>

            <div className="voice-copy">
              <p>{currentStatus}</p>
              <strong>{recording ? 'Speak naturally' : canCorrectCodex ? 'Say the correction' : liveMode ? 'Live mode' : 'Hold to speak'}</strong>
            </div>

            <div className="control-row">
              <button
                className={liveMode ? 'live-button active' : 'live-button'}
                onClick={toggleLiveMode}
                type="button"
              >
                <Zap aria-hidden="true" />
                {liveMode ? 'Live mode on' : 'Live mode'}
              </button>
              <button
                className="talk-button"
                disabled={talkDisabled}
                onPointerDown={() => void startRecording({ autoStop: false, allowDuringPlayback: canCorrectCodex, replaceCurrentTurn: canCorrectCodex })}
                onPointerLeave={stopRecording}
                onPointerUp={stopRecording}
                type="button"
              >
                <Mic aria-hidden="true" />
                {talkLabel}
              </button>
              <button
                className="secondary-button"
                disabled={!working && !speaking && !recording}
                onClick={interrupt}
                type="button"
              >
                <CircleStop aria-hidden="true" />
                Interrupt
              </button>
            </div>

            <div className="voice-control-band">
              <label className="speed-control">
                <span>
                  <SlidersHorizontal aria-hidden="true" />
                  Voice speed
                </span>
                <input
                  min="0.85"
                  max="1.25"
                  step="0.05"
                  type="range"
                  value={speechSpeed}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setSpeechSpeed(next)
                    setSettingsDraft((draft) => ({
                      ...draft,
                      openrouter: { ...draft.openrouter, speed: next },
                    }))
                  }}
                />
                <strong>{speechSpeed.toFixed(2)}x</strong>
              </label>

              <button
                aria-pressed={waitCueEnabled}
                className={waitCueEnabled ? 'cue-toggle active' : 'cue-toggle'}
                onClick={toggleWaitCue}
                type="button"
              >
                <Volume2 aria-hidden="true" />
                <span>Cue</span>
                <strong>{waitCueEnabled ? 'On' : 'Off'}</strong>
              </button>
            </div>

            {error ? <p className="error-banner">{error}</p> : null}
          </section>

          <aside className="activity-panel" aria-label="Activity feed">
            <div className="panel-heading">
              <div>
                <span>Activity Feed</span>
                <strong>{turnPhase === 'idle' ? 'Idle' : 'Live'}</strong>
              </div>
              <Activity aria-hidden="true" />
            </div>
            <div className="stage-list">
              {activityStages.map((stage) => {
                const Icon = stage.icon
                const active = activeStage === stage.kind
                return (
                  <article className={active ? `stage-card ${stage.kind} active` : `stage-card ${stage.kind}`} key={stage.kind}>
                    <div className="stage-icon">
                      <Icon aria-hidden="true" />
                    </div>
                    <div>
                      <header>
                        <strong>{stage.title}</strong>
                        <span className="progress-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      </header>
                      <p>{active ? activeStageItem?.detail ?? stage.detail : stage.detail}</p>
                    </div>
                  </article>
                )
              })}
            </div>
            <div className="activity-list">
              {activity.map((item) => (
                <article className={`activity-item ${item.kind} ${item.active ? 'active' : ''}`} key={item.id}>
                  <span className="activity-dot" />
                  <div>
                    <header>
                      <strong>{item.label ? `${item.title} · ${item.label}` : item.title}</strong>
                      <time>{item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : item.time}</time>
                    </header>
                    <p>{item.detail}</p>
                    {item.preview ? <code>{item.preview}</code> : null}
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>

        <section className="transcript-panel" aria-label="Live transcript">
          <div className="panel-heading">
            <div>
              <span>Live transcript</span>
              <strong>{messages.length ? `${messages.length} messages` : 'No messages yet'}</strong>
            </div>
            <div className="audio-state">
              <Radio aria-hidden="true" />
              {turnPhase === 'speaking' ? 'Speaking' : turnPhase === 'codex' ? 'Thinking' : transcriptDraft ? 'Ready' : 'Waiting'}
            </div>
          </div>
          <div className="transcript-list" ref={transcriptListRef}>
            {messages.length === 0 ? (
              <p className="empty-state">
                Start with a short voice note. The first response creates a persistent local Codex session.
              </p>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <header>
                    <span>{message.role === 'user' ? 'You' : 'Codex'}</span>
                    <time>{message.createdAt}</time>
                  </header>
                  <p>{message.text}</p>
                </article>
              ))
            )}
          </div>
          <div className="audio-controls">
            <Volume2 aria-hidden="true" />
            <span>{health?.openrouter.ttsModel ?? 'TTS model not checked'}</span>
          </div>
        </section>

        {settingsOpen ? (
          <div className="modal-backdrop" role="presentation">
            <section className="settings-modal" aria-label="Settings" role="dialog" aria-modal="true">
              <header className="settings-header">
                <div>
                  <span>Local settings</span>
                  <h2>Settings</h2>
                </div>
                <button className="icon-button" onClick={() => setSettingsOpen(false)} type="button" aria-label="Close settings">
                  <X aria-hidden="true" />
                </button>
              </header>

              <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                {(['voice', 'codex', 'sessions', 'auth'] as SettingsTab[]).map((tab) => (
                  <button
                    className={settingsTab === tab ? 'settings-tab active' : 'settings-tab'}
                    key={tab}
                    onClick={() => setSettingsTab(tab)}
                    type="button"
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <div className="settings-body">
                {settingsTab === 'voice' ? (
                  <div className="settings-grid">
                    <label>
                      <span>OpenRouter API key</span>
                      <input
                        autoComplete="off"
                        placeholder={settingsData?.openrouter.configured ? 'Configured. Leave blank to keep it.' : 'sk-or-v1-...'}
                        type="password"
                        value={settingsDraft.openrouter.apiKey}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, apiKey: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>Speech-to-text model</span>
                      <input
                        value={settingsDraft.openrouter.sttModel}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, sttModel: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>STT language</span>
                      <input
                        placeholder="Optional"
                        value={settingsDraft.openrouter.sttLanguage}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, sttLanguage: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>Text-to-speech model</span>
                      <input
                        value={settingsDraft.openrouter.ttsModel}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, ttsModel: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>TTS voice</span>
                      <input
                        value={settingsDraft.openrouter.voice}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, voice: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>TTS speed</span>
                      <input
                        max="1.5"
                        min="0.5"
                        step="0.05"
                        type="number"
                        value={settingsDraft.openrouter.speed}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          openrouter: { ...draft.openrouter, speed: Number(event.target.value) },
                        }))}
                      />
                    </label>
                    <label className="setting-check">
                      <input
                        checked={settingsDraft.voice.waitingCueEnabled}
                        type="checkbox"
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          voice: { ...draft.voice, waitingCueEnabled: event.target.checked },
                        }))}
                      />
                      <span>Waiting cue enabled</span>
                    </label>
                  </div>
                ) : null}

                {settingsTab === 'codex' ? (
                  <div className="settings-grid">
                    <label>
                      <span>Codex model</span>
                      <input
                        value={settingsDraft.codex.model}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          codex: { ...draft.codex, model: event.target.value },
                        }))}
                      />
                    </label>
                    <label>
                      <span>Thinking effort</span>
                      <select
                        value={settingsDraft.codex.reasoningEffort}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          codex: { ...draft.codex, reasoningEffort: event.target.value as ReasoningEffort },
                        }))}
                      >
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="xhigh">xhigh</option>
                      </select>
                    </label>
                    <label>
                      <span>Mode preset</span>
                      <select
                        value={settingsDraft.codex.modePreset}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          codex: { ...draft.codex, modePreset: event.target.value as ModePreset },
                        }))}
                      >
                        <option value="fast">Fast</option>
                        <option value="normal">Normal</option>
                        <option value="deep">Deep</option>
                      </select>
                    </label>
                    <label>
                      <span>Workspace path</span>
                      <input
                        value={settingsDraft.codex.workspace}
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          codex: { ...draft.codex, workspace: event.target.value },
                        }))}
                      />
                    </label>
                    <label className="setting-check">
                      <input
                        checked={settingsDraft.codex.searchEnabled}
                        type="checkbox"
                        onChange={(event) => setSettingsDraft((draft) => ({
                          ...draft,
                          codex: { ...draft.codex, searchEnabled: event.target.checked },
                        }))}
                      />
                      <span>Enable Codex web search</span>
                    </label>
                    {settingsData?.codex.workspaceWarning ? (
                      <p className="settings-note">{settingsData.codex.workspaceWarning}</p>
                    ) : null}
                  </div>
                ) : null}

                {settingsTab === 'sessions' ? (
                  <div className="settings-list">
                    <button className="secondary-button" onClick={createNewSession} type="button">
                      <FolderOpen aria-hidden="true" />
                      New app session
                    </button>
                    <p className="settings-note">Current session: {activeSession?.codexSessionId ?? appSessionId}</p>
                    {sessions.length ? sessions.map((session) => (
                      <article className={session.appSessionId === appSessionId ? 'session-row active' : 'session-row'} key={session.appSessionId}>
                        <div>
                          <strong>{session.codexSessionId ? `Codex ${session.codexSessionId.slice(0, 8)}...` : 'Unlinked session'}</strong>
                          <span>{session.turns} turns · {session.workspace ?? settingsData?.codex.workspace ?? 'default workspace'}</span>
                        </div>
                        <button onClick={() => selectSession(session.appSessionId)} type="button">Use</button>
                      </article>
                    )) : <p className="settings-note">No saved app sessions yet.</p>}
                  </div>
                ) : null}

                {settingsTab === 'auth' ? (
                  <div className="settings-list">
                    <article className="auth-card">
                      <ShieldCheck aria-hidden="true" />
                      <div>
                        <strong>{health?.codex.available ? 'Codex CLI available' : 'Codex CLI missing'}</strong>
                        <span>{health?.codex.version ?? health?.codex.error ?? 'Run codex login in your terminal.'}</span>
                      </div>
                    </article>
                    <article className="auth-card">
                      <KeyRound aria-hidden="true" />
                      <div>
                        <strong>{settingsData?.openrouter.configured ? 'OpenRouter key configured' : 'OpenRouter key missing'}</strong>
                        <span>Secrets are stored locally and never echoed back by the API.</span>
                      </div>
                    </article>
                    <button className={logoutConfirm ? 'danger-button armed' : 'danger-button'} disabled={settingsSaving} onClick={() => void logoutCodex()} type="button">
                      <LogOut aria-hidden="true" />
                      {logoutConfirm ? 'Confirm Codex logout' : 'Logout Codex'}
                    </button>
                  </div>
                ) : null}
              </div>

              <footer className="settings-footer">
                <span>{settingsMessage ?? 'Settings are stored under .local/settings.json'}</span>
                <button className="live-button active" disabled={settingsSaving} onClick={() => void saveSettings().catch(() => undefined)} type="button">
                  <Save aria-hidden="true" />
                  {settingsSaving ? 'Saving' : 'Save settings'}
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  )
}
