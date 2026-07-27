import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import {
  PROFILE_STORAGE_KEY,
  ProfileContext,
  type ApiProfile,
} from '@/profile-context'

export function ProfileProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const value = Number(localStorage.getItem(PROFILE_STORAGE_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  })
  const { data: profiles = [] } = useQuery<ApiProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles', { headers: { 'X-Skip-Profile': '1' } }),
  })
  const active = profiles.find(profile => profile.id === selectedId)
    ?? profiles.find(profile => profile.type === 'default')
    ?? profiles[0]
    ?? null

  useEffect(() => {
    if (!active || active.id === selectedId) return
    const timer = window.setTimeout(() => {
      setSelectedId(active.id)
      localStorage.setItem(PROFILE_STORAGE_KEY, String(active.id))
      void queryClient.invalidateQueries({
        predicate: query => query.queryKey[0] !== 'profiles',
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [active, selectedId, queryClient])

  function select(id: number) {
    setSelectedId(id)
    localStorage.setItem(PROFILE_STORAGE_KEY, String(id))
    const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'profiles'
    void queryClient.cancelQueries({ predicate }).then(() => {
      void queryClient.invalidateQueries({ predicate })
    })
  }

  const value = useMemo(() => ({ profiles, active, select }), [profiles, active])
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}
