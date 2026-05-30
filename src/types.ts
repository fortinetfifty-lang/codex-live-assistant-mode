export type ModeId = 'talk' | 'research' | 'code' | 'deep-think'

export type HealthStatus = {
  server: {
    host: string
    port: number
    localOnly: boolean
  }
  codex: {
    available: boolean
    version?: string
    error?: string
  }
  openrouter: {
    configured: boolean
    sttModel: string
    ttsModel: string
    voice: string
    speed?: number
  }
  settings?: {
    codex: {
      model: string
      reasoningEffort: ReasoningEffort
      modePreset: ModePreset
      searchEnabled: boolean
      workspace: string
      workspaceExists: boolean
    }
    voice: {
      waitingCueEnabled: boolean
    }
  }
}

export type ActivityKind = 'thinking' | 'searching' | 'tools' | 'voice' | 'terminal' | 'system' | 'error'
export type ActivityStatus = 'active' | 'done' | 'error'
export type ActivitySource = 'codex' | 'bridge' | 'voice'
export type ReasoningEffort = 'medium' | 'high' | 'xhigh'
export type ModePreset = 'fast' | 'normal' | 'deep'

export type ActivityItem = {
  id: string
  eventId?: string
  kind: ActivityKind
  title: string
  detail: string
  time: string
  active?: boolean
  status?: ActivityStatus
  source?: ActivitySource
  label?: string
  preview?: string
}

export type CodexUsageWindow = {
  label: string
  status: 'available' | 'unavailable'
  remaining?: string | null
  usedPercent?: number | null
  remainingPercent?: number | null
  resetAt?: string | null
  windowDurationMins?: number | null
}

export type CodexUsageStatus = {
  source: string
  available: boolean
  reason?: string
  dashboardUrl?: string
  limitName?: string | null
  planType?: string | null
  rateLimitReachedType?: string | null
  fiveHour: CodexUsageWindow
  weekly: CodexUsageWindow
  credits?: {
    hasCredits: boolean
    unlimited: boolean
  } | null
  auth?: {
    loggedIn: boolean
    status?: string
  }
  updatedAt: string
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export type CodexStreamEvent =
  | {
      type: 'session'
      appSessionId: string
      codexSessionId?: string
    }
  | {
      type: 'activity'
      kind: ActivityKind
      title: string
      detail: string
      status?: ActivityStatus
      source?: ActivitySource
      eventId?: string
      label?: string
      preview?: string
    }
  | {
      type: 'terminal'
      level: 'info' | 'search' | 'tool' | 'error'
      text: string
    }
  | {
      type: 'final'
      appSessionId: string
      codexSessionId?: string
      text: string
    }
  | {
      type: 'error'
      message: string
    }

export type AppSettings = {
  openrouter: {
    configured: boolean
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
    workspaceExists: boolean
    workspaceWarning?: string
  }
  storage: {
    localSettings: boolean
  }
}

export type AppSessionSummary = {
  appSessionId: string
  codexSessionId?: string
  createdAt?: string
  updatedAt?: string
  turns: number
  lastMode?: string
  workspace?: string
}

export type SessionsResponse = {
  currentWorkspace: string
  sessions: AppSessionSummary[]
}
