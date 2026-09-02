import type { SessionKind } from '../../../shared/contracts'

/**
 * What Shift+Enter sends to an agent CLI: ESC followed by CR, the bytes a terminal emits for
 * Alt/Meta+Enter. It is the one newline encoding both CLIs accept on Windows, measured through
 * a real ConPTY (typing "abc", the sequence, "def" into the live composer):
 * - Claude Code (claude.exe 2.1.258) reads the VT stream directly and documents Meta+Enter as
 *   newline: two lines, no submit. Plain LF (Ctrl+J) works for it too.
 * - Codex (0.152.1) reads Win32 console key events, so ConPTY translates ESC CR into Alt+Enter,
 *   which its composer treats as newline. LF is NOT an option for it: ConPTY turns LF into
 *   Ctrl+Enter, which Codex ignores ("abcdef" on one line). CSI-u encodings such as
 *   `ESC [ 13 ; 2 u` never arrive at all — ConPTY drops them for console-API readers.
 */
export const AGENT_NEWLINE_SEQUENCE = '\x1b\r'

/** The subset of KeyboardEvent the bindings look at; xterm hands the raw DOM event to us. */
export type TerminalKeyEvent = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

export type TerminalKeyAction =
  /** Let xterm evaluate the key as it normally would. */
  | { action: 'xterm' }
  /**
   * Skip xterm entirely and let the browser's default handling run. For Ctrl+V/Cmd+V
   * keydown that default is the paste command, whose `paste` event xterm already listens for
   * (bracketed paste included); for keypress/keyup it simply means "nothing to do".
   */
  | { action: 'browser' }
  /** Skip xterm and write this to the PTY instead. The caller must preventDefault the event. */
  | { action: 'send'; data: string }

const isAgentSession = (kind: SessionKind): boolean => kind === 'claude' || kind === 'codex'

// `code` is the physical key, so Ctrl/Cmd+V still pastes on non-Latin layouts (where `key` is e.g.
// 'м') — matching how the browser itself resolves the shortcut; `key` covers exotic layouts
// whose V sits on another physical key.
const isPasteShortcut = (event: TerminalKeyEvent): boolean =>
  event.ctrlKey !== event.metaKey &&
  !event.shiftKey &&
  !event.altKey &&
  (event.code === 'KeyV' || event.key.toLowerCase() === 'v')

const isShiftEnter = (event: TerminalKeyEvent): boolean =>
  event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Enter'

/**
 * Decides how a key event in a session's terminal is handled before xterm sees it.
 *
 * xterm maps Ctrl+V to ^V (0x16) and Shift+Enter to a bare CR, then cancels the DOM event.
 * That suits shells — PSReadLine and conhost read the clipboard themselves on ^V — but not
 * Claude Code or Codex, which neither paste text on ^V nor can tell Shift+Enter from Enter.
 * Agent sessions therefore route Ctrl+V/Cmd+V to the browser's paste and Shift+Enter to
 * {@link AGENT_NEWLINE_SEQUENCE}; shell sessions are left exactly as xterm handles them.
 */
export function resolveTerminalKey(kind: SessionKind, event: TerminalKeyEvent): TerminalKeyAction {
  if (!isAgentSession(kind)) return { action: 'xterm' }
  if (isPasteShortcut(event)) return { action: 'browser' }
  if (isShiftEnter(event)) {
    // Only keydown carries the action: with its default prevented no keypress follows, and the
    // keyup must still bypass xterm so it cannot turn into a stray CR.
    return event.type === 'keydown' ? { action: 'send', data: AGENT_NEWLINE_SEQUENCE } : { action: 'browser' }
  }
  return { action: 'xterm' }
}
