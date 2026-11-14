import { mapSearxngPayload } from '@shared/services/native-web-search'
import type { SearchResult } from '@shared/types'
import WebSearch from './base'

export function normalizeSearxngBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}

export class SearxngSearch extends WebSearch {
  override sourceLabel = 'SearXNG'
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    super()
    this.baseUrl = normalizeSearxngBaseUrl(baseUrl)
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    try {
      const response = await this.fetch(`${this.baseUrl}/search`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        query: {
          q: query,
          format: 'json',
        },
        responseType: 'json',
        signal,
      })
      return { items: mapSearxngPayload(response) }
    } catch (error) {
      console.error('SearXNG search error:', error)
      throw error
    }
  }
}
