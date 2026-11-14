import type { AbortSignalLike } from '../types/adapters'

type NativeFetchInit = NonNullable<Parameters<typeof fetch>[1]>
type NativeFetch = (input: string, init?: NativeFetchInit) => Promise<Response>

/**
 * Native-safe web search for the RN mobile shell.
 *
 * Uses JSON HTTP APIs only (no DOMParser/HTML scraping), so it runs on React
 * Native `fetch`. Tavily is the first provider; `apiHost` is injectable so the
 * Android emulator can verify against a local mock without credentials.
 */

export interface NativeWebSearchResultItem {
  title: string
  link: string
  snippet: string
}

/** Same provider set the renderer's Web Search settings expose. */
export type NativeWebSearchProvider =
  | 'build-in'
  | 'bing'
  | 'tavily'
  | 'bocha'
  | 'querit'
  | 'searxng'
  | 'deepseek'
  | 'searxng-deepseek'

export const nativeWebSearchProviderOptions: Array<{ id: NativeWebSearchProvider; label: string }> = [
  { id: 'build-in', label: 'Chatbox AI' },
  { id: 'bing', label: 'Bing Search' },
  { id: 'tavily', label: 'Tavily' },
  { id: 'bocha', label: 'BoCha' },
  { id: 'querit', label: 'Querit' },
  { id: 'searxng', label: 'SearXNG' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'searxng-deepseek', label: 'SearXNG + DeepSeek' },
]

export interface NativeWebSearchSettings {
  enabled?: boolean
  provider: NativeWebSearchProvider
  apiKey: string
  apiHost: string
}

// Web parity (defaults.ts extension.webSearch.provider): the Chatbox search API
// is the default. Bare Bing scraping is unreliable from native HTTP clients --
// without a real browser UA/cookies Bing serves a JS shell with zero results.
export const defaultNativeWebSearchSettings: NativeWebSearchSettings = {
  provider: 'build-in',
  apiKey: '',
  apiHost: '',
}

export function normalizeNativeWebSearchSettings(
  settings: Partial<NativeWebSearchSettings> | undefined
): NativeWebSearchSettings {
  const provider = nativeWebSearchProviderOptions.some((option) => option.id === settings?.provider)
    ? (settings?.provider as NativeWebSearchProvider)
    : defaultNativeWebSearchSettings.provider
  return {
    enabled: settings?.enabled,
    provider,
    apiKey: settings?.apiKey ?? '',
    apiHost: settings?.apiHost ?? '',
  }
}

export interface NativeWebSearchOptions {
  provider?: NativeWebSearchProvider
  apiKey?: string
  apiHost?: string
  /** Chatbox license key, used by the `build-in` provider. */
  licenseKey?: string
  /** Chatbox API origin override for the `build-in` provider. */
  chatboxApiOrigin?: string
  signal?: AbortSignalLike
  fetchFn?: NativeFetch
  maxResults?: number
  /** Querit-only knobs (renderer settings webSearch.queritMaxResults / queritTimeRange). */
  queritTimeRange?: string | null
  /**
   * Extra headers merged into the request. The renderer's `build-in` provider injects the
   * Chatbox platform headers (CHATBOX-PLATFORM/VERSION/...) so the shared call matches the
   * old `webBrowsing` remote request.
   */
  headers?: Record<string, string>
}

const TAVILY_DEFAULT_HOST = 'https://api.tavily.com'
const DEEPSEEK_DEFAULT_HOST = 'https://api.deepseek.com'
const CHATBOX_DEFAULT_ORIGIN = 'https://api.chatboxai.app'
const DEFAULT_MAX_RESULTS = 8
const DEEPSEEK_QUERY_MAX_CHARS = 128
const DEEPSEEK_DEFAULT_COUNT = 10
const DEEPSEEK_MAX_COUNT = 50

interface TavilyResponseItem {
  title?: string
  url?: string
  content?: string
}

