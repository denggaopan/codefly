import { describe, expect, it } from 'vitest'

import { en } from './en'
import { createTranslator, DEFAULT_LOCALE, isLocale, LOCALES, translate } from './index'
import { zhCN } from './zh-CN'

const placeholders = (template: string): string[] => [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('i18n dictionaries', () => {
  it('defaults to English so first launch and the test suites stay deterministic', () => {
    expect(DEFAULT_LOCALE).toBe('en')
  })

  it('offers exactly the two shipped languages, each labelled in its own language', () => {
    expect(LOCALES).toEqual([
      { value: 'en', label: 'English' },
      { value: 'zh-CN', label: '简体中文' }
    ])
  })

  // The dictionaries are type-checked to be complete, but nothing at the type level keeps
  // their placeholders in step: a locale that drops {version} silently renders a sentence
  // with a hole in it.
  it('translates every English key with matching placeholders in Simplified Chinese', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const source = en[key]
      const translated = zhCN[key]
      expect(translated, `missing translation for ${key}`).toBeTruthy()
      expect(placeholders(translated), `placeholder mismatch for ${key}`).toEqual(placeholders(source))
    }
  })
})

describe('translate', () => {
  it('returns the locale string for a known key', () => {
    expect(translate('en', 'settings.title')).toBe('Settings')
    expect(translate('zh-CN', 'settings.title')).toBe('设置')
    expect(translate('zh-CN', 'settings.launchAtLogin')).toBe('开机自动启动')
  })

  it('substitutes named placeholders', () => {
    expect(translate('en', 'settings.updateAvailable', { version: '1.2.3' })).toBe('Version 1.2.3 is available.')
    expect(translate('zh-CN', 'notice.dirtyWorktree', { count: 3 })).toContain('3')
  })

  it('leaves an unmatched placeholder visible rather than blanking it', () => {
    expect(translate('en', 'settings.updateAvailable', {})).toBe('Version {version} is available.')
  })

  it('falls back to English when a locale is not one of the shipped dictionaries', () => {
    expect(translate('de' as never, 'settings.title')).toBe('Settings')
  })

  it('binds a locale with createTranslator', () => {
    const t = createTranslator('zh-CN')
    expect(t('common.cancel')).toBe('取消')
  })
})

describe('isLocale', () => {
  it('accepts shipped locales and rejects anything else', () => {
    expect(isLocale('en')).toBe(true)
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('zh')).toBe(false)
    expect(isLocale(null)).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
})
