import { CapacitorHttp } from '@capacitor/core'
import { ChatboxAIAPIError } from '@shared/models/errors'
import { describe, expect, it, vi } from 'vitest'
import platform from '@/platform'
import { DeepSeekSearch } from './deepseek'

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: vi.fn() },
  registerPlugin: vi.fn(),
}))

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

  it('reads the page directly when DeepSeek fetch is blocked', async () => {
    const search = new DeepSeekSearch('test-key')
    const html = `<!doctype html><html><head><title>Local Title</title></head><body><article><h1>Local Title</h1><p>${'Readable local paragraph. '.repeat(30)}</p></article></body></html>`
    const fetchSpy = vi
      .spyOn(search, 'fetch')
      .mockResolvedValueOnce({ error: { message: 'blocked by policy' } } as never)
      .mockResolvedValueOnce(html as never)

    const result = await search.parseLink('https://example.com/a')

    expect(result.url).toBe('https://example.com/a')
    expect(result.title).toBe('Local Title')
    expect(result.content).toContain('Readable local paragraph.')
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://example.com/a')
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', responseType: 'text' })
  })

  it('omits scripts, styles, and templates from the direct page text', async () => {
    const search = new DeepSeekSearch('test-key')
    const html = `<!doctype html><html><head><title>Tiny</title><style>.secret{color:red}</style></head><body><p>Short note.</p><script>window.__SECRET_PAYLOAD__="should-not-leak"</script><noscript>noscript junk</noscript><template>template junk</template></body></html>`
    vi.spyOn(search, 'fetch')
      .mockResolvedValueOnce({ content: '' } as never)
      .mockResolvedValueOnce(html as never)

    const result = await search.parseLink('https://example.com/a')

    expect(result.content).toContain('Short note.')
    expect(result.content).not.toContain('__SECRET_PAYLOAD__')
    expect(result.content).not.toContain('.secret')
    expect(result.content).not.toContain('noscript junk')
    expect(result.content).not.toContain('template junk')
  })

  it('rejects a mobile HTTP error page instead of reading it', async () => {
    platform.type = 'mobile'
    const request = vi.mocked(CapacitorHttp.request).mockImplementation((options) => {
      if (String(options.url).includes('api.deepseek.com')) {
        return Promise.resolve({
          status: 403,
          data: { error: { message: 'blocked by policy' } },
          headers: {},
          url: options.url,
        })
      }
      return Promise.resolve({
        status: 404,
        data: '<html><body>Missing page secret</body></html>',
        headers: {},
        url: options.url,
      })
    })

    try {
      const search = new DeepSeekSearch('test-key')
      await expect(search.parseLink('https://example.com/a')).rejects.toMatchObject({
        code: 20037,
        message: expect.stringContaining('status 404'),
      })
    } finally {
      platform.type = 'web'
      request.mockReset()
    }
  })

  it('throws parse_link_failed when DeepSeek and the direct fetch both fail', async () => {
    const search = new DeepSeekSearch('test-key')
    vi.spyOn(search, 'fetch').mockRejectedValue(new Error('network down'))

    await expect(search.parseLink('https://example.com/a')).rejects.toMatchObject({
      code: 20037,
      message: expect.stringContaining('network down'),
    })
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
