import platform from '@/platform'
import { normalizeBackupServerUrl } from './protocol'

export const SERVER_BACKUP_SESSION_KEY = 'server-backup-session'

export interface ServerBackupSession {
  baseUrl: string
  username: string
  accessToken?: string
  accessExpiresAt?: number
  refreshToken?: string
  refreshExpiresAt?: number
  dirty: boolean
  dirtySince: number | null
  lastChangeAt: number | null
  lastSuccessAt: number | null
  nextAttemptAt: number | null
  uploadedIds: string[]
  mergedIds: string[]
}

export interface ServerBackupAuth {
  username: string
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  baseUrl?: string
}

export function emptyServerBackupSession(baseUrl = ''): ServerBackupSession {
  return {
    baseUrl,
    username: '',
    dirty: false,
    dirtySince: null,
    lastChangeAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    uploadedIds: [],
    mergedIds: [],
  }
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function isSignedIn(session: ServerBackupSession, now = Date.now()): boolean {
  return Boolean(session.accessToken && session.refreshToken && (session.refreshExpiresAt ?? 0) > now)
}

function withoutPassword(value: ServerBackupSession): ServerBackupSession {
  const stored = { ...value }
  delete (stored as ServerBackupSession & { password?: string }).password
  return stored
}

export async function loadServerBackupSession(): Promise<ServerBackupSession> {
  const stored = (await platform.getStoreValue(SERVER_BACKUP_SESSION_KEY)) as ServerBackupSession | null
  if (!stored || typeof stored !== 'object') return emptyServerBackupSession()
  const session = { ...emptyServerBackupSession(stored.baseUrl ?? ''), ...withoutPassword(stored) }
  session.uploadedIds = idList(stored.uploadedIds)
  session.mergedIds = idList(stored.mergedIds)
  return session
}

let writeQueue: Promise<void> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function persistServerBackupSession(session: ServerBackupSession): Promise<void> {
  const baseUrl = normalizeBackupServerUrl(session.baseUrl) ?? ''
  await platform.setStoreValue(SERVER_BACKUP_SESSION_KEY, withoutPassword({ ...session, baseUrl }))
}

export function saveServerBackupSession(session: ServerBackupSession): Promise<void> {
  return enqueueWrite(() => persistServerBackupSession(session))
}

export function updateServerBackupSession(
  change: (session: ServerBackupSession) => ServerBackupSession | Promise<ServerBackupSession>,
): Promise<ServerBackupSession> {
  return enqueueWrite(async () => {
    const current = await loadServerBackupSession()
    const next = await change(current)
    await persistServerBackupSession(next)
    return next
  })
}

export function clearServerBackupSession(keep?: { baseUrl?: string; username?: string }): Promise<ServerBackupSession> {
  return updateServerBackupSession((current) => {
    const next = emptyServerBackupSession(keep?.baseUrl ?? '')
    const urlChanged = next.baseUrl !== current.baseUrl
    next.username = keep?.username ?? ''
    next.dirty = current.dirty
    next.dirtySince = current.dirtySince
    next.lastChangeAt = current.lastChangeAt
    next.lastSuccessAt = current.lastSuccessAt
    next.nextAttemptAt = current.nextAttemptAt
    next.uploadedIds = urlChanged ? [] : current.uploadedIds
    next.mergedIds = urlChanged ? [] : current.mergedIds
    return next
  })
}

export function applyAuth(session: ServerBackupSession, auth: ServerBackupAuth): ServerBackupSession {
  return {
    ...session,
    baseUrl: auth.baseUrl ?? session.baseUrl,
    username: auth.username,
    accessToken: auth.accessToken,
    accessExpiresAt: auth.accessExpiresAt,
    refreshToken: auth.refreshToken,
    refreshExpiresAt: auth.refreshExpiresAt,
    nextAttemptAt: null,
    uploadedIds: auth.baseUrl && auth.baseUrl !== session.baseUrl ? [] : session.uploadedIds,
    mergedIds: auth.baseUrl && auth.baseUrl !== session.baseUrl ? [] : session.mergedIds,
  }
}