export function hasNativeWebSearchConfiguration(
  settings: Pick<NativeWebSearchSettings, 'provider' | 'apiKey'> & Partial<Pick<NativeWebSearchSettings, 'apiHost'>>,
  licenseKey?: string
): boolean {
  if (settings.provider === 'searxng-deepseek') {
    return Boolean(settings.apiKey.trim() && settings.apiHost?.trim())
  }
  if (
    settings.provider === 'tavily' ||
    settings.provider === 'bocha' ||
    settings.provider === 'querit' ||
    settings.provider === 'deepseek'
  ) {
    return Boolean(settings.apiKey.trim())
  }
  if (settings.provider === 'build-in') return Boolean(licenseKey?.trim())
  if (settings.provider === 'searxng') return Boolean(settings.apiHost?.trim())
  return true // bing needs no credentials
}

export async function searchNativeWeb(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const provider = options.provider ?? 'tavily'
  if (provider === 'bing') return searchNativeBing(query, options)
  if (provider === 'build-in') return searchNativeChatbox(query, options)
  if (provider === 'bocha') return searchNativeBocha(query, options)
  if (provider === 'querit') return searchNativeQuerit(query, options)
  if (provider === 'searxng') return searchNativeSearxng(query, options)
  if (provider === 'deepseek') return searchNativeDeepSeek(query, options)
  if (provider === 'searxng-deepseek') return searchNativeSearxngDeepSeek(query, options)
  return searchNativeTavily(query, options)
}

interface SearxngResponseItem {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const TRACKING_QUERY_PARAMS = new Set(['fbclid', 'gclid', 'spm'])

/** Identity used to merge the same page without collapsing different query strings. */
export function normalizeResultUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => {
        const name = key.toLowerCase()
        return !name.startsWith('utm_') && !name.startsWith('spm.') && !TRACKING_QUERY_PARAMS.has(name)
      })
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    url.search = ''
    for (const [key, value] of kept) url.searchParams.append(key, value)
    return url.toString()
  } catch {
    return raw.trim()
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const omission = '...'
  if (maxLength <= omission.length) return omission.slice(0, maxLength)
  return value.slice(0, maxLength - omission.length) + omission
}

function richerSnippet(current: string, incoming: string): string {
  const next = incoming.trim()
  if (!next) return current
  if (!current) return next
  if (current.toLowerCase().includes(next.toLowerCase())) return current
  if (next.toLowerCase().includes(current.toLowerCase())) return next
  return current.length >= next.length ? current : next
}

function sourceRank(source: string): number {
  if (source === 'DeepSeek') return 0
  if (source === 'SearXNG') return 1
  return 2
}

function composeSnippets(snippets: Map<string, string>): { text: string; merged: boolean } {
  const entries = [...snippets.entries()]
    .map(([source, text]) => ({ source, text: text.trim() }))
    .filter((entry) => entry.text)
    .sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
  if (entries.length === 0) return { text: '', merged: false }

  const kept: Array<{ source: string; text: string }> = []
  for (const entry of entries) {
    if (kept.some((item) => item.text.toLowerCase().includes(entry.text.toLowerCase()))) continue
    const contained = kept.findIndex((item) => entry.text.toLowerCase().includes(item.text.toLowerCase()))
    if (contained >= 0 && kept.length === 1) {
      kept[0] = entry
      continue
    }
    kept.push(entry)
  }

  if (kept.length === 1) return { text: kept[0].text, merged: entries.length > 1 }
  return {
    text: kept
      .map((item) => (item.source.startsWith('__group_') ? item.text : `[${item.source}]\n${item.text}`))
      .join('\n\n'),
    merged: true,
  }
}

export interface SearchResultGroup {
  items: NativeWebSearchResultItem[]
  source?: string
}

/**
 * Round-robin merge that keeps both summaries when the same page was described differently.
 * Tracking parameters and hashes are ignored; other query parameters stay distinct.
 */
