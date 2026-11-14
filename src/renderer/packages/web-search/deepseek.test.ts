import { ChatboxAIAPIError } from '@shared/models/errors'
import { describe, expect, it, vi } from 'vitest'
import { DeepSeekSearch } from './deepseek'

describe('DeepSeekSearch', () => {
  it('searches through the shared DeepSeek tools API', async () => {
    const search = new DeepSeekSearch('test-key')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValue({
      results: [
        {
          title: 'Weather',
          url: 'https://weather.example',
          snippet: 'short',
          summary: 'Shanghai is 18°C today.',
          date: '2026-11-14T00:00:00+00:00',
        },
      ],
    } as never)

    const result = await search.search('上海天气')

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/tools/search')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer test-key' },
      body: { query: '上海天气', count: 10, need_content: false },
    })
    expect(result.items).toEqual([
      {
        title: 'Weather',
        link: 'https://weather.example',
        snippet: '[2026-11-14T00:00:00+00:00] Shanghai is 18°C today.',
      },
    ])
  })

  it('reads a page as markdown', async () => {
    const search = new DeepSeekSearch('test-key')
    const fetchSpy = vi.spyOn(search, 'fetch').mockResolvedValue({
      title: 'Example',
      content: '# Example\n\nBody',
    } as never)

    await expect(search.parseLink('https://example.com/a')).resolves.toEqual({
      url: 'https://example.com/a',
      title: 'Example',
      content: '# Example\n\nBody',
    })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/tools/fetch')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: { url: 'https://example.com/a' },
    })
  })

  it('falls back to the hostname when the fetched title is blank', async () => {
    const search = new DeepSeekSearch('test-key')
    vi.spyOn(search, 'fetch').mockResolvedValue({ title: '   ', content: 'page body' } as never)

    await expect(search.parseLink('https://example.com/a')).resolves.toMatchObject({
      title: 'example.com',
      content: 'page body',
    })
  })

  it('throws parse_link_failed when the page has no content', async () => {
    const search = new DeepSeekSearch('test-key')
    vi.spyOn(search, 'fetch').mockResolvedValue({ title: 'Example', content: '  ' } as never)

    await expect(search.parseLink('https://example.com/a')).rejects.toBeInstanceOf(ChatboxAIAPIError)
    await expect(search.parseLink('https://example.com/a')).rejects.toMatchObject({ code: 20037 })
  })

  it('throws parse_link_failed when the fetch API returns an error', async () => {
    const search = new DeepSeekSearch('test-key')
    vi.spyOn(search, 'fetch').mockResolvedValue({ error: { message: 'blocked by policy' } } as never)

    await expect(search.parseLink('https://example.com/a')).rejects.toMatchObject({
      code: 20037,
      message: 'blocked by policy',
    })
  })
})
