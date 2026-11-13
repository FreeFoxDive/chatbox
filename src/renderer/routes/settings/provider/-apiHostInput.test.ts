import { describe, expect, it } from 'vitest'
import { providerInputValue } from './-apiHostInput'

const defaultHost = 'https://api.openai.com/v1'

describe('provider API host input', () => {
  it('shows the default host only when the setting has never been stored', () => {
    expect(providerInputValue(undefined, defaultHost)).toBe(defaultHost)
  })

  it('keeps an emptied host empty instead of restoring the default URL', () => {
    expect(providerInputValue('', defaultHost)).toBe('')
  })

  it('shows a custom host as entered', () => {
    expect(providerInputValue('https://example.com/v1', defaultHost)).toBe('https://example.com/v1')
  })

  it('keeps optional fields controlled when they are unset', () => {
    expect(providerInputValue(undefined)).toBe('')
    expect(providerInputValue('')).toBe('')
  })
})
