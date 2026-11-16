import type { ByteSource } from '@chatbox/core/io'
import { Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFieldDraft } from '@/hooks/useFieldDraft'
import {
  deleteServerBackup,
  listServerBackups,
  loginToBackupServer,
  logoutBackupServer,
  type RemoteBackup,
  redeemBackupCode,
  ServerBackupError,
  subscribeServerBackupList,
} from '@/server-backup/client'
import { normalizeBackupServerUrl } from '@/server-backup/protocol'
import {
  clearServerBackupSession,
  isSignedIn,
  loadServerBackupSession,
  type ServerBackupSession,
} from '@/server-backup/session'
import { type DownloadedBackup, downloadBackupZip } from '@/server-backup/transfer'
import { settingsStore, useSettingsStore } from '@/stores/settingsStore'
import { BackupDialog } from './BackupDialog'
import { SettingRow, SettingsSection } from './SettingsLayout'

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageFor(
  error: unknown,
  username: string,
  t: (key: string, options?: Record<string, unknown>) => unknown
): string {
  if (error instanceof ServerBackupError && error.code === 'expired') {
    return asText(t('The backup session expired. Enter the password for {{username}}.', { username }))
  }
  if (error instanceof ServerBackupError && error.code === 'invalid-code') {
    return asText(t('That backup code is invalid or already used.'))
  }
  if (error instanceof ServerBackupError && error.code === 'unreachable')
    return asText(t('Could not reach the backup server.'))
  return error instanceof Error ? error.message : asText(t('Could not reach the backup server.'))
}