export function mergeSearchResults(
  groups: SearchResultGroup[],
  options?: { maxItems?: number; snippetLength?: number; mergedSnippetLength?: number }
): NativeWebSearchResultItem[] {
  const maxItems = options?.maxItems ?? (groups.length > 1 ? 16 : 10)
  const snippetLength = options?.snippetLength ?? 800
  const mergedSnippetLength = options?.mergedSnippetLength ?? 1200
  type Bucket = { title: string; link: string; rank: number; snippets: Map<string, string> }
  const buckets = new Map<string, Bucket>()
  let rank = 0
  let index = 0

  while (true) {
    let found = false
    groups.forEach((group, groupIndex) => {
      const item = group.items[index]
      if (!item) return
      found = true
      const link = item.link.trim()
      const title = item.title.trim()
      const snippet = item.snippet.trim()
      if (!link && !title && !snippet) return
      const source = group.source || `__group_${groupIndex}`
      const key = link ? normalizeResultUrl(link) : `nolink:${source}:${title}:${snippet}`
      const existing = buckets.get(key)
      if (!existing) {
        const snippets = new Map<string, string>()
        if (snippet) snippets.set(source, snippet)
        buckets.set(key, { title, link, rank: rank++, snippets })
        return
      }
      if (!existing.title && title) existing.title = title
      if (snippet) existing.snippets.set(source, richerSnippet(existing.snippets.get(source) ?? '', snippet))
    })
    if (!found) break
    index++
  }

  return [...buckets.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxItems)
    .map((bucket) => {
      const snippet = composeSnippets(bucket.snippets)
      return {
        title: bucket.title,
        link: bucket.link,
        snippet: truncateText(snippet.text, snippet.merged ? mergedSnippetLength : snippetLength),
      }
    })
}

function firstUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) return entry.trim()
    if (typeof entry === 'object' && entry !== null) {
      const url = nonEmptyString((entry as { url?: unknown }).url)
      if (url) return url
    }
  }
  return null
}

function infoboxSnippet(content: unknown, attributes: unknown): string {
  const body = nonEmptyString(content) ?? ''
  const rows = Array.isArray(attributes)
    ? attributes
        .map((attribute) => {
          if (typeof attribute !== 'object' || attribute === null) return null
          const label = nonEmptyString((attribute as { label?: unknown }).label)
          const value = nonEmptyString((attribute as { value?: unknown }).value)
          if (!label || !value) return null
          return `${label}: ${value}`
        })
        .filter((row): row is string => row !== null)
    : []
  return [body, ...rows].filter(Boolean).join('\n')
}

/** Maps a SearXNG JSON payload, including direct answers and infoboxes ahead of links. */
export function mapSearxngPayload(payload: unknown): NativeWebSearchResultItem[] {
  if (typeof payload !== 'object' || payload === null || !('results' in payload)) {
    throw new Error('SearXNG returned an invalid JSON search response')
  }
  const record = payload as { results?: unknown; answers?: unknown; infoboxes?: unknown }
  if (!Array.isArray(record.results)) throw new Error('SearXNG returned an invalid JSON search response')

  const items: NativeWebSearchResultItem[] = []
  if (Array.isArray(record.answers)) {
    for (const answer of record.answers) {
      const text =
        typeof answer === 'string'
          ? answer.trim()
          : typeof answer === 'object' && answer !== null
            ? nonEmptyString((answer as { answer?: unknown }).answer)
            : null
      if (!text) continue
      const link =
        typeof answer === 'object' && answer !== null ? (nonEmptyString((answer as { url?: unknown }).url) ?? '') : ''
      items.push({ title: 'Answer', link, snippet: text })
    }
  }
  if (Array.isArray(record.infoboxes)) {
    for (const box of record.infoboxes) {
      if (typeof box !== 'object' || box === null) continue
      const info = box as { title?: unknown; content?: unknown; urls?: unknown; attributes?: unknown }
      const snippet = infoboxSnippet(info.content, info.attributes)
      const link = firstUrl(info.urls) ?? ''
      if (!snippet && !link) continue
      items.push({ title: nonEmptyString(info.title) ?? 'Infobox', link, snippet })
    }
  }

  for (const item of record.results) {
    if (typeof item !== 'object' || item === null) continue
    const result = item as SearxngResponseItem
    const title = nonEmptyString(result.title)
    const link = nonEmptyString(result.url)
    if (!title || !link) continue
    items.push({
      title,
      link,
      snippet: nonEmptyString(result.content) ?? nonEmptyString(result.snippet) ?? '',
    })
  }
  return items
}

