// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { initSettingsStoreMock, settingsStoreGetStateMock, settingsStoreSubscribeMock } = vi.hoisted(() => ({
  initSettingsStoreMock: vi.fn(async () => ({ allowReportingAndTracking: false })),
  settingsStoreGetStateMock: vi.fn(() => ({ allowReportingAndTracking: false })),
  settingsStoreSubscribeMock: vi.fn(),
}))

vi.mock('@/analytics/jk', () => ({
  initJkAnalytics: vi.fn(),
  trackJkViewEvent: vi.fn(),
}))
vi.mock('@/analytics/jk-events', () => ({ JK_EVENTS: { APP_LAUNCH: 'app_launch' } }))
vi.mock('@/stores/settingsStore', () => ({
  initSettingsStore: initSettingsStoreMock,
  settingsStore: {
    getState: settingsStoreGetStateMock,
    subscribe: settingsStoreSubscribeMock,
  },
}))
vi.mock('../platform', () => ({
  default: {
    getVersion: vi.fn(async () => '1.0.0'),
    onWindowFocused: vi.fn(),
  },
}))

describe('settings-backed telemetry initialization', () => {
  beforeEach(() => {
    initSettingsStoreMock.mockClear()
    settingsStoreGetStateMock.mockReset()
    settingsStoreGetStateMock.mockReturnValue({ allowReportingAndTracking: true })
    settingsStoreSubscribeMock.mockClear()
    window.plausible = undefined
    window.history.replaceState({}, '', '/')
    vi.resetModules()
  })

  it('does not hydrate settings as an import side effect', async () => {
    await Promise.all([import('./ga_init'), import('./jk_analytics_init'), import('./plausible_init')])

    expect(initSettingsStoreMock).not.toHaveBeenCalled()
  })

  it('does not start analytics after explicit initialization', async () => {
    const [{ initGoogleAnalyticsTracking }, { initJkTracking }, { initPlausibleTracking }] = await Promise.all([
      import('./ga_init'),
      import('./jk_analytics_init'),
      import('./plausible_init'),
    ])
    const plausibleMock = vi.fn()
    const navigationSubscriber = vi.fn()
    window.plausible = plausibleMock

    await initGoogleAnalyticsTracking()
    await initPlausibleTracking(navigationSubscriber)
    await initJkTracking()

    expect(initSettingsStoreMock).not.toHaveBeenCalled()
    expect(navigationSubscriber).not.toHaveBeenCalled()
    expect(plausibleMock).not.toHaveBeenCalled()
  })
})
