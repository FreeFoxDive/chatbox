import { getChatboxAPIOrigin } from './request/chatbox-api-origin'

/** Hosts that belong to the official Chatbox API, including the probed fallback pool. */
const OFFICIAL_CHATBOX_HOSTS = new Set([
  'api.chatboxai.app',
  'api.chatbox.run',
  'api.chatboxai.com',
  'api.ai-chatbox.com',
  'api.chatboxapp.xyz',
  'chatboxai.app',
  'api-beta.chatboxai.app',
  'beta-new-db.chatboxai.app',
])

export interface OfficialEntitlementInput {
  /** Provider apiHost. Empty means the built-in official origin. */
  apiHost?: string | null
  licenseActivationMethod?: 'login' | 'manual' | null
  hasOfficialSession: boolean
}

/** Normalize a user-entered server URL to an origin without a trailing slash. */
export function normalizeChatboxServerOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withProtocol)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${pathname === '/' ? '' : pathname}`
  } catch {
    return null
  }
}

export function isOfficialChatboxServer(originOrHost: string | null | undefined): boolean {
  const normalized = normalizeChatboxServerOrigin(originOrHost || getChatboxAPIOrigin())
  if (!normalized) return true
  try {
    return OFFICIAL_CHATBOX_HOSTS.has(new URL(normalized).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Official quota and plan gates apply only for an official-account session on the
 * official API. Logged-out use and custom servers skip those client gates.
 */
export function appliesOfficialEntitlements(input: OfficialEntitlementInput): boolean {
  if (!isOfficialChatboxServer(input.apiHost)) return false
  return input.licenseActivationMethod === 'login' && input.hasOfficialSession
}

/** Gateway origin for Chatbox AI model calls. Custom apiHost replaces the official pool. */
export function resolveChatboxGatewayOrigin(apiHost: string | null | undefined): string {
  return normalizeChatboxServerOrigin(apiHost) || getChatboxAPIOrigin()
}
