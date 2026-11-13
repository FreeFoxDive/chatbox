import type { Plausible } from '@/analytics/plausible'

declare global {
  interface Window {
    plausible?: Plausible
  }
}

export function trackEvent(_event: string, _props: Record<string, unknown> = {}) {
  return
}
