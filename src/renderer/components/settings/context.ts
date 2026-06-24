import { createContext, useContext } from 'react'

/** Current settings search query, provided by SettingsPage to all descendant rows. */
export const SettingsSearchContext = createContext('')

export function useSettingsSearch(): string {
  return useContext(SettingsSearchContext)
}
