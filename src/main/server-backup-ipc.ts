import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { app, ipcMain } from 'electron'

interface OpenUpload {
  path: string
  stream: ReturnType<typeof createWriteStream>
  bytes: number
}

interface OpenDownload {
  path: string
}

function backupUrl(value: string, path: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Backup address must use http or https')
  url.pathname = path
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  return url
}

function filenameOf(value: string): string {
  const base = value.split(/[/\\]/).pop() ?? 'chatbox-backup.zip'
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128)
  return cleaned || 'chatbox-backup.zip'
}

function concatBuffers(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks as unknown as readonly Uint8Array[])
}

function errorText(chunks: Buffer[]): string {
  const text = concatBuffers(chunks).toString('utf8')
  if (!text) return ''
  try {
    const body = JSON.parse(text) as { error?: string }
    return body.error || text
  } catch {
    return text
  }
}

function requestJson(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: NodeJS.ReadableStream
): Promise<{ status: number; body: unknown }> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = transport(url, { method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = concatBuffers(chunks).toString('utf8')
        if (!text) {
          resolve({ status: response.statusCode ?? 500, body: {} })
          return
        }
        try {
          resolve({ status: response.statusCode ?? 500, body: JSON.parse(text) })
        } catch {
          resolve({ status: response.statusCode ?? 500, body: { error: text } })
        }
      })
    })
    request.on('error', reject)
    if (body) body.pipe(request)
    else request.end()
  })
}

export function registerServerBackupIpc(): void {
  const directory = join(app.getPath('userData') || tmpdir(), 'server-backup-transfers')
  const uploads = new Map<string, OpenUpload>()
  const downloads = new Map<string, OpenDownload>()

  const sweep = () => {
    void readdir(directory)
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.endsWith('.upload') || name.endsWith('.download'))
            .map((name) => rm(join(directory, name), { force: true }))
        )
      )
      .catch(() => undefined)
  }
  if (app.isReady()) sweep()
  else app.once('ready', sweep)

  const remove = async (path: string) => {
    await rm(path, { force: true })
  }

  ipcMain.handle('server-backup:create-upload', async () => {
    await mkdir(directory, { recursive: true })
    const token = randomUUID()
    const path = join(directory, `${token}.upload`)
    uploads.set(token, { path, stream: createWriteStream(path), bytes: 0 })
    return token
  })

  ipcMain.handle('server-backup:write', async (_event, token: string, bytes: Uint8Array) => {
    const upload = uploads.get(token)
    if (!upload || !(bytes instanceof Uint8Array)) throw new Error('Upload is not open')
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (!upload.stream.write(chunk)) await new Promise((resolve) => upload.stream.once('drain', resolve))
    upload.bytes += chunk.length
  })

  ipcMain.handle('server-backup:cancel', async (_event, token: string) => {
    const upload = uploads.get(token)
    if (!upload) return
    uploads.delete(token)
    upload.stream.destroy()
    await remove(upload.path)
  })

  ipcMain.handle(
    'server-backup:upload',
    async (_event, token: string, baseUrl: string, accessToken: string, filename: string) => {
      const upload = uploads.get(token)
      if (!upload) throw new Error('Upload is not open')
      if (!upload.stream.writableEnded) {
        upload.stream.end()
        await finished(upload.stream)
      }
      const url = backupUrl(baseUrl, '/api/backups')
      const info = await stat(upload.path)
      const result = await requestJson(
        url,
        'POST',
        {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/zip',
          'content-length': String(info.size),
          'x-backup-filename': filenameOf(filename),
        },
        createReadStream(upload.path)
      )
      if (result.status < 300) {
        uploads.delete(token)
        await remove(upload.path)
      }
      return result
    }
  )

  ipcMain.handle('server-backup:download', async (_event, baseUrl: string, accessToken: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Backup was not found')
    await mkdir(directory, { recursive: true })
    const url = backupUrl(baseUrl, `/api/backups/${id}`)
    const token = randomUUID()
    const path = join(directory, `${token}.download`)
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    try {
      const opened = await new Promise<{ status: number; error: string }>((resolve, reject) => {
        const request = transport(
          url,
          { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
          (response) => {
            const status = response.statusCode ?? 500
            if (status >= 300) {
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => chunks.push(chunk))
              response.on('error', reject)
              response.on('end', () => resolve({ status, error: errorText(chunks) }))
              return
            }
            const output = createWriteStream(path)
            pipeline(response, output).then(
              () => resolve({ status, error: '' }),
              reject
            )
          }
        )
        request.on('error', reject)
        request.end()
      })
      if (opened.status >= 300) {
        await remove(path)
        return { status: opened.status, token: null, size: 0, error: opened.error }
      }
      const info = await stat(path)
      downloads.set(token, { path })
      return { status: opened.status, token, size: info.size, error: '' }
    } catch (error) {
      await remove(path)
      throw error
    }
  })

  ipcMain.handle('server-backup:read', async (_event, token: string, offset: number, length: number) => {
    const download = downloads.get(token)
    if (!download || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new Error('Download is not open')
    }
    const handle = await open(download.path, 'r')
    try {
      const view = new Uint8Array(length)
      const { bytesRead } = await handle.read(view, 0, length, offset)
      return view.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  })

  ipcMain.handle('server-backup:close', async (_event, token: string) => {
    const download = downloads.get(token)
    if (!download) return
    downloads.delete(token)
    await remove(download.path)
  })
}
