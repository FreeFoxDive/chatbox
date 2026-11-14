import { cachified } from '@epic-web/cachified'
import { mergeSearchResults } from '@shared/services/native-web-search'
import type { SearchResultItem } from '@shared/types'
import platform from '@/platform'
import { getDeepSeekProviderApiKey, getExtensionSettings, getLanguage, getLicenseKey } from '@/stores/settingActions'
import { ChatboxAIAPIError } from '../../../shared/models/errors'
import type WebSearch from './base'
import { BingSearch } from './bing'
import { BingNewsSearch } from './bing-news'
import { BochaSearch } from './bocha'
import { ChatboxSearch } from './chatbox-search'
import { resolveDeepSeekWebSearchApiKey } from './configuration-issue'
import { DeepSeekSearch } from './deepseek'
import { QueritSearch } from './querit'
import { normalizeSearxngBaseUrl, SearxngSearch } from './searxng'
import { TavilySearch } from './tavily'

const MAX_CONTEXT_ITEMS = 10
const MAX_HYBRID_CONTEXT_ITEMS = 16
const MAX_SNIPPET_LENGTH = 800
const MAX_MERGED_SNIPPET_LENGTH = 1200

// 根据配置的搜索提供方来选择搜索服务
function getSearchProviders() {
  const settings = getExtensionSettings()
  const licenseKey = getLicenseKey()

  const selectedProviders: WebSearch[] = []
  const provider = settings.webSearch.provider
  const language = getLanguage()

  switch (provider) {
    case 'build-in':
      if (!licenseKey) {
        throw ChatboxAIAPIError.fromCodeName(
          'chatbox_search_license_key_required',
          'chatbox_search_license_key_required'
        )
      }
      selectedProviders.push(new ChatboxSearch(licenseKey))
      break
    case 'bing':
      selectedProviders.push(new BingSearch())
      if (language !== 'zh-Hans' && platform.type !== 'mobile') {
        selectedProviders.push(new BingNewsSearch()) // 国内和移动端容易被重定向到 Bing 首页
      }
      break
    case 'tavily':
      if (!settings.webSearch.tavilyApiKey) {
        throw ChatboxAIAPIError.fromCodeName('tavily_api_key_required', 'tavily_api_key_required')
      }
      selectedProviders.push(new TavilySearch(settings.webSearch.tavilyApiKey))
      break
    case 'bocha':
      if (!settings.webSearch.bochaApiKey) {
        throw ChatboxAIAPIError.fromCodeName('bocha_api_key_required', 'bocha_api_key_required')
      }
      selectedProviders.push(new BochaSearch(settings.webSearch.bochaApiKey))
      break
    case 'querit':
      if (!settings.webSearch.queritApiKey) {
        throw ChatboxAIAPIError.fromCodeName('querit_api_key_required', 'querit_api_key_required')
      }
      selectedProviders.push(
        new QueritSearch(
          settings.webSearch.queritApiKey,
          settings.webSearch.queritMaxResults,
          settings.webSearch.queritTimeRange
        )
      )
      break
    case 'searxng': {
      const searxngBaseUrl = normalizeSearxngBaseUrl(settings.webSearch.searxngBaseUrl ?? '')
      if (!searxngBaseUrl) {
        throw ChatboxAIAPIError.fromCodeName('searxng_base_url_required', 'searxng_base_url_required')
      }
      selectedProviders.push(new SearxngSearch(searxngBaseUrl))
      break
    }
    case 'deepseek': {
      const apiKey = resolveDeepSeekWebSearchApiKey(settings.webSearch.deepseekApiKey, getDeepSeekProviderApiKey())
      if (!apiKey) {
        throw ChatboxAIAPIError.fromCodeName('deepseek_api_key_required', 'deepseek_api_key_required')
      }
      selectedProviders.push(new DeepSeekSearch(apiKey))
      break
    }
    case 'searxng-deepseek': {
      const searxngBaseUrl = normalizeSearxngBaseUrl(settings.webSearch.searxngBaseUrl ?? '')
      if (!searxngBaseUrl) {
        throw ChatboxAIAPIError.fromCodeName('searxng_base_url_required', 'searxng_base_url_required')
      }
      const apiKey = resolveDeepSeekWebSearchApiKey(settings.webSearch.deepseekApiKey, getDeepSeekProviderApiKey())
      if (!apiKey) {
        throw ChatboxAIAPIError.fromCodeName('deepseek_api_key_required', 'deepseek_api_key_required')
      }
      selectedProviders.push(new SearxngSearch(searxngBaseUrl), new DeepSeekSearch(apiKey))
      break
    }
    default:
      throw new Error(`Unsupported search provider: ${provider}`)
  }

  return selectedProviders
}

async function _searchRelatedResults(query: string, signal?: AbortSignal) {
  const providers = getSearchProviders()
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await provider.search(query, signal)
        console.debug(`web search result for "${query}":`, result.items)
        return { result, source: provider.sourceLabel }
      } catch (err) {
        console.error(err)
        return { error: err }
      }
    })
  )

  const successfulResults = results.flatMap((entry) => (entry.result ? [entry] : []))
  if (successfulResults.length === 0) {
    throw results[0]?.error ?? new Error('Web search failed')
  }

  const items: SearchResultItem[] = mergeSearchResults(
    successfulResults.map((entry) => ({ items: entry.result.items, source: entry.source || undefined })),
    {
      maxItems: successfulResults.length > 1 ? MAX_HYBRID_CONTEXT_ITEMS : MAX_CONTEXT_ITEMS,
      snippetLength: MAX_SNIPPET_LENGTH,
      mergedSnippetLength: MAX_MERGED_SNIPPET_LENGTH,
    }
  )

  console.debug('web search items', items)
  return items
}

export async function testWebSearchConnection(signal?: AbortSignal): Promise<void> {
  await _searchRelatedResults('Chatbox', signal)
}

const cache = new Map()

export const webSearchExecutor = async (
  { query }: { query: string },
  { abortSignal }: { abortSignal?: AbortSignal }
) => {
  const webSearch = getExtensionSettings().webSearch
  const provider = webSearch.provider
  const searxngBaseUrl = normalizeSearxngBaseUrl(webSearch.searxngBaseUrl ?? '')
  const cacheIdentity =
    provider === 'searxng'
      ? `${provider}:${searxngBaseUrl}`
      : provider === 'searxng-deepseek'
        ? `${provider}:${searxngBaseUrl}:${
            resolveDeepSeekWebSearchApiKey(webSearch.deepseekApiKey, getDeepSeekProviderApiKey())
              ? 'deepseek'
              : 'no-deepseek'
          }`
        : provider
  const searchResults = await cachified({
    cache,
    key: `search-context:${cacheIdentity}:${query}`,
    ttl: 1000 * 60 * 5,
    getFreshValue: () => _searchRelatedResults(query, abortSignal),
  })
  return { query, searchResults }
}

/**
 * Single source of truth: which configured providers offer the parse_link tool.
 * Keep in sync with the provider classes' `supportsParseLink` flags.
 */
export const PROVIDERS_WITH_PARSE_LINK: ReadonlySet<string> = new Set([
  'build-in',
  'tavily',
  'deepseek',
  'searxng-deepseek',
])

/**
 * Returns the first configured search provider that supports parseLink.
 * Throws the underlying provider error (e.g. missing API key) — caller decides how to handle.
 */
export function getParseLinkProvider(): WebSearch | null {
  const providers = getSearchProviders()
  return providers.find((p) => p.supportsParseLink) ?? null
}

export type { SearchResultItem }
