export const SYNC_TOMBSTONES_PATH = 'sync/tombstones.json'

export interface SyncTombstone {
  kind: 'session' | 'thread' | 'message'
  sessionId: string
  objectId: string
  deletedAt: number
}

export function tombstoneKey(tombstone: SyncTombstone): string {
  return `${tombstone.kind}\0${tombstone.sessionId}\0${tombstone.objectId}`
}

export function parseSyncTombstones(value: unknown): SyncTombstone[] {
  if (!Array.isArray(value)) throw new Error('Backup tombstones are invalid')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Backup tombstones are invalid')
    const row = item as Partial<SyncTombstone>
    if (row.kind !== 'session' && row.kind !== 'thread' && row.kind !== 'message')
      throw new Error('Backup tombstones are invalid')
    if (typeof row.sessionId !== 'string' || !row.sessionId || typeof row.objectId !== 'string' || !row.objectId)
      throw new Error('Backup tombstones are invalid')
    if (typeof row.deletedAt !== 'number' || !Number.isFinite(row.deletedAt))
      throw new Error('Backup tombstones are invalid')
    return {
      kind: row.kind,
      sessionId: row.sessionId,
      objectId: row.kind === 'session' ? row.sessionId : row.objectId,
      deletedAt: row.deletedAt,
    }
  })
}

/** Keeps the newest deletion for each object. */
export function unionTombstones(
  current: readonly SyncTombstone[],
  incoming: readonly SyncTombstone[],
): SyncTombstone[] {
  const merged = new Map<string, SyncTombstone>()
  for (const tombstone of [...current, ...incoming]) {
    const key = tombstoneKey(tombstone)
    const previous = merged.get(key)
    if (!previous || tombstone.deletedAt >= previous.deletedAt) merged.set(key, tombstone)
  }
  return [...merged.values()]
}

export function tombstoneCovers(deletedAt: number, updatedAt: number): boolean {
  return deletedAt >= updatedAt
}

/**
 * Drops a message deletion once that message was kept with a newer edit.
 * Session and thread deletions stay, so an older snapshot cannot restore messages they removed.
 */
export function pruneTombstones(
  tombstones: readonly SyncTombstone[],
  messages: readonly { sessionId: string; threadId: string; messageId: string; updatedAt: number }[],
): SyncTombstone[] {
  return tombstones.filter((tombstone) => {
    if (tombstone.kind !== 'message') return true
    const message = messages.find(
      (item) => item.sessionId === tombstone.sessionId && item.messageId === tombstone.objectId,
    )
    return !message || message.updatedAt <= tombstone.deletedAt
  })
}
