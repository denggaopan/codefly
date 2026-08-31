import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../../shared/contracts'
import { isAgentDone, sessionStatusLabel } from './session-status'

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    kind: 'claude',
    title: 'Fix login bug',
    titleState: 'complete',
    createdAt: '2026-08-20T00:00:00.000Z',
    mode: 'ordinary',
    launchPath: 'C:\\work\\demo-project',
    status: 'running',
    ...overrides
  }) as SessionRecord

describe('sessionStatusLabel with agent idle detection', () => {
  it.each(['claude', 'codex'] as const)('labels a quiet running %s session Done', (kind) => {
    expect(sessionStatusLabel(session({ kind }), true)).toBe('Done')
    expect(isAgentDone(session({ kind }), true)).toBe(true)
  })

  it.each(['claude', 'codex'] as const)('keeps Running for a %s session that is still producing output', (kind) => {
    expect(sessionStatusLabel(session({ kind }), false)).toBe('Running')
    expect(isAgentDone(session({ kind }), false)).toBe(false)
  })

  it.each(['powershell', 'cmd'] as const)('never labels a %s shell session Done', (kind) => {
    expect(sessionStatusLabel(session({ kind }), true)).toBe('Running')
    expect(isAgentDone(session({ kind }), true)).toBe(false)
  })

  it('keeps the stopped/error/missing labels regardless of idleness', () => {
    expect(sessionStatusLabel(session({ status: 'stopped' }), true)).toBe('Click to restore')
    expect(sessionStatusLabel(session({ status: 'error', lastError: 'boom' }), true)).toBe('boom')
    expect(sessionStatusLabel(session({ status: 'missing' }), true)).toBe('Path missing')
    expect(isAgentDone(session({ status: 'stopped' }), true)).toBe(false)
  })

  it('defaults to the previous behavior when the idle flag is omitted', () => {
    expect(sessionStatusLabel(session())).toBe('Running')
  })
})
