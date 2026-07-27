import { createContext, useContext } from 'react'

export interface ApiProfile {
  id: number
  name: string
  slug: string
  emoji: string
  color: string
  type: 'default' | 'custom'
}

export interface ProfileContextValue {
  profiles: ApiProfile[]
  active: ApiProfile | null
  select: (id: number) => void
}

export const PROFILE_STORAGE_KEY = 'freellmapi.activeProfileId'

export const ProfileContext = createContext<ProfileContextValue>({
  profiles: [],
  active: null,
  select: () => {},
})

export function useProfile() {
  return useContext(ProfileContext)
}
