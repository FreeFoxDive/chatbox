import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizedBackupFetch, refreshServerBackupSession } from './client'
import { clearServerBackupSession, emptyServerBackupSession, loadServerBackupSession, saveServerBackupSession } from './session'

beforeEach(async () => {
  await saveServerBackupSession(emptyServerBackupSession())
  vi.unstubAllGlobals()
})

it('keeps the username and drops the password', async () => {
  await saveServerBackupSession({
    ...emptyServerBackupSession('http://127.0.0.1:8787'),
    username: 'admin',
    accessToken: 'access',
    refreshToken: 'refresh',
    password: 'secret-password',
  } as ReturnType<typeof emptyServerBackupSession> & { password: string })
  const session = await loadServerBackupSession()
  expect(session.username).toBe('admin')
  expect(JSON.stringify(session)).not.toContain('secret-password')
})

it('keeps a login saved after an address reset has started', async () => {
  const reset = clearServerBackupSession({ baseUrl: 'http://127.0.0.1:8787' })
  await saveServerBackupSession({
    ...emptyServerBackupSession('http://127.0.0.1:8787'),
    username: 'admin',
    accessToken: 'access',
    refreshToken: 'refresh',
    refreshExpiresAt: Date.now() + 60_000,
  })
  await reset
  const session = await loadServerBackupSession()
  expect(session.username).toBe('admin')
  expect(session.accessToken).toBe('access')
})

describe('refresh', () => {
  it('retries a request after the access token is rejected', async () => {
    const later = Date.now() + 60 * 60 * 1000
    await saveServerBackupSession({
      ...emptyServerBackupSession('http://127.0.0.1:8787'),
      username: 'admin',
      accessToken: 'old',
      accessExpiresAt: later,
      refreshToken: 'refresh-old',
      refreshExpiresAt: later,
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Sign in again' }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            username: 'admin',
            accessToken: 'new-access',
            accessExpiresAt: later,
            refreshToken: 'refresh-new',
            refreshExpiresAt: later,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ backups: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await authorizedBackupFetch('/api/backups')
    expect(response.status).toBe(200)
    const retry = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(new Headers(retry[1].headers).get('authorization')).toBe('Bearer new-access')
    expect((await loadServerBackupSession()).username).toBe('admin')
  })

  it('keeps the username when refresh fails', async () => {
    await saveServerBackupSession({
      ...emptyServerBackupSession('http://127.0.0.1:8787'),
      username: 'admin',
      accessToken: 'old',
      refreshToken: 'refresh-old',
      refreshExpiresAt: Date.now() + 60_000,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(refreshServerBackupSession()).rejects.toThrow(/expired/i)
    const session = await loadServerBackupSession()
    expect(session.username).toBe('admin')
    expect(session.accessToken).toBeUndefined()
    expect(session.refreshToken).toBeUndefined()
  })
})
