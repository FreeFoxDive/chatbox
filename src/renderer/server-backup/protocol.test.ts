import { describe, expect, it } from 'vitest'
import { LONG_MS, normalizeBackupServerUrl, parseSharePayload, QUIET_MS, shouldAutoBackup, type AutoBackupClock } from './protocol'

const ready: AutoBackupClock = {
  now: 10 * QUIET_MS,
  dirty: true,
  lastChangeAt: 10 * QUIET_MS - QUIET_MS,
  lastSuccessAt: 10 * QUIET_MS - QUIET_MS,
  dirtySince: 0,
  nextAttemptAt: null,
  suppressUntil: 0,
  generating: false,
  busy: false,
  signedIn: true,
}

describe('server backup timing', () => {
  it('does not upload at the moment a conversation changes', () => {
    expect(shouldAutoBackup({ ...ready, lastChangeAt: ready.now })).toBe(false)
  })

  it('uploads after five quiet minutes', () => {
    expect(shouldAutoBackup(ready)).toBe(true)
  })

  it('waits out a startup suppress window', () => {
    expect(shouldAutoBackup({ ...ready, suppressUntil: ready.now + 1 })).toBe(false)
  })

  it('uploads a long-running session once thirty minutes have passed', () => {
    expect(
      shouldAutoBackup({
        ...ready,
        lastChangeAt: ready.now,
        lastSuccessAt: ready.now - LONG_MS,
      })
    ).toBe(true)
  })

  it('stays idle while a reply is generating', () => {
    expect(shouldAutoBackup({ ...ready, generating: true })).toBe(false)
  })
})

describe('backup codes', () => {
  it('reads the server address and one-time code', () => {
    expect(parseSharePayload('cb-backup:1:http://127.0.0.1:8787:ABCD2345')).toEqual({
      baseUrl: 'http://127.0.0.1:8787',
      code: 'ABCD2345',
    })
  })

  it('keeps only the origin of an http address', () => {
    expect(normalizeBackupServerUrl('https://backup.example/path')).toBe('https://backup.example')
    expect(normalizeBackupServerUrl('ftp://backup.example')).toBeNull()
  })
})
