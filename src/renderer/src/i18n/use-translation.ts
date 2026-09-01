import { useMemo } from 'react'

import { useAppStore } from '../store/use-app-store'
import { createTranslator, type Locale, type Translator } from './index'

/**
 * Subscribes a component to the active locale and hands back a bound `t()`. Kept in its own
 * module (the rest of i18n/ is store-free pure functions) so non-React code — the app store's
 * own notice strings, for one — can translate without importing React or creating an import
 * cycle back through this hook.
 */
export const useTranslation = (): { t: Translator; locale: Locale } => {
  const locale = useAppStore((state) => state.locale)
  return useMemo(() => ({ t: createTranslator(locale), locale }), [locale])
}
