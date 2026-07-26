import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Monitor, Moon, Search, Sun, X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SUPPORTED_LOCALES, type Locale, useI18n } from '@/i18n'
import { type Theme, useTheme } from '@/theme-context'

function LanguageCombobox() {
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const languages = useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' })
    return SUPPORTED_LOCALES
      .map(code => ({ code, name: t(`languages.${code}`) }))
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [locale, t])

  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const filtered = normalizedQuery
    ? languages.filter(({ code, name }) =>
        `${name} ${code}`.toLocaleLowerCase(locale).includes(normalizedQuery),
      )
    : languages
  const currentName = languages.find(language => language.code === locale)?.name ?? locale

  function selectLocale(next: Locale) {
    setLocale(next)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => Math.min(current + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault()
      selectLocale(filtered[active].code)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        setQuery('')
        setActive(0)
      }}
    >
      <PopoverTrigger
        aria-label={t('settings.language')}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <span className="truncate">{currentName}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-3rem))] p-0" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={t('settings.searchLanguage')}
            aria-label={t('settings.searchLanguage')}
            role="combobox"
            aria-expanded="true"
            aria-controls="settings-language-list"
            aria-activedescendant={filtered[active] ? `settings-language-${filtered[active].code}` : undefined}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div id="settings-language-list" role="listbox" className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t('settings.noLanguages')}
            </p>
          ) : (
            filtered.map((language, index) => (
              <button
                key={language.code}
                id={`settings-language-${language.code}`}
                type="button"
                role="option"
                aria-selected={language.code === locale}
                onMouseEnter={() => setActive(index)}
                onClick={() => selectLocale(language.code)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                  language.code === locale ? 'bg-accent/50' : index === active ? 'bg-muted' : ''
                }`}
              >
                <Check className={`size-4 shrink-0 ${language.code === locale ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{language.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {language.code}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const themeIcons = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<Theme, typeof Monitor>

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const themes: { value: Theme; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-6 flex items-center justify-between gap-4">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-me-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('settings.language')}</h2>
            <LanguageCombobox />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('settings.theme')}</h2>
            <div
              role="radiogroup"
              aria-label={t('settings.theme')}
              className="grid grid-cols-3 gap-1 rounded-xl border p-1"
            >
              {themes.map(option => {
                const Icon = themeIcons[option.value]
                const selected = theme === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(option.value)}
                    className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs transition-colors ${
                      selected
                        ? 'bg-foreground font-medium text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{option.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
