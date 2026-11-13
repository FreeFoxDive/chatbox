import { describe, expect, it } from 'vitest'
import { appliesOfficialEntitlements, isOfficialChatboxServer, normalizeChatboxServerOrigin } from './free-edition'
import { namespacedDatabaseName, namespacedStorageKey, sanitizeNamespaceId } from './workspace-namespace'

describe('free edition entitlements', () => {
  it('treats the official pool as official and a private host as custom', () => {
    expect(isOfficialChatboxServer('https://api.chatboxai.app')).toBe(true)
    expect(isOfficialChatboxServer('')).toBe(true)
    expect(isOfficialChatboxServer('https://llm.example.com')).toBe(false)
    expect(isOfficialChatboxServer('http://127.0.0.1:8000')).toBe(false)
    expect(isOfficialChatboxServer('http://localhost:3000')).toBe(false)
    expect(normalizeChatboxServerOrigin('llm.example.com/v1/')).toBe('https://llm.example.com/v1')
  })

  it('keeps quota gates only for an official logged-in session', () => {
    expect(
      appliesOfficialEntitlements({
        apiHost: 'https://api.chatboxai.app',
        licenseActivationMethod: 'login',
        hasOfficialSession: true,
      })
    ).toBe(true)
    expect(
      appliesOfficialEntitlements({
        apiHost: 'https://llm.example.com',
        licenseActivationMethod: 'login',
        hasOfficialSession: true,
      })
    ).toBe(false)
    expect(
      appliesOfficialEntitlements({
        licenseActivationMethod: 'manual',
        hasOfficialSession: false,
      })
    ).toBe(false)
  })
})

describe('workspace namespaces', () => {
  it('keeps anonymous storage names and suffixes every other workspace', () => {
    expect(namespacedDatabaseName('chatbox-messages', 'anonymous')).toBe('chatbox-messages')
    expect(namespacedDatabaseName('chatbox-messages', 'official_abc')).toBe('chatbox-messages__ns_official_abc')
    expect(namespacedStorageKey('settings', 'anonymous')).toBe('settings')
    expect(namespacedStorageKey('chatbox:active-workspace-ns', 'official_abc')).toBe('chatbox:active-workspace-ns')
    expect(sanitizeNamespaceId('official:bad/name')).toBe('officialbadname')
  })
})
