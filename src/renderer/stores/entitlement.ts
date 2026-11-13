import { appliesOfficialEntitlements } from '@shared/free-edition'
import { ModelProviderEnum } from '@shared/types'
import { authInfoStore } from './authInfoStore'
import { settingsStore } from './settingsStore'

/** True when client Pro/quota gates follow the official account. Otherwise they are lifted. */
export function appliesOfficialEntitlementsNow(): boolean {
  const settings = settingsStore.getState()
  const tokens = authInfoStore.getState().getTokens()
  return appliesOfficialEntitlements({
    apiHost: settings.providers?.[ModelProviderEnum.ChatboxAI]?.apiHost,
    licenseActivationMethod: settings.licenseActivationMethod,
    hasOfficialSession: Boolean(tokens),
  })
}

export function clientRestrictionsLifted(): boolean {
  return !appliesOfficialEntitlementsNow()
}
