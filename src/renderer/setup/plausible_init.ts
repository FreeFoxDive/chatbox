export type PlausibleNavigationSubscriber = (onResolved: (hrefChanged: boolean) => void) => void

export async function initPlausibleTracking(_subscribeToNavigation?: PlausibleNavigationSubscriber): Promise<void> {
  return
}
