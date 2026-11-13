import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { ANONYMOUS_WORKSPACE, sanitizeNamespaceId } from '../shared/workspace-namespace'

const FILE_NAME = 'active-workspace-ns'

function namespaceFilePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** Active workspace for the main process. Anonymous when the file is missing. */
export function readPersistedWorkspaceNamespace(): string {
  try {
    return sanitizeNamespaceId(fs.readFileSync(namespaceFilePath(), 'utf8'))
  } catch {
    return ANONYMOUS_WORKSPACE
  }
}

export function writePersistedWorkspaceNamespace(namespace: string): string {
  const sanitized = sanitizeNamespaceId(namespace)
  const filePath = namespaceFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, sanitized, 'utf8')
  return sanitized
}

export function workspaceDatabaseDir(appDatabaseDir: string): string {
  const namespace = readPersistedWorkspaceNamespace()
  if (namespace === ANONYMOUS_WORKSPACE) return appDatabaseDir
  return path.join(appDatabaseDir, namespace)
}

export function workspaceBlobDir(userDataPath: string): string {
  const base = path.join(userDataPath, 'chatbox-blobs')
  const namespace = readPersistedWorkspaceNamespace()
  if (namespace === ANONYMOUS_WORKSPACE) return base
  return path.join(base, namespace)
}
