import { useProfile, type ApiProfile } from '@/profile-context'

export function apiBaseUrl(profile?: Pick<ApiProfile, 'slug' | 'type'> | null): string {
  const origin = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}`
    : window.location.origin
  const prefix = profile && profile.type !== 'default' ? `/${profile.slug}` : ''
  return `${origin}${prefix}/v1`
}

export function useApiBaseUrl(): string {
  return apiBaseUrl(useProfile().active)
}
