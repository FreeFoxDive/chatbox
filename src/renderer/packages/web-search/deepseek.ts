import { Readability } from '@mozilla/readability'
import { ChatboxAIAPIError } from '@shared/models/errors'
import { searchNativeWeb } from '@shared/services/native-web-search'
import type { SearchResult } from '@shared/types'
import { parseHTML } from 'linkedom'
import WebSearch, { type ParseLinkResult } from './base'

const DEEPSEEK_FETCH_URL = 'https://api.deepseek.com/v1/tools/fetch'

export class DeepSeekSearch extends WebSearch {
  private apiKey: string

  override sourceLabel = 'DeepSeek'
  override supportsParseLink = true

  constructor(apiKey: string) {
    super()
    this.apiKey = apiKey
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    try {
      const items = await searchNativeWeb(query, {
        provider: 'deepseek',
        apiKey: this.apiKey,
        signal,
        fetchFn: this.fetchCompat,
      })
      return { items }
    } catch (error) {
      console.error('DeepSeek search error:', error)
      throw error
    }
  }

  async parseLink(url: string, signal?: AbortSignal): Promise<ParseLinkResult> {
    let remoteError = ''
    try {
      const remote = await this.fetchDeepSeekPage(url, signal)
      if (remote) return remote
      remoteError = `DeepSeek fetch API returned no content for ${url}`
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error)
    }

    try {
      const local = await this.fetchPageDirectly(url, signal)
      if (local) return local
    } catch (error) {
      const localError = error instanceof Error ? error.message : String(error)
      remoteError = remoteError ? `${remoteError}; local fetch failed: ${localError}` : localError
    }

    const technical = remoteError || `DeepSeek fetch API returned no content for ${url}`
    throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_failed') ?? new Error(technical)
  }

  private async fetchDeepSeekPage(url: string, signal?: AbortSignal): Promise<ParseLinkResult | null> {
    const response = (await this.fetch(DEEPSEEK_FETCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: { url },
      responseType: 'json',
      signal,
    })) as { title?: unknown; content?: unknown; error?: { message?: unknown } } | null

    const errorMessage = typeof response?.error?.message === 'string' ? response.error.message.trim() : ''
    if (errorMessage) throw new Error(errorMessage)
    const content = typeof response?.content === 'string' ? response.content.trim() : ''
    if (!content) return null

    const title = typeof response?.title === 'string' ? response.title.trim() : ''
    return { url, title: title || pageTitleFallback(url), content }
  }

  private async fetchPageDirectly(url: string, signal?: AbortSignal): Promise<ParseLinkResult | null> {
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      responseType: 'text',
      throwOnHttpError: true,
      signal,
    })
    if (typeof response !== 'string' || !response.trim()) return null
    const page = extractReadablePage(response, url)
    if (!page) return null
    return { url, title: page.title || pageTitleFallback(url), content: page.content }
  }
}

function pageTitleFallback(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function extractReadablePage(body: string, url: string): { title: string; content: string } | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  if (!/<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return { title: pageTitleFallback(url), content: trimmed }
  }

  try {
    const { document } = parseHTML(trimmed)
    const base = document.createElement('base')
    base.setAttribute('href', url)
    document.head?.prepend(base)
    for (const node of document.querySelectorAll('script, style, noscript, template')) node.remove()
    const visible = (document.body?.textContent ?? '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const article = new Readability(document as unknown as Document).parse()
    const articleText = (article?.textContent ?? '').trim()
    const content = articleText.length >= 80 ? articleText : visible || articleText
    if (!content) return null
    const title = article?.title?.trim() || document.title?.trim() || pageTitleFallback(url)
    return { title, content }
  } catch {
    return null
  }
}