async function searchNativeSearxng(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  const host = (options.apiHost?.trim() ?? '').replace(/\/+$/, '')
  if (!host) throw new Error('SearXNG instance URL is required')

  const response = await fetchFn(`${host}/search?q=${encodeURIComponent(query)}&format=json`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)
  if (!response.ok) throw new Error(`SearXNG search failed with status ${response.status}`)

  return mapSearxngPayload(await response.json())
}

async function searchNativeSearxngDeepSeek(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const [searxng, deepseek] = await Promise.all([
    searchNativeSearxng(query, options)
      .then((items) => ({ items, source: 'SearXNG' as const }))
      .catch((error: unknown) => ({ error })),
    searchNativeDeepSeek(query, { ...options, apiHost: undefined })
      .then((items) => ({ items, source: 'DeepSeek' as const }))
      .catch((error: unknown) => ({ error })),
  ])
  const groups: SearchResultGroup[] = []
  if ('items' in searxng) groups.push(searxng)
  if ('items' in deepseek) groups.push(deepseek)
  if (groups.length === 0) {
    const failure = 'error' in searxng ? searxng.error : 'error' in deepseek ? deepseek.error : undefined
    throw failure instanceof Error ? failure : new Error('Web search failed')
  }
  return mergeSearchResults(groups, { maxItems: 16, snippetLength: 800, mergedSnippetLength: 1200 })
}

interface DeepSeekSearchResult {
  title?: unknown
  url?: unknown
  snippet?: unknown
  summary?: unknown
  date?: unknown
}

interface DeepSeekSearchResponse {
  results?: unknown
  error?: { message?: unknown }
}

/** DeepSeek accepts 1–128 Unicode characters and rejects an all-whitespace query. */
function normalizeDeepSeekQuery(query: string): string {
  return Array.from(query.trim()).slice(0, DEEPSEEK_QUERY_MAX_CHARS).join('').trim()
}

function deepSeekResultCount(maxResults: number | undefined): number {
  const requested = maxResults ?? DEEPSEEK_DEFAULT_COUNT
  if (!Number.isFinite(requested)) return DEEPSEEK_DEFAULT_COUNT
  return Math.min(DEEPSEEK_MAX_COUNT, Math.max(1, Math.trunc(requested)))
}

function deepSeekSnippet(item: DeepSeekSearchResult): string {
  const body = nonEmptyString(item.summary) ?? nonEmptyString(item.snippet) ?? ''
  const date = nonEmptyString(item.date)
  if (!date) return body
  return `[${date}] ${body}`.trim()
}

async function searchNativeDeepSeek(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const normalizedQuery = normalizeDeepSeekQuery(query)
  if (!normalizedQuery) return []

  const fetchFn = options.fetchFn ?? fetch
  const host = (options.apiHost?.trim() || DEEPSEEK_DEFAULT_HOST).replace(/\/+$/, '')
  const response = await fetchFn(`${host}/v1/tools/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey ?? ''}`,
    },
    body: JSON.stringify({
      query: normalizedQuery,
      count: deepSeekResultCount(options.maxResults),
      need_content: false,
    }),
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)

  const payload = (await response.json().catch(() => null)) as DeepSeekSearchResponse | null
  const errorMessage = nonEmptyString(payload?.error?.message)
  if (!response.ok || payload?.error) {
    throw new Error(errorMessage ?? `DeepSeek search failed with status ${response.status}`)
  }
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('DeepSeek search returned an invalid JSON response')
  }

  return payload.results
    .filter((item): item is DeepSeekSearchResult => typeof item === 'object' && item !== null)
    .map((item) => {
      const link = nonEmptyString(item.url)
      if (!link) return null
      return {
        title: nonEmptyString(item.title) ?? '',
        link,
        snippet: deepSeekSnippet(item),
      }
    })
    .filter((item): item is NativeWebSearchResultItem => item !== null)
}

// BoCha and Querit are plain JSON APIs, shared verbatim with the renderer
// provider shells (packages/web-search/bocha.ts, querit.ts).

