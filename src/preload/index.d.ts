import type { CodeFlyApi } from './index'

declare global {
  interface Window {
    codefly: CodeFlyApi
  }
}

export {}
