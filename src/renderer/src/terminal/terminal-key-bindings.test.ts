import { describe, expect, it } from 'vitest'

import type { SessionKind } from '../../../shared/contracts'
import { AGENT_NEWLINE_SEQUENCE, resolveTerminalKey, type TerminalKeyEvent } from './terminal-key-bindings'

const key = (overrides: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  type: 'keydown',
  key: '',
  code: '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides
})

const ctrlV = (type: TerminalKeyEvent['type'] = 'keydown'): TerminalKeyEvent => key({ type, key: 'v', code: 'KeyV', ctrlKey: true })
const commandV = (type: TerminalKeyEvent['type'] = 'keydown'): TerminalKeyEvent => key({ type, key: 'v', code: 'KeyV', metaKey: true })
const shiftEnter = (type: TerminalKeyEvent['type'] = 'keydown'): TerminalKeyEvent => key({ type, key: 'Enter', code: 'Enter', shiftKey: true })

const agentKinds: SessionKind[] = ['claude', 'codex']
const shellKinds: SessionKind[] = ['shell', 'powershell', 'cmd']

describe('resolveTerminalKey', () => {
  describe.each(agentKinds)('%s session', (kind) => {
    it('hands Ctrl+V to the browser so its paste event reaches xterm instead of sending ^V to the CLI', () => {
      expect(resolveTerminalKey(kind, ctrlV('keydown'))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, ctrlV('keypress'))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, ctrlV('keyup'))).toEqual({ action: 'browser' })
    })

    it('hands Cmd+V to the browser so macOS paste reaches xterm', () => {
      expect(resolveTerminalKey(kind, commandV('keydown'))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, commandV('keypress'))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, commandV('keyup'))).toEqual({ action: 'browser' })
    })

    it('recognises Ctrl+V by physical key on non-Latin layouts and with Caps Lock', () => {
      expect(resolveTerminalKey(kind, key({ key: 'м', code: 'KeyV', ctrlKey: true }))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, key({ key: 'V', code: 'KeyV', ctrlKey: true }))).toEqual({ action: 'browser' })
    })

    it('leaves Ctrl+Shift+V, Ctrl+Alt+V and Ctrl+Meta+V to xterm', () => {
      expect(resolveTerminalKey(kind, key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: true }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'v', code: 'KeyV', ctrlKey: true, metaKey: true }))).toEqual({ action: 'xterm' })
    })

    it('turns Shift+Enter keydown into the ESC CR newline sequence both CLIs accept', () => {
      expect(resolveTerminalKey(kind, shiftEnter('keydown'))).toEqual({ action: 'send', data: AGENT_NEWLINE_SEQUENCE })
      expect(AGENT_NEWLINE_SEQUENCE).toBe('\x1b\r')
    })

    it('swallows the keypress/keyup halves of Shift+Enter so xterm cannot also send a bare CR', () => {
      expect(resolveTerminalKey(kind, shiftEnter('keypress'))).toEqual({ action: 'browser' })
      expect(resolveTerminalKey(kind, shiftEnter('keyup'))).toEqual({ action: 'browser' })
    })

    it('leaves plain Enter and Enter with other modifiers to xterm', () => {
      expect(resolveTerminalKey(kind, key({ key: 'Enter', code: 'Enter' }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'Enter', code: 'Enter', altKey: true }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'Enter', code: 'Enter', shiftKey: true, ctrlKey: true }))).toEqual({ action: 'xterm' })
    })

    it('treats Shift+NumpadEnter like the main Shift+Enter', () => {
      expect(resolveTerminalKey(kind, key({ key: 'Enter', code: 'NumpadEnter', shiftKey: true }))).toEqual({ action: 'send', data: AGENT_NEWLINE_SEQUENCE })
    })

    it('leaves ordinary keys to xterm', () => {
      expect(resolveTerminalKey(kind, key({ key: 'a', code: 'KeyA' }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'c', code: 'KeyC', ctrlKey: true }))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toEqual({ action: 'xterm' })
    })
  })

  describe.each(shellKinds)('%s session', (kind) => {
    it('leaves Ctrl+V to xterm so PSReadLine/conhost keep handling ^V natively', () => {
      expect(resolveTerminalKey(kind, ctrlV('keydown'))).toEqual({ action: 'xterm' })
    })

    it('leaves Shift+Enter to xterm', () => {
      expect(resolveTerminalKey(kind, shiftEnter('keydown'))).toEqual({ action: 'xterm' })
      expect(resolveTerminalKey(kind, shiftEnter('keyup'))).toEqual({ action: 'xterm' })
    })
  })
})
