import type { en } from './en'

/** Every key the UI may translate; derived from the English dictionary. */
export type TranslationKey = keyof typeof en

/** The shape every locale dictionary must implement in full. */
export type Translations = Record<TranslationKey, string>
