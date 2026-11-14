import { describe, expect, it } from 'vitest'
import { getWebSearchConfigurationIssue, resolveDeepSeekWebSearchApiKey } from './configuration-issue'

describe('getWebSearchConfigurationIssue', () => {
  it('requires sign-in only for the built-in provider without a license', () => {
    expect(getWebSearchConfigurationIssue({ provider: 'build-in' })).toBe('chatbox-ai-sign-in')
    expect(getWebSearchConfigurationIssue({ provider: 'build-in' }, 'license-key')).toBeNull()
    expect(getWebSearchConfigurationIssue({ provider: 'bing' })).toBeNull()
  })

  it('reports missing third-party provider configuration', () => {
    expect(getWebSearchConfigurationIssue({ provider: 'tavily' })).toBe('tavily-api-key')
    expect(getWebSearchConfigurationIssue({ provider: 'bocha' })).toBe('bocha-api-key')
    expect(getWebSearchConfigurationIssue({ provider: 'querit' })).toBe('querit-api-key')
    expect(getWebSearchConfigurationIssue({ provider: 'searxng', searxngBaseUrl: '  ' })).toBe('searxng-instance')
    expect(getWebSearchConfigurationIssue({ provider: 'deepseek' })).toBe('deepseek-api-key')
    expect(getWebSearchConfigurationIssue({ provider: 'deepseek', deepseekApiKey: '  ' })).toBe('deepseek-api-key')
    expect(getWebSearchConfigurationIssue({ provider: 'deepseek', deepseekApiKey: 'search-key' })).toBeNull()
    expect(getWebSearchConfigurationIssue({ provider: 'deepseek', deepseekProviderApiKey: 'provider-key' })).toBeNull()
    expect(getWebSearchConfigurationIssue({ provider: 'searxng-deepseek' })).toBe('searxng-instance')
    expect(
      getWebSearchConfigurationIssue({ provider: 'searxng-deepseek', searxngBaseUrl: 'https://searx.example.com' })
    ).toBe('deepseek-api-key')
    expect(
      getWebSearchConfigurationIssue({
        provider: 'searxng-deepseek',
        searxngBaseUrl: 'https://searx.example.com',
        deepseekProviderApiKey: 'provider-key',
      })
    ).toBeNull()
  })

  it('prefers a dedicated DeepSeek search key over the model provider key', () => {
    expect(resolveDeepSeekWebSearchApiKey('  own-key  ', 'provider-key')).toBe('own-key')
    expect(resolveDeepSeekWebSearchApiKey('   ', ' provider-key ')).toBe('provider-key')
    expect(resolveDeepSeekWebSearchApiKey()).toBe('')
  })
})
