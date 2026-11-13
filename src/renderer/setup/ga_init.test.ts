// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { initSettingsStoreMock, platformInitTrackingMock, trackingEventMock } = vi.hoisted(() => ({
  initSettingsStoreMock: vi.fn(),
  platformInitTrackingMock: vi.fn(async () => undefined),
  trackingEventMock: vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: {
    initTracking: platformInitTrackingMock,
    isWindowFocused: vi.fn(async () => true),
    onWindowFocused: vi.fn(),
    trackingEvent: trackingEventMock,
  },
}))
vi.mock('@/stores/settingsStore', () => ({
  initSettingsStore: initSettingsStoreMock,
  settingsStore: {
    getState: vi.fn(() => ({ allowReportingAndTracking: true })),
    subscribe: vi.fn(),
  },
}))

describe('Google Analytics initialization', () => {
  beforeEach(() => {
    initSettingsStoreMock.mockReset()
    platformInitTrackingMock.mockClear()
    trackingEventMock.mockClear()
    vi.resetModules()
  })

  it('does not initialize Google Analytics or emit events', async () => {
    const { initGoogleAnalyticsTracking } = await import('./ga_init')
    await initGoogleAnalyticsTracking()

    expect(initSettingsStoreMock).not.toHaveBeenCalled()
    expect(platformInitTrackingMock).not.toHaveBeenCalled()
    expect(trackingEventMock).not.toHaveBeenCalled()
  })
})