export function ServerBackupSection({
  onBackup,
  onRestore,
}: {
  onBackup: () => void
  onRestore: (source: ByteSource & { close?: () => Promise<void> }, label: string) => void
}) {
  const { t } = useTranslation()
  const serverBackupUrl = useSettingsStore((state) => state.serverBackupUrl)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const [session, setSession] = useState<ServerBackupSession | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pasted, setPasted] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [backups, setBackups] = useState<RemoteBackup[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const videoRef = useRef<HTMLVideoElement>(null)
  const acceptRef = useRef<(payload: string) => Promise<void>>(async () => undefined)
  const signedIn = session ? isSignedIn(session) : false

  const reload = async () => {
    const next = await loadServerBackupSession()
    setSession(next)
    if (next.username) setUsername(next.username)
    if (isSignedIn(next)) {
      try {
        setBackups(await listServerBackups())
      } catch (error) {
        const latest = await loadServerBackupSession()
        setSession(latest)
        if (!isSignedIn(latest)) setBackups([])
        setMessage(messageFor(error, latest.username, t))
      }
    } else setBackups([])
  }

  useEffect(() => {
    void reload()
    return subscribeServerBackupList(() => {
      void reload()
    })
    // The list subscription reloads after uploads that happen outside this form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { draft, setDraft, flush } = useFieldDraft(serverBackupUrl ?? '', (next) => {
    const normalized = normalizeBackupServerUrl(next)
    if (normalized === null) return 'rejected'
    if (normalized === (serverBackupUrl ?? '')) return 'unchanged'
    setSettings({ serverBackupUrl: normalized || undefined })
    void clearServerBackupSession({ baseUrl: normalized }).then(setSession)
    return 'applied'
  })

  const acceptCode = async (payload: string) => {
    setBusy(true)
    setMessage(undefined)
    try {
      const next = await redeemBackupCode(payload)
      settingsStore.getState().setSettings({ serverBackupUrl: next.baseUrl })
      setSession(next)
      setUsername(next.username)
      setPassword('')
      setPasted('')
      setBackups(await listServerBackups())
    } catch (error) {
      setMessage(messageFor(error, session?.username ?? '', t))
    } finally {
      setBusy(false)
    }
  }
  acceptRef.current = acceptCode

  useEffect(() => {
    if (!scanning) return
    let stopped = false
    let stream: MediaStream | null = null
    const Detector = (
      globalThis as {
        BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike
      }
    ).BarcodeDetector
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setScanError(asText(t('The camera is unavailable. Paste the backup code instead.')) || undefined)
      return
    }
    const detector = new Detector({ formats: ['qr_code'] })
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stopped || !videoRef.current) return
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        const loop = async () => {
          if (stopped || !videoRef.current) return
          const codes = await detector.detect(videoRef.current).catch(() => [])
          const value = codes.find((code) => code.rawValue.startsWith('cb-backup:1:'))?.rawValue
          if (value) {
            stopped = true
            await acceptRef.current(value)
            setScanning(false)
            return
          }
          requestAnimationFrame(() => void loop())
        }
        void loop()
      } catch {
        if (!stopped)
          setScanError(asText(t('The camera is unavailable. Paste the backup code instead.')) || undefined)
      }
    })()
    return () => {
      stopped = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [scanning, t])

  const login = async () => {
    const baseUrl = normalizeBackupServerUrl(draft)
    if (!baseUrl) {
      setMessage(asText(t('Enter an http or https URL.')) || undefined)
      return
    }
    setBusy(true)
    setMessage(undefined)
    try {
      const next = await loginToBackupServer(baseUrl, (session?.username || username).trim(), password)
      setSettings({ serverBackupUrl: baseUrl })
      setSession(next)
      setUsername(next.username)
      setPassword('')
      setBackups(await listServerBackups())
    } catch (error) {
      setMessage(messageFor(error, username, t))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (backup: RemoteBackup) => {
    setBusy(true)
    setMessage(undefined)
    let downloaded: DownloadedBackup | undefined
    try {
      downloaded = await downloadBackupZip(backup.id)
      onRestore(downloaded, backup.filename)
    } catch (error) {
      await downloaded?.close()
      setMessage(messageFor(error, session?.username ?? '', t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={t('Server backup')}>
      <SettingRow
        id="server-backup"
        label={t('Backup server address')}
        description={
          signedIn
            ? t('Signed in to the backup server as {{username}}.', { username: session?.username })
            : t('Scan a one-time code from the backup server, or enter its address and sign in.')
        }
        controlLayout="block"
        control={(fieldId) => (
          <Stack gap="xs">
            <TextInput
              id={fieldId}
              size="sm"
              value={draft}
              placeholder="https://backup.example"
              error={normalizeBackupServerUrl(draft) === null ? t('Enter an http or https URL.') : undefined}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={flush}
            />
            {session?.lastSuccessAt ? (
              <Text size="xs" c="dimmed">
                {t('Last server backup: {{time}}', {
                  time: new Date(session.lastSuccessAt).toLocaleString(),
                })}
              </Text>
            ) : null}
            {message ? (
              <Text size="sm" c="chatbox-error">
                {message}
              </Text>
            ) : null}
            {signedIn ? (
              <Stack gap="xs">
                <Button variant="default" size="xs" w="fit-content" onClick={onBackup}>
                  {t('Back up to server')}
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  w="fit-content"
                  onClick={() => {
                    void logoutBackupServer().then(reload)
                  }}
                >
                  {t('Sign out of backup server')}
                </Button>
              </Stack>
            ) : (
              <Stack gap="xs">
                {!session?.username ? (
                  <TextInput
                    size="sm"
                    label={t('Backup server username')}
                    value={username}
                    autoComplete="username"
                    onChange={(event) => setUsername(event.currentTarget.value)}
                  />
                ) : (
                  <Text size="sm">
                    {t('Backup server username')}: {session.username}
                  </Text>
                )}
                <PasswordInput
                  size="sm"
                  label={t('Backup server password')}
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
                <Button size="xs" w="fit-content" loading={busy} onClick={() => void login()}>
                  {t('Sign in to backup server')}
                </Button>
                <Button variant="default" size="xs" w="fit-content" onClick={() => setScanning(true)}>
                  {t('Scan code')}
                </Button>
                <TextInput
                  size="sm"
                  label={t('Paste the backup code')}
                  value={pasted}
                  onChange={(event) => setPasted(event.currentTarget.value)}
                />
                <Button
                  variant="default"
                  size="xs"
                  w="fit-content"
                  loading={busy}
                  disabled={!pasted.trim()}
                  onClick={() => void acceptCode(pasted)}
                >
                  {t('Backup code')}
                </Button>
              </Stack>
            )}
            {signedIn && backups.length === 0 ? <Text size="sm">{t('No backups on the server yet.')}</Text> : null}
            {signedIn
              ? backups.map((backup) => (
                  <Stack key={backup.id} gap={4}>
                    <Text size="sm">
                      {backup.filename} · {formatSize(backup.size)} · {new Date(backup.createdAt).toLocaleString()}
                    </Text>
                    <Stack gap="xs" style={{ flexDirection: 'row' }}>
                      <Button size="xs" variant="default" disabled={busy} onClick={() => void restore(backup)}>
                        {t('Restore')}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        color="chatbox-error"
                        disabled={busy}
                        onClick={() => setConfirmDelete(backup.id)}
                      >
                        {t('Delete')}
                      </Button>
                    </Stack>
                  </Stack>
                ))
              : null}
          </Stack>
        )}
      />
      <BackupDialog
        opened={scanning}
        onClose={() => setScanning(false)}
        title={t('Point the camera at the backup code')}
        footer={
          <Button variant="default" onClick={() => setScanning(false)}>
            {t('Stop scanning')}
          </Button>
        }
      >
        <Stack gap="sm">
          <video ref={videoRef} muted playsInline style={{ width: '100%' }} />
          {scanError ? <Text size="sm">{scanError}</Text> : null}
        </Stack>
      </BackupDialog>
      <BackupDialog
        opened={confirmDelete !== undefined}
        onClose={() => setConfirmDelete(undefined)}
        title={t('Delete this backup from the server?')}
        footer={
          <>
            <Button variant="default" onClick={() => setConfirmDelete(undefined)}>
              {t('Cancel')}
            </Button>
            <Button
              color="chatbox-error"
              onClick={() => {
                const id = confirmDelete
                setConfirmDelete(undefined)
                if (!id) return
                void deleteServerBackup(id)
                  .then(reload)
                  .catch((error) => setMessage(messageFor(error, session?.username ?? '', t)))
              }}
            >
              {t('Delete')}
            </Button>
          </>
        }
      >
        <Text size="sm">{t('Delete this backup from the server?')}</Text>
      </BackupDialog>
    </SettingsSection>
  )
}