interface BochaResponse {
  code?: number | string
  msg?: string | null
  message?: string | null
  data?: { webPages?: { value?: Array<{ name: string; url: string; summary?: string; snippet?: string }> } }
  webPages?: { value?: Array<{ name: string; url: string; summary?: string; snippet?: string }> }
}

const BOCHA_ENDPOINTS = ['https://api.bocha.cn/v1/web-search', 'https://api.bochaai.com/v1/web-search']

async function searchNativeBocha(query: string, options: NativeWebSearchOptions): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  let payload: BochaResponse | undefined
  let lastError: unknown

  for (const endpoint of BOCHA_ENDPOINTS) {
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey ?? ''}`,
        },
        body: JSON.stringify({ query, freshness: 'noLimit', summary: true, count: 10 }),
        signal: options.signal as NativeFetchInit['signal'],
      } as NativeFetchInit)
      if (!response.ok) {
        lastError = new Error(`BoCha API error: ${response.status}`)
        continue
      }
      const res = (await response.json()) as BochaResponse
      const responseCode = Number(res.code)
      if (!Number.isNaN(responseCode) && responseCode !== 200) {
        lastError = new Error(res.msg || res.message || `BoCha API error: ${res.code}`)
        continue
      }
      if ((res.code ?? null) !== null && Number.isNaN(responseCode)) {
        lastError = new Error(res.msg || res.message || `BoCha API error: ${res.code}`)
        continue
      }
      const results = res.data?.webPages?.value ?? res.webPages?.value
      if (!Array.isArray(results)) {
        lastError = new Error('BoCha API malformed payload: webPages.value is not an array')
        continue
      }
      payload = res
      break
    } catch (error) {
      lastError = error
    }
  }

  if (!payload) {
    throw lastError || new Error('BoCha API request failed on all endpoints')
  }

  const results = payload.data?.webPages?.value || payload.webPages?.value || []
  return results.map((result) => ({
    title: result.name,
    link: result.url,
    snippet: result.summary || result.snippet || '',
  }))
}

export const QUERIT_SEARCH_URL = 'https://api.querit.ai/v1/search'

async function searchNativeQuerit(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  const timeRange = options.queritTimeRange === 'none' ? null : (options.queritTimeRange ?? null)
  const body: { query: string; count: number; filters?: { timeRange: { date: string } } } = {
    query,
    count: options.maxResults ?? 5,
  }
  if (timeRange) {
    body.filters = { timeRange: { date: timeRange } }
  }

  const response = await fetchFn(QUERIT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey ?? ''}`,
    },
    body: JSON.stringify(body),
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)
  if (!response.ok) {
    throw new Error(`Querit search failed with status ${response.status}`)
  }
  const payload = (await response.json()) as {
    error_code?: number
    error?: unknown
    results?: { result?: Array<{ title: string; url: string; snippet: string }> }
  }
  if (payload.error_code !== 200) {
    // Keep the renderer's diagnostic: an HTTP 200 with a business error_code
    // (e.g. invalid/expired key) otherwise yields zero results with no trace.
    console.error('Querit search API error:', payload.error_code, payload.error)
    return []
  }
  if (!payload.results?.result || !Array.isArray(payload.results.result)) {
    return []
  }
  return payload.results.result.map((result) => ({
    title: result.title,
    link: result.url,
    snippet: result.snippet,
  }))
}

