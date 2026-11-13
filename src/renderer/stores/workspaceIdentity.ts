import { createDefaultSettings, encodePersistedSettings } from '@chatbox/core/domain/settings'
import { AUTH_INFO_PERSIST_KEY } from '@chatbox/react/stores'
import type { Settings } from '@shared/types'
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  ANONYMOUS_WORKSPACE,
  KNOWN_WORKSPACES_STORAGE_KEY,
  namespacedStorageKey,
  PENDING_WORKSPACE_SEED_KEY,
  readActiveWorkspaceNamespaceFromLocalStorage,
  sanitizeNamespaceId,
} from '@shared/workspace-namespace'
import platform from '@/platform'
import type DesktopPlatform from '@/platform/desktop_platform'

let settingsWritesFrozen = false

export function settingsWritesFrozenNow(): boolean {
  return settingsWritesFrozen
}

export function freezeSettingsWrites(): void {
  settingsWritesFrozen = true
}

export function getActiveWorkspaceNamespace(): string {
  return readActiveWorkspaceNamespaceFromLocalStorage()
}

function rememberWorkspace(namespace: string) {
  try {
    const current = JSON.parse(localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY) || '[]') as unknown
    const known = Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : []
    if (!known.includes(namespace)) {
      localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, JSON.stringify([...known, namespace]))
    }
  } catch {
    localStorage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, JSON.stringify([namespace]))
  }
}

function relocateOfficialAuth(targetNamespace: string) {
  if (!targetNamespace.startsWith('official_')) return
  const sourceKey = namespacedStorageKey(AUTH_INFO_PERSIST_KEY, getActiveWorkspaceNamespace())
  const destination = namespacedStorageKey(AUTH_INFO_PERSIST_KEY, targetNamespace)
  if (sourceKey === destination) return
  try {
    const raw = localStorage.getItem(sourceKey)
    if (raw) localStorage.setItem(destination, raw)
    localStorage.removeItem(sourceKey)
  } catch {
    // Auth copy is best-effort; the pending seed still switches the workspace.
  }
}

async function syncNamespaceToMain(namespace: string) {
  if (platform.type !== 'desktop') return
  await (platform as DesktopPlatform).ipc.invoke('setActiveWorkspaceNamespace', namespace)
}

/**
 * Switch the persisted workspace and relaunch so databases, settings and auth
 * reopen against that namespace. Anonymous keeps the historical storage names.
 */
export async function enterWorkspace(namespace: string, seed?: Partial<Settings>): Promise<void> {
  if (typeof window === 'undefined' || process.env.NODE_ENV === 'test') return
  const target = sanitizeNamespaceId(namespace)
  if (target === getActiveWorkspaceNamespace()) return

  freezeSettingsWrites()
  relocateOfficialAuth(target)

  // The seed is applied on the next launch, after storage names follow the new namespace.
  localStorage.setItem(PENDING_WORKSPACE_SEED_KEY, JSON.stringify(seed ?? null))
  localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, target)
  rememberWorkspace(target)
  await syncNamespaceToMain(target)
  await platform.relaunch()
}

/** Apply a seed left behind when the pre-relaunch settings write did not finish. */
export async function applyPendingWorkspaceSeed(): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(PENDING_WORKSPACE_SEED_KEY)
  if (!raw) return
  localStorage.removeItem(PENDING_WORKSPACE_SEED_KEY)
  let seed: Partial<Settings> | null = null
  try {
    seed = JSON.parse(raw) as Partial<Settings> | null
  } catch {
    return
  }
  if (!seed) return
  const defaults = createDefaultSettings()
  const existing = (await platform.getSettings().catch(() => null)) as Settings | null
  await platform.setStoreValue(
    'settings',
    encodePersistedSettings({
      ...(existing ?? defaults),
      ...seed,
      providers: {
        ...(existing?.providers ?? {}),
        ...(seed.providers ?? {}),
      },
    })
  )
}
