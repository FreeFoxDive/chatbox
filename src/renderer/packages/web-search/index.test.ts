import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the settings actions before importing the module under test
vi.mock('@/stores/settingActions', () => ({
  getExtensionSettings: vi.fn(),
  getLanguage: vi.fn(() => 'en'),
  getLicenseKey: vi.fn(() => 'test-license-key'),
  getDeepSeekProviderApiKey: vi.fn(() => ''),
}))

// Mock the search providers to avoid actual network calls
vi.mock('./bing', () => {
  return {
    BingSearch: class {
      search = vi.fn().mockResolvedValue({
        items: [{ title: 'Bing Result', snippet: 'test', link: 'https://example.com' }],
      })
    },
  }
})

vi.mock('./bing-news', () => {
  return {
    BingNewsSearch: class {
      search = vi.fn().mockResolvedValue({ items: [] })
    },
  }
})

vi.mock('./tavily', () => {
  return {
    TavilySearch: class {
      constructor(private readonly apiKey: string) {}
      search = vi.fn().mockImplementation(async () => {
        if (this.apiKey === 'failing-key') throw new Error('Tavily unavailable')
        return { items: [{ title: 'Tavily Result', snippet: 'test', link: 'https://example.com' }] }
      })
    },
  }
})

vi.mock('./searxng', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./searxng')>()
  return {
    ...actual,
    SearxngSearch: class {
      sourceLabel = 'SearXNG'
      constructor(private readonly baseUrl: string) {}
      search = vi.fn().mockImplementation((query: string) => {
        if (query === 'searxng-down' || query === 'both-down') throw new Error('SearXNG unavailable')
        return {
          items: [
            {
              title: `SearXNG Result ${this.baseUrl}`,
              snippet: 'searx snippet',
              link: 'https://example.com/shared?id=1',
            },
          ],
        }
      })
    },
  }
})

vi.mock('./deepseek', () => {
  return {
    DeepSeekSearch: class {
      sourceLabel = 'DeepSeek'
      supportsParseLink = true
      constructor(private readonly apiKey: string) {}
      search = vi.fn().mockImplementation((query: string) => {
        if (query === 'deepseek-down' || query === 'both-down') throw new Error('DeepSeek unavailable')
        return {
          items: [
            {
              title: `DeepSeek Result ${this.apiKey}`,
              snippet: 'x'.repeat(900),
              link: 'https://example.com/shared?id=1&utm_source=ad',
            },
          ],
        }
      })
    },
  }
})

vi.mock('./chatbox-search', () => {
  return {
    ChatboxSearch: class {
      search = vi.fn().mockResolvedValue({
        items: [{ title: 'Chatbox Result', snippet: 'test', link: 'https://example.com' }],
      })
    },
  }
})

import { mergeSearchResults } from '@shared/services/native-web-search'
import { getDeepSeekProviderApiKey, getExtensionSettings } from '@/stores/settingActions'
import { getParseLinkProvider, testWebSearchConnection, webSearchExecutor } from './index'

const mockGetExtensionSettings = vi.mocked(getExtensionSettings)
const mockGetDeepSeekProviderApiKey = vi.mocked(getDeepSeekProviderApiKey)

