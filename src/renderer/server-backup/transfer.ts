import type { ByteSource } from '@chatbox/core/io'
import type { ElectronIPC } from '@shared/electron-types'
import platform from '@/platform'
import {
  authorizedBackupFetch,
  ensureServerBackupAccess,
  refreshServerBackupSession,
  ServerBackupError,
} from './client'
import { backupFilename } from './protocol'

interface DesktopBridge {
  ipc: ElectronIPC
}

function desktopIpc(): ElectronIPC | null {
  if (platform.type !== 'desktop') return null
  const bridge = platform as typeof platform & Partial<DesktopBridge>
  return bridge.ipc ?? null
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || 'Could not reach the backup server.'
  } catch {
    return 'Could not reach the backup server.'
  }
}

function backupId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('id' in body)) return undefined
  const id = (body as { id?: unknown }).id
  return typeof id === 'string' && id ? id : undefined
}

export async function uploadBackupZip(
  bytes: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  filename = backupFilename(),
): Promise<string | undefined> {
  const session = await ensureServerBackupAccess()
  const ipc = desktopIpc()
  if (ipc) {
    const token: string = await ipc.invoke('server-backup:create-upload')
    try {
      for await (const chunk of bytes) {
        if (signal.aborted) throw new DOMException('Export was cancelled', 'AbortError')
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          await ipc.invoke('server-backup:write', token, chunk.subarray(offset, offset + 65536))
        }
      }
      let accessToken = session.accessToken
      let result = (await ipc.invoke('server-backup:upload', token, session.baseUrl, accessToken, filename)) as {
        status: number
        body: { error?: string; id?: string }
      }
      if (result.status === 401) {
        accessToken = (await refreshServerBackupSession()).accessToken
        result = (await ipc.invoke('server-backup:upload', token, session.baseUrl, accessToken, filename)) as {
          status: number
          body: { error?: string; id?: string }
        }
      }
      if (result.status >= 300)
        throw new ServerBackupError(result.body.error || 'Could not reach the backup server.', result.status)
      return backupId(result.body)
    } catch (error) {
      await ipc.invoke('server-backup:cancel', token).catch(() => undefined)
      throw error
    }
  }

  const chunks: BlobPart[] = []
  for await (const chunk of bytes) {
    if (signal.aborted) throw new DOMException('Export was cancelled', 'AbortError')
    chunks.push(new Uint8Array(chunk))
  }
  const response = await authorizedBackupFetch('/api/backups', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-backup-filename': filename },
    body: new Blob(chunks, { type: 'application/zip' }),
    signal,
  })
  if (!response.ok) throw new ServerBackupError(await readError(response), response.status)
  return backupId(await response.json().catch(() => undefined))
}

export interface DownloadedBackup extends ByteSource {
  close(): Promise<void>
}

export async function downloadBackupZip(id: string): Promise<DownloadedBackup> {
  const session = await ensureServerBackupAccess()
  const ipc = desktopIpc()
  if (ipc) {
    let accessToken = session.accessToken
    let opened = (await ipc.invoke('server-backup:download', session.baseUrl, accessToken, id)) as {
      status: number
      token: string | null
      size: number
      error?: string
    }
    if (opened.status === 401) {
      accessToken = (await refreshServerBackupSession()).accessToken
      opened = (await ipc.invoke('server-backup:download', session.baseUrl, accessToken, id)) as {
        status: number
        token: string | null
        size: number
        error?: string
      }
    }
    if (!opened.token || opened.status >= 300) {
      throw new ServerBackupError(opened.error || 'Could not reach the backup server.', opened.status)
    }
    const token = opened.token
    return {
      size: opened.size,
      readBytes: async (offset, length) => {
        const bytes = (await ipc.invoke('server-backup:read', token, offset, length)) as Uint8Array
        return new Uint8Array(bytes)
      },
      close: async () => {
        await ipc.invoke('server-backup:close', token)
      },
    }
  }

  const response = await authorizedBackupFetch(`/api/backups/${encodeURIComponent(id)}`)
  if (!response.ok) throw new ServerBackupError(await readError(response), response.status)
  const file = new File([await response.blob()], 'backup.zip', { type: 'application/zip' })
  return Object.assign(file, { close: async () => undefined })
}
