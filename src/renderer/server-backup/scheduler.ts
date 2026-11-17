import { rendererApplication } from '@/app/renderer-application'
import { rendererBackupService } from '@/app/renderer-backup'
import { settingsStore } from '@/stores/settingsStore'
import { markServerBackupDirty, noteServerBackupFailure } from './client'
import { mergeNextRemoteBackup } from './merge'
import { QUIET_MS, shouldAutoBackup } from './protocol'
import { isSignedIn, loadServerBackupSession } from './session'
import { backupSyncSuppressed, captureDeleteTombstones } from './tombstones'

const CONTENT_EVENTS = new Set([
  'session-command-committed',
  'session-created',
  'session-deleted',
  'session-folders-changed',
])

export function startServerBackupScheduler(): () => void {
  const suppressUntil = Date.now() + QUIET_MS
  let busy = false
  let snapshot = ''
  let hydrated = settingsStore.getState().hydrationStatus === 'hydrated'
  if (hydrated) snapshot = JSON.stringify(settingsStore.getState().getSettings())

  const dirty = () => {
    void markServerBackupDirty()
  }

  const unsubscribeSettings = settingsStore.subscribe((state) => {
    if (backupSyncSuppressed() || state.hydrationStatus !== 'hydrated') return
    const encoded = JSON.stringify(state.getSettings())
    if (!hydrated) {
      hydrated = true
      snapshot = encoded
      return
    }
    if (encoded !== snapshot) dirty()
    snapshot = encoded
  })

  const unsubscribeSessions = rendererApplication.sessionEvents.subscribe((event) => {
    if (event.type === 'session-deleted' || event.type === 'session-command-committed') {
      void captureDeleteTombstones(event).finally(() => {
        if (!backupSyncSuppressed() && CONTENT_EVENTS.has(event.type)) dirty()
      })
      return
    }
    if (!backupSyncSuppressed() && CONTENT_EVENTS.has(event.type)) dirty()
  })

  const upload = async () => {
    const latest = await loadServerBackupSession()
    const run = shouldAutoBackup({
      now: Date.now(),
      dirty: latest.dirty,
      lastChangeAt: latest.lastChangeAt,
      lastSuccessAt: latest.lastSuccessAt,
      dirtySince: latest.dirtySince,
      nextAttemptAt: latest.nextAttemptAt,
      suppressUntil,
      generating: rendererBackupService.getGeneratingSessionIds().length > 0,
      busy: rendererBackupService.isActive() || busy,
      signedIn: isSignedIn(latest),
    })
    if (!run) return
    await rendererBackupService.exportToServer(
      { sessions: true, settings: true, copilots: true, credentials: false },
      { automatic: true, changeAtStart: latest.lastChangeAt },
    )
  }

  const merge = async () => {
    if (busy || backupSyncSuppressed()) return
    const session = await loadServerBackupSession()
    if (!isSignedIn(session) || rendererBackupService.isActive()) return
    if (rendererBackupService.getGeneratingSessionIds().length > 0) return
    busy = true
    let complete = false
    try {
      await rendererBackupService.runLocked(async () => {
        while (await mergeNextRemoteBackup()) {
          if (rendererBackupService.getGeneratingSessionIds().length > 0) return
        }
        complete = true
      })
    } catch {
      return
    } finally {
      busy = false
    }
    if (!complete) return
    try {
      await upload()
    } catch {
      await noteServerBackupFailure()
    }
  }

  const uploadOnly = () => {
    if (busy) return
    void upload().catch(() => noteServerBackupFailure())
  }

  const unsubscribeGeneration = rendererApplication.generationRuntime.subscribe(uploadOnly)
  const uploadTimer = setInterval(uploadOnly, 15_000)
  const mergeTimer = setInterval(() => void merge(), 60_000)
  void merge()
  return () => {
    unsubscribeSettings()
    unsubscribeSessions()
    unsubscribeGeneration()
    clearInterval(uploadTimer)
    clearInterval(mergeTimer)
  }
}
