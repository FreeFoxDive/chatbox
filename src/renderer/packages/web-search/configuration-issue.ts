import type { WebSearchProviderValue } from './constants'

type WebSearchConfiguration = {
  provider: WebSearchProviderValue
  tavilyApiKey?: string
  bochaApiKey?: string
  queritApiKey?: string
  searxngBaseUrl?: string
  deepseekApiKey?: string
  /** API key saved on the DeepSeek model provider, used when deepseekApiKey is blank. */
  deepseekProviderApiKey?: string
}

export function resolveDeepSeekWebSearchApiKey(deepseekApiKey?: string, deepseekProviderApiKey?: string): string {
  return deepseekApiKey?.trim() || deepseekProviderApiKey?.trim() || ''
}

export type WebSearchConfigurationIssue =
  | 'chatbox-ai-sign-in'
  | 'tavily-api-key'
  | 'bocha-api-key'
  | 'querit-api-key'
  | 'searxng-instance'
  | 'deepseek-api-key'

export function getWebSearchConfigurationIssue(
  configuration: WebSearchConfiguration,
  licenseKey?: string
): WebSearchConfigurationIssue | null {
  switch (configuration.provider) {
    case 'build-in':
      return licenseKey ? null : 'chatbox-ai-sign-in'
    case 'tavily':
      return configuration.tavilyApiKey ? null : 'tavily-api-key'
    case 'bocha':
      return configuration.bochaApiKey ? null : 'bocha-api-key'
    case 'querit':
      return configuration.queritApiKey ? null : 'querit-api-key'
    case 'searxng':
      return configuration.searxngBaseUrl?.trim() ? null : 'searxng-instance'
    case 'deepseek':
      return resolveDeepSeekWebSearchApiKey(configuration.deepseekApiKey, configuration.deepseekProviderApiKey)
        ? null
        : 'deepseek-api-key'
    case 'searxng-deepseek':
      if (!configuration.searxngBaseUrl?.trim()) return 'searxng-instance'
      return resolveDeepSeekWebSearchApiKey(configuration.deepseekApiKey, configuration.deepseekProviderApiKey)
        ? null
        : 'deepseek-api-key'
    case 'bing':
      return null
  }
}
