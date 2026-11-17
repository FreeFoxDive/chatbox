import { createSessionMetaRecord } from '@chatbox/core/application/session'
import {
  mergeConversation,
  pruneTombstones,
  readBackupSyncSnapshot,
  selectBackupToMerge,
  settleBackupRecord,
  writeBackupResource,
  type BackupMessage,
  type BackupSession,
  type BackupSyncSession,
  type BackupThread,
} from '@chatbox/core/backup-v3'
import type { ByteSource } from '@chatbox/core/io'
import { deriveMessageFacts } from '@chatbox/core/session/session-tree'
import type { MessageRow, SessionRecordV2, ThreadRow } from '@chatbox/core/session/session-tree'
import type { SessionHeader } from '@shared/types'
import { v4 as uuid } from 'uuid'
import { rendererApplication } from '@/app/renderer-application'
import { createRendererBackupResources } from '@/adapters/backup-resources'
import platform from '@/platform'
import { listServerBackups } from './client'
import { loadServerBackupSession, updateServerBackupSession } from './session'
import { downloadBackupZip } from './transfer'
import { loadServerBackupTombstones, suppressBackupSync, updateServerBackupTombstones } from './tombstones'
import { IndexedDBBackupWorkspace } from '@/storage/BackupWorkspace'

function messageRow(message: BackupMessage): MessageRow {
  const settled = settleBackupRecord({ type: 'message', message })
  if (settled.type !== 'message') throw new Error('Expected a backup message')
  return { ...settled.message, status: 'settled', facts: deriveMessageFacts(settled.message.message) }
}

function threadRow(thread: BackupThread): ThreadRow {
  return { ...thread, activeLeafMessageId: null }
}

function sessionRecord(session: BackupSession, activeThreadId: string): SessionRecordV2 {
  return {
    ...(session as SessionHeader),
    activeThreadId,
    storageFormat: 'rows',
    rowFormatVersion: 3,
    rowAuthority: 1,
  }
}

function alignRecord(record: SessionRecordV2, threads: ThreadRow[]): SessionRecordV2 {
  const active = threads.find((thread) => thread.threadOrder === -1) ?? threads[0]
  if (!active) return record
  if (active.threadOrder !== -1) {
    active.threadOrder = -1
    active.name = active.name ?? null
  }
  return record.activeThreadId === active.threadId ? record : { ...record, activeThreadId: active.threadId }
}

export async function applyRemoteBackup(source: ByteSource): Promise<boolean> {
  const snapshot = await readBackupSyncSnapshot(source)
  const auth = await loadServerBackupSession()
  const tombstones = (await loadServerBackupTombstones(auth.baseUrl)).concat(snapshot.tombstones)
  const rows = platform.getSessionRowStore()
  const metadata = platform.getSessionMetaStorage()
  await rows.initialize()
  await metadata.initialize()
  const resourceKeys = new Set<string>()
  const kept: { sessionId: string; threadId: string; messageId: string; updatedAt: number }[] = []
  let changed = false
  const seen = new Set<string>()
  const reconcile = async (sessionId: string, remote: BackupSyncSession | null) => {
    seen.add(sessionId)
    const revision = await rows.getRevision(sessionId)
    const has = revision !== null && (await rows.hasRows(sessionId))
    const local = has ? await rows.readSnapshot(sessionId) : null
    const merged = mergeConversation({
      sessionId,
      localMessages: local?.rows.messages ?? [],
      remoteMessages: remote?.messages.map(messageRow) ?? [],
      localThreads: local?.rows.threads ?? [],
      remoteThreads: remote?.threads.map(threadRow) ?? [],
      tombstones,
    })
    for (const key of merged.resourceKeys) resourceKeys.add(key)
    if (!merged.removedSession) {
      for (const message of merged.messages) {
        kept.push({
          sessionId,
          threadId: message.threadId,
          messageId: message.messageId,
          updatedAt: message.updatedAt,
        })
      }
    }
    if (!merged.changed) return
    changed = true
    if (merged.removedSession) {
      if (has && revision !== null) await rows.deleteRows(sessionId, revision)
      await metadata.delete(sessionId)
      return
    }
    if (!merged.threads.length || (!local?.record && !remote)) return
    const record = alignRecord(
      local?.record ?? sessionRecord(remote!.session, remote!.session.activeThreadId),
      merged.threads,
    )
    await rows.writeRows(
      {
        record,
        revision: (revision ?? 0) + 1,
        rows: { sessionId, threads: merged.threads, messages: merged.messages },
      },
      revision,
    )
    if (!has) {
      await metadata.createMany([
        createSessionMetaRecord(
          record,
          remote?.meta?.sortOrder ?? -Date.now(),
          remote?.meta?.createdAt ?? Date.now(),
        ),
      ])
    }
  }
  for (const remote of snapshot.sessions) await reconcile(remote.session.id, remote)
  for (const tombstone of tombstones) {
    if (tombstone.kind === 'session' && !seen.has(tombstone.sessionId)) await reconcile(tombstone.sessionId, null)
  }
  if (resourceKeys.size) await copyMissingResources(source, snapshot.resources, resourceKeys)
  await updateServerBackupTombstones(auth.baseUrl, (current) =>
    pruneTombstones(current.concat(snapshot.tombstones), kept),
  )
  if (changed) {
    const resume = suppressBackupSync()
    try {
      await rendererApplication.sessions.reloadFromStorage()
      void rendererApplication.queryClient.resetQueries().catch(() => undefined)
    } finally {
      resume()
    }
  }
  return changed
}

async function copyMissingResources(
  source: ByteSource,
  resources: Awaited<ReturnType<typeof readBackupSyncSnapshot>>['resources'],
  keys: ReadonlySet<string>,
): Promise<void> {
  const jobId = uuid()
  const workspace = new IndexedDBBackupWorkspace(jobId)
  const stored = createRendererBackupResources(workspace)
  try {
    for (const descriptor of resources) {
      if (!keys.has(descriptor.resourceId)) continue
      const existing = await stored.open(descriptor.resourceId)
      if (existing) {
        await existing.source.close()
        continue
      }
      const sink = await stored.stage(jobId, descriptor)
      try {
        await writeBackupResource(source, descriptor.path, sink)
        await sink.close()
        await stored.publish(jobId, descriptor.resourceId)
      } catch (error) {
        await sink.abort().catch(() => undefined)
        throw error
      }
    }
  } finally {
    await stored.cleanup(jobId).catch(() => undefined)
    await workspace.dispose().catch(() => undefined)
  }
}

/** Downloads and merges the oldest snapshot this device did not upload or merge. */
export async function mergeNextRemoteBackup(): Promise<boolean> {
  const session = await loadServerBackupSession()
  const next = selectBackupToMerge(await listServerBackups(), session.uploadedIds, session.mergedIds)
  if (!next) return false
  const downloaded = await downloadBackupZip(next.id)
  try {
    await applyRemoteBackup(downloaded)
  } finally {
    await downloaded.close()
  }
  await updateServerBackupSession((current) => ({
    ...current,
    mergedIds: current.mergedIds.includes(next.id) ? current.mergedIds : [...current.mergedIds, next.id],
  }))
  return true
}
