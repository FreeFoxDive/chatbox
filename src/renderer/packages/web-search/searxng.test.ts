import { describe, expect, it, vi } from 'vitest'
import { normalizeSearxngBaseUrl, SearxngSearch } from './searxng'

describe('SearxngSearch', () => {
  it('requests the configured instance search endpoint and maps results', async () => {
    const search = new SearxngSearch('https://searx.example.com/')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      results: [
        { title: 'Result title', url: 'https://example.com/page', content: 'Result content' },
        { title: 'Missing URL', content: 'ignored' },
      ],
    } as never)

    const result = await search.search('test query')

    expect(fetchSpy).toHaveBeenCalledWith('https://searx.example.com/search', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      query: {
        q: 'test query',
        format: 'json',
      },
      responseType: 'json',
      signal: undefined,
    })
    expect(result.items).toEqual([
      {
        title: 'Result title',
        link: 'https://example.com/page',
        snippet: 'Result content',
      },
    ])
  })

  it('falls back to snippet when content is not present', async () => {
    const search = new SearxngSearch('https://searx.example.com')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      results: [{ title: 'Result title', url: 'https://example.com/page', snippet: 'Result snippet' }],
    } as never)

    const result = await search.search('test query')

    expect(fetchSpy).toHaveBeenCalled()
    expect(result.items[0]?.snippet).toBe('Result snippet')
  })

  it('normalizes instance URLs by trimming whitespace and trailing slashes', () => {
    expect(normalizeSearxngBaseUrl('  https://searx.example.com/  ')).toBe('https://searx.example.com')
    expect(normalizeSearxngBaseUrl('   ')).toBe('')
  })

  it('keeps direct answers and infoboxes ahead of ordinary results', async () => {
    const search = new SearxngSearch('https://searx.example.com')
    vi.spyOn(search, 'fetch').mockResolvedValueOnce({
      answers: ['18°C and cloudy'],
      infoboxes: [
        {
          title: 'Shanghai',
          content: 'Current weather',
          urls: [{ url: 'https://weather.example/shanghai' }],
          attributes: [{ label: 'Temperature', value: '18°C' }],
        },
      ],
      results: [{ title: 'Forecast', url: 'https://example.com/forecast', content: 'Weekly forecast' }],
    } as never)

    await expect(search.search('shanghai weather')).resolves.toEqual({
      items: [
        { title: 'Answer', link: '', snippet: '18°C and cloudy' },
        {
          title: 'Shanghai',
          link: 'https://weather.example/shanghai',
          snippet: 'Current weather\nTemperature: 18°C',
        },
        { title: 'Forecast', link: 'https://example.com/forecast', snippet: 'Weekly forecast' },
      ],
    })
  })

  it('accepts an empty results array', async () => {
    const search = new SearxngSearch('https://searx.example.com')
    vi.spyOn(search, 'fetch').mockResolvedValueOnce({ results: [] } as never)

    const result = await search.search('empty query')

    expect(result.items).toEqual([])
  })

  it.each([
    ['HTML', '<html>login</html>'],
    ['an object without results', {}],
    ['a non-array results field', { results: { title: 'not an array' } }],
    ['null', null],
  ] as const)('rejects %s as a malformed SearXNG response', async (_label, payload) => {
    const search = new SearxngSearch('https://searx.example.com')
    vi.spyOn(search, 'fetch').mockResolvedValueOnce(payload as never)

    await expect(search.search('invalid query')).rejects.toThrow('invalid JSON search response')
  })
})
