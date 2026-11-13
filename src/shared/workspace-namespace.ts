export const ANONYMOUS_WORKSPACE = 'anonymous'
export const ACTIVE_WORKSPACE_STORAGE_KEY = 'chatbox:active-workspace-ns'
export const KNOWN_WORKSPACES_STORAGE_KEY = 'chatbox:known-workspaces'
export const PENDING_WORKSPACE_SEED_KEY = 'chatbox:pending-workspace-seed'

const GLOBAL_STORAGE_KEYS = new Set([
  ACTIVE_WORKSPACE_STORAGE_KEY,
  KNOWN_WORKSPACES_STORAGE_KEY,
  PENDING_WORKSPACE_SEED_KEY,
])

export function isGlobalStorageKey(key: string): boolean {
  return GLOBAL_STORAGE_KEYS.has(key)
}

/** Filesystem-safe namespace id. Anonymous keeps the historical storage names. */
export function sanitizeNamespaceId(namespace: string | null | undefined): string {
  if (!namespace || namespace === ANONYMOUS_WORKSPACE) return ANONYMOUS_WORKSPACE
  const sanitized = namespace.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  return sanitized || ANONYMOUS_WORKSPACE
}

export function namespacedDatabaseName(baseName: string, namespace: string | null | undefined): string {
  const id = sanitizeNamespaceId(namespace)
  if (id === ANONYMOUS_WORKSPACE) return baseName
  return `${baseName}__ns_${id}`
}

export function namespacedStorageKey(key: string, namespace: string | null | undefined): string {
  if (isGlobalStorageKey(key)) return key
  const id = sanitizeNamespaceId(namespace)
  if (id === ANONYMOUS_WORKSPACE) return key
  return `ns:${id}:${key}`
}

/** Storage key for the workspace that is active in this renderer. */
export function activeStorageKey(key: string): string {
  return namespacedStorageKey(key, readActiveWorkspaceNamespaceFromLocalStorage())
}

/** Blob keys stay unchanged for anonymous data and gain a namespace prefix otherwise. */
export function blobKeysForActiveWorkspace(keys: string[]): string[] {
  const namespace = readActiveWorkspaceNamespaceFromLocalStorage()
  if (namespace === ANONYMOUS_WORKSPACE) return keys.filter((key) => !key.startsWith('ns:'))
  const prefix = `ns:${namespace}:`
  return keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
}

export function activeDatabaseName(baseName: string): string {
  return namespacedDatabaseName(baseName, readActiveWorkspaceNamespaceFromLocalStorage())
}

export function readActiveWorkspaceNamespaceFromLocalStorage(): string {
  try {
    if (typeof localStorage === 'undefined') return ANONYMOUS_WORKSPACE
    return sanitizeNamespaceId(localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY))
  } catch {
    return ANONYMOUS_WORKSPACE
  }
}

export async function shortHash(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export async function officialWorkspaceNamespace(identity: string): Promise<string> {
  return `official_${await shortHash(identity.trim().toLowerCase())}`
}

export async function customWorkspaceNamespace(apiHost: string, credentialId: string): Promise<string> {
  return `custom_${await shortHash(`${apiHost}\n${credentialId}`)}`
}

export async function licenseWorkspaceNamespace(licenseKey: string): Promise<string> {
  return `license_${await shortHash(licenseKey)}`
}
