import { ChatboxAIAPIError } from '@shared/models/errors'
import { searchNativeWeb } from '@shared/services/native-web-search'
import type { SearchResult } from '@shared/types'
import WebSearch, { type ParseLinkResult } from './base'

const DEEPSEEK_FETCH_URL = 'https://api.deepseek.com/v1/tools/fetch'

export class DeepSeekSearch extends WebSearch {
  private apiKey: string

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
    const content = typeof response?.content === 'string' ? response.content : ''
    if (errorMessage || !content.trim()) {
      const technical = errorMessage || `DeepSeek fetch API returned no content for ${url}`
      throw ChatboxAIAPIError.fromCodeName(technical, 'parse_link_failed') ?? new Error(technical)
    }

    const title = typeof response?.title === 'string' ? response.title.trim() : ''
    let fallbackTitle = url
    try {
      const hostname = new URL(url).hostname
      if (hostname) fallbackTitle = hostname
    } catch {}

    return {
      url,
      title: title || fallbackTitle,
      content,
    }
  }
}
