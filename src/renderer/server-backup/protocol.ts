export const QUIET_MS = 5 * 60 * 1000
export const LONG_MS = 30 * 60 * 1000
export const RETRY_MS = 5 * 60 * 1000

export interface AutoBackupClock {
  now: number
  dirty: boolean
  lastChangeAt: number | null
  lastSuccessAt: number | null
  dirtySince: number | null
  nextAttemptAt: number | null
  suppressUntil: number
  generating: boolean
  busy: boolean
  signedIn: boolean
}

export function shouldAutoBackup(state: AutoBackupClock): boolean {
  if (!state.signedIn || !state.dirty || state.generating || state.busy) return false
  if (state.now < state.suppressUntil) return false
  if (state.nextAttemptAt !== null && state.now < state.nextAttemptAt) return false
  const lastChange = state.lastChangeAt ?? state.now
  const quiet = state.now - lastChange >= QUIET_MS
  const anchor = state.lastSuccessAt ?? state.dirtySince ?? state.now
  const long = state.now - anchor >= LONG_MS
  return quiet || long
}

export function normalizeBackupServerUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

export function parseSharePayload(payload: string): { baseUrl: string; code: string } {
  const trimmed = payload.trim()
  const prefix = 'cb-backup:1:'
  if (!trimmed.startsWith(prefix)) throw new Error('Backup code is not recognized')
  const rest = trimmed.slice(prefix.length)
  const split = rest.lastIndexOf(':')
  if (split <= 0) throw new Error('Backup code is not recognized')
  const baseUrl = normalizeBackupServerUrl(rest.slice(0, split))
  const code = rest.slice(split + 1)
  if (!baseUrl || !code) throw new Error('Backup code is not recognized')
  return { baseUrl, code }
}

export function backupFilename(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-')
  return `chatbox-backup-${stamp}.zip`
}
