import { parseSharePayload } from './protocol'
import {
  applyAuth,
  clearServerBackupSession,
  isSignedIn,
  loadServerBackupSession,
  type ServerBackupAuth,
  type ServerBackupSession,
  updateServerBackupSession,
} from './session'

export class ServerBackupError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: 'expired' | 'unreachable' | 'invalid-code'
  ) {
    super(message)
  }
}

let refreshInFlight: Promise<ServerBackupSession> | null = null
const listListeners = new Set<() => void>()

export function subscribeServerBackupList(listener: () => void): () => void {
  listListeners.add(listener)
  return () => listListeners.delete(listener)
}

export function notifyServerBackupList(): void {
  for (const listener of listListeners) listener()
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // The server did not return JSON.
  }
  if (response.status === 0) return 'Could not reach the backup server.'
  return 'Could not reach the backup server.'
}

function authFrom(body: ServerBackupAuth, baseUrl: string): ServerBackupAuth {
  return { ...body, baseUrl: body.baseUrl || baseUrl }
}

export async function refreshServerBackupSession(session?: ServerBackupSession): Promise<ServerBackupSession> {
  if (refreshInFlight) return await refreshInFlight
  refreshInFlight = (async () => {
    const current = session ?? (await loadServerBackupSession())
    if (!current.refreshToken || !current.baseUrl) {
      const cleared = await clearServerBackupSession({ baseUrl: current.baseUrl, username: current.username })
      notifyServerBackupList()
      return cleared
    }
    let response: Response
    try {
      response = await fetch(new URL('/api/auth/refresh', current.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
    } catch {
      throw new ServerBackupError('Could not reach the backup server.', undefined, 'unreachable')
    }
    if (!response.ok) {
      await clearServerBackupSession({ baseUrl: current.baseUrl, username: current.username })
      notifyServerBackupList()
      throw new ServerBackupError(
        `The backup session expired. Enter the password for ${current.username}.`,
        response.status,
        'expired'
      )
    }
    const body = (await response.json()) as ServerBackupAuth
    return updateServerBackupSession((latest) => applyAuth(latest, authFrom(body, current.baseUrl)))
  })().finally(() => {
    refreshInFlight = null
  })
  return await refreshInFlight
}

export async function ensureServerBackupAccess(): Promise<ServerBackupSession> {
  const session = await loadServerBackupSession()
  if (!session.accessToken || !session.baseUrl) throw new ServerBackupError('Sign in to backup server')
  if ((session.accessExpiresAt ?? 0) - 30_000 <= Date.now()) return refreshServerBackupSession(session)
  return session
}

export async function authorizedBackupFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (session: ServerBackupSession) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${session.accessToken ?? ''}`)
    try {
      return await fetch(new URL(path, session.baseUrl), { ...init, headers })
    } catch {
      throw new ServerBackupError('Could not reach the backup server.', undefined, 'unreachable')
    }
  }
  let session = await ensureServerBackupAccess()
  let response = await send(session)
  if (response.status === 401) {
    session = await refreshServerBackupSession(session)
    if (!isSignedIn(session)) {
      throw new ServerBackupError(
        `The backup session expired. Enter the password for ${session.username}.`,
        401,
        'expired'
      )
    }
    response = await send(session)
  }
  return response
}

export async function loginToBackupServer(
  baseUrl: string,
  username: string,
  password: string
): Promise<ServerBackupSession> {
  let response: Response
  try {
    response = await fetch(new URL('/api/auth/login', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new ServerBackupError('Could not reach the backup server.', undefined, 'unreachable')
  }
  if (!response.ok) throw new ServerBackupError(await errorMessage(response), response.status)
  const body = (await response.json()) as ServerBackupAuth
  return updateServerBackupSession((current) => applyAuth(current, authFrom(body, baseUrl)))
}

export async function redeemBackupCode(payload: string): Promise<ServerBackupSession> {
  const parsed = parseSharePayload(payload)
  let response: Response
  try {
    response = await fetch(new URL('/api/share-codes/redeem', parsed.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: parsed.code }),
    })
  } catch {
    throw new ServerBackupError('Could not reach the backup server.', undefined, 'unreachable')
  }
  if (!response.ok)
    throw new ServerBackupError('That backup code is invalid or already used.', response.status, 'invalid-code')
  const body = (await response.json()) as ServerBackupAuth
  return updateServerBackupSession((current) => applyAuth(current, authFrom(body, parsed.baseUrl)))
}

export async function logoutBackupServer(): Promise<void> {
  const current = await loadServerBackupSession()
  await clearServerBackupSession({ baseUrl: current.baseUrl })
}

export interface RemoteBackup {
  id: string
  filename: string
  size: number
  createdAt: number
}

export async function listServerBackups(): Promise<RemoteBackup[]> {
  const response = await authorizedBackupFetch('/api/backups')
  if (!response.ok) throw new ServerBackupError(await errorMessage(response), response.status)
  const body = (await response.json()) as { backups: RemoteBackup[] }
  return body.backups
}

export async function deleteServerBackup(id: string): Promise<void> {
  const response = await authorizedBackupFetch(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new ServerBackupError(await errorMessage(response), response.status)
}

export function markServerBackupDirty(): Promise<void> {
  const now = Date.now()
  return updateServerBackupSession((session) => ({
    ...session,
    dirty: true,
    dirtySince: session.dirtySince ?? now,
    lastChangeAt: now,
    nextAttemptAt: null,
  })).then(() => undefined)
}

export function noteServerBackupSuccess(changeAtStart: number | null): Promise<void> {
  return updateServerBackupSession((session) => ({
    ...session,
    lastSuccessAt: Date.now(),
    nextAttemptAt: null,
    dirty: session.lastChangeAt === changeAtStart ? false : session.dirty,
    dirtySince: session.lastChangeAt === changeAtStart ? null : session.dirtySince,
  })).then(() => undefined)
}

export function noteServerBackupFailure(): Promise<void> {
  return updateServerBackupSession((session) => ({
    ...session,
    nextAttemptAt: Date.now() + 5 * 60 * 1000,
  })).then(() => undefined)
}
