import { describe, expect, it } from 'vitest'

import { sessionKindIconUrl } from './session-kind-icons'
import { sessionKindOptions } from './session-kind-options'

describe('session kind icons', () => {
  // The launcher and the sidebar rows both render this URL into an <img>, so a kind without
  // a mark shows a broken image rather than falling back to anything.
  it('has a mark for every kind either platform offers', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      for (const { kind } of sessionKindOptions(platform)) {
        expect(sessionKindIconUrl(kind), `missing icon for ${kind}`).toBeTruthy()
      }
    }
  })
})
