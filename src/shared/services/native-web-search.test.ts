import { describe, expect, it, vi } from 'vitest'
import {
  formatNativeWebSearchContext,
  hasNativeWebSearchConfiguration,
  mergeSearchResults,
  searchNativeWeb,
} from './native-web-search'

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('native web search', () => {
  it('detects configuration presence per provider', () => {
    expect(hasNativeWebSearchConfiguration({ provider: 'tavily', apiKey: '' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'tavily', apiKey: '  ' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'tavily', apiKey: 'tvly-key' })).toBe(true)
    expect(hasNativeWebSearchConfiguration({ provider: 'bing', apiKey: '' })).toBe(true)
    expect(hasNativeWebSearchConfiguration({ provider: 'build-in', apiKey: '' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'build-in', apiKey: '' }, 'license-1')).toBe(true)
    expect(hasNativeWebSearchConfiguration({ provider: 'searxng', apiKey: '', apiHost: '' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'searxng', apiKey: '', apiHost: 'https://search.test' })).toBe(
      true
    )
    expect(hasNativeWebSearchConfiguration({ provider: 'deepseek', apiKey: '' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'deepseek', apiKey: '  ' })).toBe(false)
    expect(hasNativeWebSearchConfiguration({ provider: 'deepseek', apiKey: 'sk-key' })).toBe(true)
    expect(hasNativeWebSearchConfiguration({ provider: 'searxng-deepseek', apiKey: 'sk-key', apiHost: '' })).toBe(false)
    expect(
      hasNativeWebSearchConfiguration({ provider: 'searxng-deepseek', apiKey: '', apiHost: 'https://searx.test' })
    ).toBe(false)
    expect(
      hasNativeWebSearchConfiguration({
        provider: 'searxng-deepseek',
        apiKey: 'sk-key',
        apiHost: 'https://searx.test',
      })
    ).toBe(true)
  })

  it('searches through the chatbox build-in endpoint with the license key and injected headers', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { links: [{ title: 'Doc', url: 'https://doc.test', content: 'snippet' }] } }),
    })) as unknown as typeof fetch
    const items = await searchNativeWeb('chatbox', {
      provider: 'build-in',
      licenseKey: 'license-1',
      chatboxApiOrigin: 'http://10.0.2.2:8095',
      headers: { 'CHATBOX-PLATFORM': 'web', 'CHATBOX-VERSION': '1.2.3' },
      fetchFn,
    })
    expect(items).toEqual([{ title: 'Doc', link: 'https://doc.test', snippet: 'snippet' }])
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('http://10.0.2.2:8095/api/tool/web-search')
    expect(call[1].headers.Authorization).toBe('license-1')
    // Injected Chatbox platform headers ride along (renderer afetch/headers parity).
    expect(call[1].headers).toMatchObject({ 'CHATBOX-PLATFORM': 'web', 'CHATBOX-VERSION': '1.2.3' })
  })

  it('surfaces the chatbox error body when the build-in endpoint fails', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'License expired' }),
    })) as unknown as typeof fetch
    await expect(searchNativeWeb('chatbox', { provider: 'build-in', licenseKey: 'bad', fetchFn })).rejects.toThrow(
      'License expired'
    )
  })

  it('extracts bing results without DOMParser', async () => {
    const html = `<ol id="b_results"><li class="b_algo"><h2><a href="https://one.test/page?a=1&amp;b=2">First &amp; Best</a></h2><div class="b_caption"><p>Snippet one</p></div></li><li class="b_algo"><h2><a href="https://two.test">Second<strong> result</strong></a></h2><p class="b_lineclamp2">Snippet two</p></li></ol>`
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => html,
    })) as unknown as typeof fetch
    const items = await searchNativeWeb('chatbox', { provider: 'bing', fetchFn })
    expect(items).toEqual([
      { title: 'First & Best', link: 'https://one.test/page?a=1&b=2', snippet: 'Snippet one' },
      { title: 'Second result', link: 'https://two.test', snippet: 'Snippet two' },
    ])
  })

  it('searches through the tavily-compatible endpoint with an injectable host', async () => {
    const fetchFn = mockFetchResponse({
      results: [
        { title: 'One', url: 'https://one.test', content: 'first snippet' },
        { title: 'Two', url: 'https://two.test', content: 'second snippet' },
        // Link-less results are kept (link: '') and passed to the model, matching the
        // old renderer Tavily provider which returned every result Tavily sent.
        { title: 'No link', content: 'no url' },
      ],
    })
    const items = await searchNativeWeb('chatbox', {
      apiKey: 'key-1',
      apiHost: 'http://10.0.2.2:8091/',
      fetchFn,
    })
    expect(items).toEqual([
      { title: 'One', link: 'https://one.test', snippet: 'first snippet' },
      { title: 'Two', link: 'https://two.test', snippet: 'second snippet' },
      { title: 'No link', link: '', snippet: 'no url' },
    ])
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://10.0.2.2:8091/search')
    expect(JSON.parse((init as RequestInit).body as string).query).toBe('chatbox')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer key-1' })
  })

  it('searches a SearXNG JSON endpoint with the configured instance URL', async () => {
    const fetchFn = mockFetchResponse({
      results: [
        { title: 'One', url: 'https://one.test', content: 'first snippet' },
        { title: '', url: 'https://invalid.test', content: 'ignored' },
      ],
    })
    const items = await searchNativeWeb('chatbox mobile', {
      provider: 'searxng',
      apiHost: 'https://search.test/',
      fetchFn,
    })

    expect(items).toEqual([{ title: 'One', link: 'https://one.test', snippet: 'first snippet' }])
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://search.test/search?q=chatbox%20mobile&format=json')
    expect((init as RequestInit).headers).toEqual({ Accept: 'application/json' })
  })

  it('searches DeepSeek and prefers the long summary with its publish date', async () => {
    const fetchFn = mockFetchResponse({
      results: [
        {
          title: 'Weather',
          url: 'https://weather.example',
          snippet: 'short',
          summary: 'Shanghai is 18°C today.',
          date: '2026-11-14T00:00:00+00:00',
        },
        { title: 'No link', summary: 'ignored' },
        { title: 'Snippet only', url: 'https://snippet.example', snippet: 'fallback snippet' },
      ],
    })
    const items = await searchNativeWeb('上海 天气', {
      provider: 'deepseek',
      apiKey: 'sk-key',
      apiHost: 'https://api.deepseek.com/',
      fetchFn,
    })

    expect(items).toEqual([
      {
        title: 'Weather',
        link: 'https://weather.example',
        snippet: '[2026-11-14T00:00:00+00:00] Shanghai is 18°C today.',
      },
      { title: 'Snippet only', link: 'https://snippet.example', snippet: 'fallback snippet' },
    ])
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      query: '上海 天气',
      count: 10,
      need_content: false,
    })
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-key' })
  })

  it('truncates a DeepSeek query to 128 Unicode characters and skips a blank query', async () => {
    const fetchFn = mockFetchResponse({ results: [] })
    const emoji = '😀'
    const query = `${'测'.repeat(127)}${emoji}tail`
    await searchNativeWeb(query, { provider: 'deepseek', apiKey: 'sk-key', maxResults: 80, fetchFn })
    const body = JSON.parse(
      ((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string
    )
    expect(Array.from(body.query)).toHaveLength(128)
    expect(body.query.endsWith(emoji)).toBe(true)
    expect(body.query).not.toContain('tail')
    expect(body.count).toBe(50)

    const unusedFetch = vi.fn()
    await expect(
      searchNativeWeb('   ', {
        provider: 'deepseek',
        apiKey: 'sk-key',
        fetchFn: unusedFetch as unknown as typeof fetch,
      })
    ).resolves.toEqual([])
    expect(unusedFetch).not.toHaveBeenCalled()
  })

  it('searches SearXNG and DeepSeek together and keeps a result when one side fails', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (String(url).startsWith('https://searx.test/')) {
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              answers: ['18°C'],
              results: [{ title: 'Forecast', url: 'https://weather.example/page?id=1', content: 'weekly' }],
            }),
        }
      }
      return {
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { message: 'blocked by policy' } }),
      }
    }) as unknown as typeof fetch

    const items = await searchNativeWeb('上海 天气', {
      provider: 'searxng-deepseek',
      apiKey: 'sk-key',
      apiHost: 'https://searx.test',
      fetchFn,
    })

    expect(items.map((item) => item.title)).toEqual(['Answer', 'Forecast'])
    expect(items[0]?.snippet).toBe('18°C')

    const failingSearx = vi.fn((url: string) => {
      if (String(url).startsWith('https://searx.test/')) {
        return { ok: false, status: 500, json: () => Promise.resolve({}) }
      }
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [{ title: 'DeepSeek weather', url: 'https://weather.example/deep', summary: '18°C today' }],
          }),
      }
    }) as unknown as typeof fetch
    const fallback = await searchNativeWeb('上海 天气', {
      provider: 'searxng-deepseek',
      apiKey: 'sk-key',
      apiHost: 'https://searx.test',
      fetchFn: failingSearx,
    })
    expect(fallback).toEqual([
      { title: 'DeepSeek weather', link: 'https://weather.example/deep', snippet: '18°C today' },
    ])
  })

  it('merges different summaries for the same page without collapsing different queries', () => {
    const merged = mergeSearchResults([
      {
        source: 'SearXNG',
        items: [
          { title: 'Guide', link: 'https://Example.com/a?id=1&utm_source=newsletter#top', snippet: 'original hit' },
        ],
      },
      {
        source: 'DeepSeek',
        items: [{ title: '', link: 'https://example.com/a?id=1', snippet: 'A longer rewritten summary.' }],
      },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.link).toBe('https://Example.com/a?id=1&utm_source=newsletter#top')
    expect(merged[0]?.title).toBe('Guide')
    expect(merged[0]?.snippet).toContain('[DeepSeek]')
    expect(merged[0]?.snippet).toContain('[SearXNG]')
    expect(merged[0]?.snippet).toContain('original hit')

    const distinct = mergeSearchResults([
      { source: 'SearXNG', items: [{ title: 'One', link: 'https://example.com/a?id=1', snippet: 'one' }] },
      { source: 'DeepSeek', items: [{ title: 'Two', link: 'https://example.com/a?id=2', snippet: 'two' }] },
    ])
    expect(distinct).toHaveLength(2)
  })

  it('surfaces a DeepSeek error payload even when the transport reports success', async () => {
    const fetchFn = mockFetchResponse({ error: { message: 'Insufficient balance' } })
    await expect(searchNativeWeb('weather', { provider: 'deepseek', apiKey: 'sk-key', fetchFn })).rejects.toThrow(
      'Insufficient balance'
    )
  })

  it('throws on non-ok responses', async () => {
    const fetchFn = mockFetchResponse({}, false, 401)
    await expect(searchNativeWeb('q', { apiKey: 'bad', fetchFn })).rejects.toThrow('status 401')
  })

  it('formats the search context block', () => {
    const context = formatNativeWebSearchContext('chatbox', [
      { title: 'One', link: 'https://one.test', snippet: 'first' },
    ])
    expect(context).toContain('<WEB_SEARCH_RESULTS>')
    expect(context).toContain('query: chatbox')
    expect(context).toContain('https://one.test')
    expect(formatNativeWebSearchContext('chatbox', [])).toBe('')
  })
})
