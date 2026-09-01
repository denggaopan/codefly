import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../../shared/contracts'
import { createTranslator } from './i18n'
import { isAgentDone, sessionStatusLabel } from './session-status'

const t = createTranslator('en')

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
    expect(sessionStatusLabel(t, session({ kind }), true)).toBe('Done')
    expect(isAgentDone(session({ kind }), true)).toBe(true)
  })

  it.each(['claude', 'codex'] as const)('keeps Running for a %s session that is still producing output', (kind) => {
    expect(sessionStatusLabel(t, session({ kind }), false)).toBe('Running')
    expect(isAgentDone(session({ kind }), false)).toBe(false)
  })

  it.each(['powershell', 'cmd'] as const)('never labels a %s shell session Done', (kind) => {
    expect(sessionStatusLabel(t, session({ kind }), true)).toBe('Running')
    expect(isAgentDone(session({ kind }), true)).toBe(false)
  })

  it('keeps the stopped/error/missing labels regardless of idleness', () => {
    expect(sessionStatusLabel(t, session({ status: 'stopped' }), true)).toBe('Click to restore')
    expect(sessionStatusLabel(t, session({ status: 'error', lastError: 'boom' }), true)).toBe('boom')
    expect(sessionStatusLabel(t, session({ status: 'missing' }), true)).toBe('Path missing')
    expect(isAgentDone(session({ status: 'stopped' }), true)).toBe(false)
  })

  it('defaults to the previous behavior when the idle flag is omitted', () => {
    expect(sessionStatusLabel(t, session())).toBe('Running')
  })

  // Guards against the labels being reintroduced as hardcoded English: these can only come
  // from the dictionary the caller's translator is bound to.
  it("renders the labels in the translator's locale", () => {
    const zh = createTranslator('zh-CN')
    expect(sessionStatusLabel(zh, session({ kind: 'claude' }), true)).toBe('已完成')
    expect(sessionStatusLabel(zh, session({ kind: 'claude' }), false)).toBe('运行中')
    expect(sessionStatusLabel(zh, session({ status: 'stopped' }))).toBe('点击恢复')
    expect(sessionStatusLabel(zh, session({ status: 'creating' }))).toBe('启动中…')
    expect(sessionStatusLabel(zh, session({ status: 'missing' }))).toBe('路径不存在')
    expect(sessionStatusLabel(zh, session({ status: 'error' }))).toBe('错误')
    // A main-process error message is runtime data, not UI copy: it passes through as-is.
    expect(sessionStatusLabel(zh, session({ status: 'error', lastError: 'boom' }))).toBe('boom')
  })
})
