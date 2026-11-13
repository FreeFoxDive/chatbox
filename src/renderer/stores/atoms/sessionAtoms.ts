import { activeStorageKey } from '@shared/workspace-namespace'
import { atomWithStorage, createJSONStorage } from 'jotai/utils'

const browserStorage = createJSONStorage<string | null>()
const currentSessionStorage = {
  ...browserStorage,
  getItem: (key: string, initialValue: string | null) => browserStorage.getItem(activeStorageKey(key), initialValue),
  setItem: (key: string, value: string | null) => {
    try {
      return browserStorage.setItem(activeStorageKey(key), value)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error
      console.warn('Could not persist the current session: browser storage quota exceeded')
    }
  },
  removeItem: (key: string) => browserStorage.removeItem(activeStorageKey(key)),
}

export const currentSessionIdAtom = atomWithStorage<string | null>(
  '_currentSessionIdCachedAtom',
  null,
  currentSessionStorage
)
