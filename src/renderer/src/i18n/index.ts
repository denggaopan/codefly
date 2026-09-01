import { en } from './en'
import type { TranslationKey, Translations } from './en-types'
import { zhCN } from './zh-CN'

export type { TranslationKey, Translations }

export type Locale = 'en' | 'zh-CN'

/**
 * Selectable languages, in menu order. Each label is written in its OWN language so a user
 * who cannot read the currently active locale can still find theirs.
 */
export const LOCALES: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' }
]

/**
 * English is the default rather than the OS language: it keeps first launch (and the whole
 * unit/e2e suite, which asserts English copy) deterministic, and the language is a one-click
 * change away in Settings. See DEFAULT_LOCALE's consumers in the app store.
 */
export const DEFAULT_LOCALE: Locale = 'en'

const dictionaries: Record<Locale, Translations> = { en, 'zh-CN': zhCN }

export const isLocale = (value: unknown): value is Locale => LOCALES.some((locale) => locale.value === value)

/**
 * Looks up `key` in `locale`, falling back to English for anything a locale somehow lacks
 * (dictionaries are type-checked to be complete, so this only guards runtime surprises such
 * as a stale persisted locale). `{name}` placeholders are replaced from `params`; an
 * unmatched placeholder is left in place rather than blanked, so the gap is visible.
 */
export const translate = (locale: Locale, key: TranslationKey, params?: Readonly<Record<string, string | number>>): string => {
  const template = dictionaries[locale]?.[key] ?? en[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

export type Translator = (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string

export const createTranslator = (locale: Locale): Translator => (key, params) => translate(locale, key, params)
