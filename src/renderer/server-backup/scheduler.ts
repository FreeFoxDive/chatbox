import { rendererApplication } from '@/app/renderer-application'
import { rendererBackupService } from '@/app/renderer-backup'
import { settingsStore } from '@/stores/settingsStore'
import { markServerBackupDirty, noteServerBackupFailure } from './client'
import { QUIET_MS, shouldAutoBackup } from './protocol'
import { isSignedIn, loadServerBackupSession } from './session'

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
    if (state.hydrationStatus !== 'hydrated') return
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
    if (CONTENT_EVENTS.has(event.type)) dirty()
  })

  const tick = () => {
    if (busy) return
    void (async () => {
      const session = await loadServerBackupSession()
      const run = shouldAutoBackup({
        now: Date.now(),
        dirty: session.dirty,
        lastChangeAt: session.lastChangeAt,
        lastSuccessAt: session.lastSuccessAt,
        dirtySince: session.dirtySince,
        nextAttemptAt: session.nextAttemptAt,
        suppressUntil,
        generating: rendererBackupService.getGeneratingSessionIds().length > 0,
        busy: rendererBackupService.isActive(),
        signedIn: isSignedIn(session),
      })
      if (!run) return
      busy = true
      try {
        await rendererBackupService.exportToServer(
          { sessions: true, settings: true, copilots: true, credentials: false },
          { automatic: true, changeAtStart: session.lastChangeAt }
        )
      } catch {
        await noteServerBackupFailure()
      } finally {
        busy = false
      }
    })()
  }

  const unsubscribeGeneration = rendererApplication.generationRuntime.subscribe(() => tick())
  const timer = setInterval(tick, 15_000)
  return () => {
    unsubscribeSettings()
    unsubscribeSessions()
    unsubscribeGeneration()
    clearInterval(timer)
  }
}
