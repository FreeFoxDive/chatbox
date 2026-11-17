import type { SessionApplicationEvent } from '@chatbox/core/application/session'
import { unionTombstones, type SyncTombstone } from '@chatbox/core/backup-v3'
import platform from '@/platform'
import { loadServerBackupSession } from './session'

const TOMBSTONE_KEY = 'server-backup-tombstones'

interface StoredTombstones {
  baseUrl: string
  tombstones: SyncTombstone[]
}

let suppressed = 0
let writeQueue: Promise<void> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function suppressBackupSync(): () => void {
  suppressed += 1
  return () => {
    suppressed -= 1
  }
}

export function backupSyncSuppressed(): boolean {
  return suppressed > 0
}

async function read(baseUrl: string): Promise<SyncTombstone[]> {
  const stored = (await platform.getStoreValue(TOMBSTONE_KEY)) as StoredTombstones | null
  if (!stored || stored.baseUrl !== baseUrl || !Array.isArray(stored.tombstones)) return []
  return stored.tombstones
}

async function write(baseUrl: string, tombstones: SyncTombstone[]): Promise<void> {
  const stored: StoredTombstones = { baseUrl, tombstones }
  await platform.setStoreValue(TOMBSTONE_KEY, stored)
}

export function loadServerBackupTombstones(baseUrl: string): Promise<SyncTombstone[]> {
  return enqueue(() => read(baseUrl))
}

export function saveServerBackupTombstones(baseUrl: string, tombstones: SyncTombstone[]): Promise<void> {
  if (!baseUrl) return Promise.resolve()
  return enqueue(() => write(baseUrl, unionTombstones([], tombstones)))
}

export function updateServerBackupTombstones(
  baseUrl: string,
  change: (current: SyncTombstone[]) => SyncTombstone[],
): Promise<void> {
  if (!baseUrl) return Promise.resolve()
  return enqueue(async () => write(baseUrl, change(await read(baseUrl))))
}

export function rememberServerBackupTombstones(
  baseUrl: string,
  incoming: readonly SyncTombstone[],
): Promise<void> {
  if (!baseUrl || incoming.length === 0) return Promise.resolve()
  return enqueue(async () => write(baseUrl, unionTombstones(await read(baseUrl), incoming)))
}

export function tombstonesFromSessionEvent(event: SessionApplicationEvent, deletedAt = Date.now()): SyncTombstone[] {
  if (event.type === 'session-deleted') {
    return event.ids.map((id) => ({ kind: 'session', sessionId: id, objectId: id, deletedAt }))
  }
  if (event.type !== 'session-command-committed') return []
  const sessionId = event.delta.sessionId
  return [
    ...(event.delta.diff.messages.delete ?? []).map(
      (id): SyncTombstone => ({ kind: 'message', sessionId, objectId: id, deletedAt }),
    ),
    ...(event.delta.diff.threads.delete ?? []).map(
      (id): SyncTombstone => ({ kind: 'thread', sessionId, objectId: id, deletedAt }),
    ),
  ]
}

export async function captureDeleteTombstones(event: SessionApplicationEvent): Promise<void> {
  const tombstones = tombstonesFromSessionEvent(event)
  if (!tombstones.length) return
  const session = await loadServerBackupSession()
  await rememberServerBackupTombstones(session.baseUrl, tombstones)
}