describe('webSearchExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDeepSeekProviderApiKey.mockReturnValue('')
  })

  it('returns different results for different providers with same query', async () => {
    // First call with bing
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'bing', tavilyApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    const bingResult = await webSearchExecutor({ query: 'test query' }, {})
    expect(bingResult.searchResults).toHaveLength(1)
    expect(bingResult.searchResults[0].title).toBe('Bing Result')

    // Same query but different provider should NOT return cached bing results
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'test-key' },
    } as ReturnType<typeof getExtensionSettings>)

    const tavilyResult = await webSearchExecutor({ query: 'test query' }, {})
    expect(tavilyResult.searchResults).toHaveLength(1)
    expect(tavilyResult.searchResults[0].title).toBe('Tavily Result')
  })

  it('returns cached results for same provider and query', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'bing', tavilyApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    const result1 = await webSearchExecutor({ query: 'cached query' }, {})
    const result2 = await webSearchExecutor({ query: 'cached query' }, {})

    // Both should return same results (cached)
    expect(result1.searchResults).toEqual(result2.searchResults)
  })

  it('uses a distinct cache key for the SearXNG provider', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const searxngResult = await webSearchExecutor({ query: 'searxng query' }, {})

    expect(searxngResult.searchResults).toHaveLength(1)
    expect(searxngResult.searchResults[0].title).toBe('SearXNG Result https://searx.example.com')
  })

  it('does not reuse cache when the SearXNG instance URL changes', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-a.example.com/' },
    } as ReturnType<typeof getExtensionSettings>)

    const first = await webSearchExecutor({ query: 'instance query' }, {})
    expect(first.searchResults[0].title).toBe('SearXNG Result https://searx-a.example.com')

    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-b.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const second = await webSearchExecutor({ query: 'instance query' }, {})
    expect(second.searchResults[0].title).toBe('SearXNG Result https://searx-b.example.com')
  })

  it('reuses cache when the same SearXNG instance is written with a trailing slash', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-cache.example.com/' },
    } as ReturnType<typeof getExtensionSettings>)

    const first = await webSearchExecutor({ query: 'normalized instance query' }, {})

    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: 'https://searx-cache.example.com' },
    } as ReturnType<typeof getExtensionSettings>)

    const second = await webSearchExecutor({ query: 'normalized instance query' }, {})
    expect(second.searchResults).toEqual(first.searchResults)
  })

  it('rejects a whitespace-only SearXNG instance URL', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng', searxngBaseUrl: '   ' },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'missing url' }, {})).rejects.toMatchObject({
      code: 20036,
    })
  })

  it('falls back to the DeepSeek model provider API key', async () => {
    mockGetDeepSeekProviderApiKey.mockReturnValue('provider-key')
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'deepseek', deepseekApiKey: '  ' },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'deepseek provider fallback' }, {})

    expect(result.searchResults[0].title).toBe('DeepSeek Result provider-key')
  })

  it('prefers the dedicated DeepSeek web search API key', async () => {
    mockGetDeepSeekProviderApiKey.mockReturnValue('provider-key')
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'deepseek', deepseekApiKey: 'search-key' },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'deepseek dedicated key' }, {})

    expect(result.searchResults[0].title).toBe('DeepSeek Result search-key')
  })

  it('rejects DeepSeek search when neither API key is set', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'deepseek', deepseekApiKey: '' },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'deepseek missing key' }, {})).rejects.toMatchObject({
      code: 20048,
    })
  })

  it('keeps search summaries up to 800 characters', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'deepseek', deepseekApiKey: 'search-key' },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'deepseek long summary' }, {})

    expect(result.searchResults[0].snippet).toHaveLength(800)
    expect(result.searchResults[0].snippet.endsWith('...')).toBe(true)
    expect(result.searchResults[0].snippet.startsWith('x')).toBe(true)
  })

  it('merges SearXNG and DeepSeek summaries for the same page', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'hybrid shared page' }, {})

    expect(result.searchResults).toHaveLength(1)
    expect(result.searchResults[0].title).toBe('SearXNG Result https://searx.example.com')
    expect(result.searchResults[0].snippet).toContain('[DeepSeek]')
    expect(result.searchResults[0].snippet).toContain('[SearXNG]')
    expect(result.searchResults[0].snippet).toContain('searx snippet')
    expect(result.searchResults[0].link).toBe('https://example.com/shared?id=1')
  })

  it('reads pages through DeepSeek when both providers are configured', () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)

    const provider = getParseLinkProvider()

    expect(provider?.supportsParseLink).toBe(true)
    expect(provider?.sourceLabel).toBe('DeepSeek')
  })

  it('requires the SearXNG instance before reading a page for the combined provider', () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'searxng-deepseek', searxngBaseUrl: '  ', deepseekApiKey: 'search-key' },
    } as ReturnType<typeof getExtensionSettings>)

    expect(() => getParseLinkProvider()).toThrow(expect.objectContaining({ code: 20036 }))
  })

  it('keeps the other side when SearXNG fails', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)

    const result = await webSearchExecutor({ query: 'searxng-down' }, {})

    expect(result.searchResults).toHaveLength(1)
    expect(result.searchResults[0].title).toBe('DeepSeek Result search-key')
  })

  it('rejects the hybrid search when both sides fail', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'both-down' }, {})).rejects.toThrow('SearXNG unavailable')
  })

  it('does not reuse a hybrid result after the SearXNG instance or DeepSeek key readiness changes', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx-a.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)
    const first = await webSearchExecutor({ query: 'hybrid cache' }, {})
    expect(first.searchResults[0].title).toBe('SearXNG Result https://searx-a.example.com')

    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx-b.example.com',
        deepseekApiKey: 'search-key',
      },
    } as ReturnType<typeof getExtensionSettings>)
    const second = await webSearchExecutor({ query: 'hybrid cache' }, {})
    expect(second.searchResults[0].title).toBe('SearXNG Result https://searx-b.example.com')

    mockGetExtensionSettings.mockReturnValue({
      webSearch: {
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx-b.example.com',
        deepseekApiKey: '',
      },
    } as ReturnType<typeof getExtensionSettings>)
    await expect(webSearchExecutor({ query: 'hybrid cache' }, {})).rejects.toMatchObject({ code: 20048 })
  })

  it('keeps pages with different query parameters and caps a hybrid merge at 16 results', () => {
    const distinct = mergeSearchResults(
      [
        {
          source: 'SearXNG',
          items: [{ title: 'Page 1', link: 'https://example.com/item?id=1', snippet: 'first' }],
        },
        {
          source: 'DeepSeek',
          items: [{ title: 'Page 2', link: 'https://example.com/item?id=2', snippet: 'second' }],
        },
      ],
      { maxItems: 16 }
    )
    expect(distinct.map((item) => item.link)).toEqual([
      'https://example.com/item?id=1',
      'https://example.com/item?id=2',
    ])

    const searxng = Array.from({ length: 20 }, (_, index) => ({
      title: `SearXNG ${index}`,
      link: `https://searx.example/${index}`,
      snippet: `searx ${index}`,
    }))
    const deepseek = Array.from({ length: 20 }, (_, index) => ({
      title: `DeepSeek ${index}`,
      link: `https://deepseek.example/${index}`,
      snippet: `deepseek ${index}`,
    }))
    expect(
      mergeSearchResults([
        { source: 'SearXNG', items: searxng },
        { source: 'DeepSeek', items: deepseek },
      ])
    ).toHaveLength(16)
  })

  it('propagates the provider error when every configured provider fails', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'failing-key' },
    } as ReturnType<typeof getExtensionSettings>)

    await expect(webSearchExecutor({ query: 'provider failure' }, {})).rejects.toThrow('Tavily unavailable')
  })
})

describe('testWebSearchConnection', () => {
  it('checks current credentials even when a successful query is cached', async () => {
    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'working-key' },
    } as ReturnType<typeof getExtensionSettings>)
    await webSearchExecutor({ query: 'Chatbox' }, {})
    await expect(testWebSearchConnection()).resolves.toBeUndefined()

    mockGetExtensionSettings.mockReturnValue({
      webSearch: { provider: 'tavily', tavilyApiKey: 'failing-key' },
    } as ReturnType<typeof getExtensionSettings>)
    await expect(testWebSearchConnection()).rejects.toThrow('Tavily unavailable')
  })
})
