import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSettingsState } = vi.hoisted(() => ({
  getSettingsState: vi.fn(),
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: getSettingsState,
  },
}))

import { trackEvent } from './track'

describe('trackEvent', () => {
  const plausible = vi.fn()

  beforeEach(() => {
    plausible.mockReset()
    getSettingsState.mockReturnValue({ allowReportingAndTracking: true })
    vi.stubGlobal('window', {
      location: { href: 'https://app.chatboxai.app/#/session/private-session-id' },
      plausible,
    })
  })

  it('does not send events even when reporting is enabled', () => {
    trackEvent('generate', { provider: 'openai' })

    expect(plausible).not.toHaveBeenCalled()
  })

  it('does not track when reporting is disabled', () => {
    getSettingsState.mockReturnValue({ allowReportingAndTracking: false })

    trackEvent('generate')

    expect(plausible).not.toHaveBeenCalled()
  })
})