async function searchNativeTavily(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  const host = (options.apiHost?.trim() || TAVILY_DEFAULT_HOST).replace(/\/+$/, '')
  // Cap is opt-in: the renderer Tavily provider passes no maxResults, preserving the
  // pre-extraction behavior of returning every result Tavily sent (its own server-side
  // default). Native callers can pass maxResults to bound both request and response.
  const maxResults = options.maxResults

  const body: {
    query: string
    search_depth: string
    include_domains: string[]
    exclude_domains: string[]
    max_results?: number
  } = {
    query,
    search_depth: 'basic',
    include_domains: [],
    exclude_domains: [],
  }
  if (maxResults !== undefined) {
    body.max_results = maxResults
  }

  const response = await fetchFn(`${host}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey ?? ''}`,
    },
    body: JSON.stringify(body),
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)
  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`)
  }

  const payload = (await response.json()) as { results?: TavilyResponseItem[] }
  const results = Array.isArray(payload.results) ? payload.results : []
  // No link filtering: matches the old renderer Tavily provider, which returned every
  // result Tavily sent (link-less items included) for the model to use.
  const items = results.map((item) => ({
    title: item.title ?? '',
    link: item.url ?? '',
    snippet: item.content ?? '',
  }))
  return maxResults !== undefined ? items.slice(0, maxResults) : items
}

/**
 * Chatbox build-in search — single implementation behind the renderer's `build-in`
 * provider (which injects an afetch `fetchFn` for retry + Chatbox error parsing, plus the
 * Chatbox platform `headers`) and the native shell. `POST /api/tool/web-search`, license
 * key as Authorization. Replaces the old `webBrowsing` remote fork.
 */
async function searchNativeChatbox(
  query: string,
  options: NativeWebSearchOptions
): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  const origin = (options.chatboxApiOrigin?.trim() || CHATBOX_DEFAULT_ORIGIN).replace(/\/+$/, '')

  const response = await fetchFn(`${origin}/api/tool/web-search`, {
    method: 'POST',
    headers: {
      Authorization: options.licenseKey ?? '',
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({ query }),
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown
    data?: { links?: Array<{ title?: string; url?: string; content?: string }> }
  } | null
  if (!response.ok) {
    // afetch (renderer) throws its parsed Chatbox error before we get here; this path
    // gives the native plain-fetch caller a meaningful message instead of a bare status.
    const message =
      payload && typeof payload.error === 'string' ? payload.error : `Web search failed with status ${response.status}`
    throw new Error(message)
  }
  // No client-side cap or link filtering: matches the old `webBrowsing` remote call, which
  // returned every link the Chatbox backend sent (already a bounded ~10 Serper organic
  // results + PeopleAlsoAsk set), so trimming here would only drop the tail.
  const links = payload?.data?.links ?? []
  return links.map((link) => ({
    title: link.title ?? '',
    link: link.url ?? '',
    snippet: link.content ?? '',
  }))
}

/**
 * Bing SERP search — the renderer's BingSearch port. React Native has no
 * DOMParser, so the `li.b_algo` items are extracted with tolerant regexes.
 */
async function searchNativeBing(query: string, options: NativeWebSearchOptions): Promise<NativeWebSearchResultItem[]> {
  const fetchFn = options.fetchFn ?? fetch
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const response = await fetchFn(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    method: 'GET',
    headers: {
      // Bing serves an empty JS shell to non-browser clients (okhttp/CFNetwork),
      // so present a desktop browser. Results are still best-effort.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: options.signal as NativeFetchInit['signal'],
  } as NativeFetchInit)
  if (!response.ok) {
    throw new Error(`Web search failed with status ${response.status}`)
  }
  const html = await response.text()
  return extractBingResults(html).slice(0, maxResults)
}

export function extractBingResults(html: string): NativeWebSearchResultItem[] {
  const items: NativeWebSearchResultItem[] = []
  const liPattern = /<li class="b_algo[^"]*"[\s\S]*?(?=<li class="b_algo|<\/ol>|$)/g
  for (const block of html.match(liPattern) ?? []) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!anchor) continue
    const link = decodeHtmlEntities(anchor[1])
    const title = decodeHtmlEntities(stripTags(anchor[2])).trim()
    if (!link || !title) continue
    const snippetMatch =
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ??
      /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const snippet = snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])).trim() : ''
    items.push({ title, link, snippet })
  }
  return items
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export function formatNativeWebSearchContext(query: string, items: NativeWebSearchResultItem[]): string {
  if (items.length === 0) return ''
  const entries = items
    .map((item, index) => `${index + 1}. ${item.title}\n${item.link}\n${item.snippet}`.trim())
    .join('\n\n')
  return [
    '<WEB_SEARCH_RESULTS>',
    `The following are web search results for the query: ${query}`,
    'Use them to ground your answer and cite sources by their URLs when relevant.',
    '',
    entries,
    '</WEB_SEARCH_RESULTS>',
  ].join('\n')
}
