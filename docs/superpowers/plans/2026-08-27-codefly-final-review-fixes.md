# CodeFly Final Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final whole-branch review findings without changing CodeFly's approved product scope.

**Architecture:** Keep the existing service and IPC boundaries. Add recovery metadata to `SessionStore`, bounded pre-mount output buffering in `TerminalWorkspace`, transaction compensation in `SessionCoordinator`, a small testable shutdown gate, and production-only renderer loading safeguards. Extend the current unit and Electron E2E suites rather than introducing a second runtime architecture.

**Tech Stack:** Electron, React, TypeScript, xterm.js, Zustand, Zod, Vitest, Playwright

---

## File Map

- `src/main/services/session-store.ts`: retain corrupt input and expose one startup recovery warning.
- `src/shared/contracts.ts`: add the optional snapshot recovery-warning field.
- `src/main/index.ts`: include the warning in the first snapshot and register an awaited shutdown gate.
- `src/renderer/src/store/use-app-store.ts`: surface a snapshot recovery warning as the existing dismissible notice.
- `src/renderer/src/components/TerminalWorkspace.tsx`: buffer bounded terminal data until the owning xterm is mounted.
- `src/main/services/session-coordinator.ts`: compensate when the post-start persistence transition fails.
- `src/main/shutdown-controller.ts`: make Electron quit wait for coordinator cleanup without recursion.
- `src/main/window.ts`: ignore renderer URL injection in packaged builds and deny child windows.
- `src/main/ipc/register-ipc.ts`: reject IPC commands from webContents other than the owning window.
- `e2e/codefly.spec.ts`: prove the initial agent marker survives startup and exercise the 900 by 600 layout.

## Task 1: Preserve and Surface Corrupt-State Recovery

**Files:**
- Modify: `src/main/services/session-store.test.ts`
- Modify: `src/main/services/session-store.ts`
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/store/use-app-store.test.ts`
- Modify: `src/renderer/src/store/use-app-store.ts`

- [x] **Step 1: Write failing store recovery tests**

Add tests proving that a malformed primary is copied to `state.json.corrupt` without overwriting an existing corrupt archive, that backup recovery sets a readable warning, and that an invalid primary plus invalid backup reports the empty-state fallback. Keep the existing assertion that the malformed primary is not modified by `load()`.

```ts
const store = new SessionStore(filePath)
await expect(store.load()).resolves.toEqual(backup)
await expect(readFile(`${filePath}.corrupt`, 'utf8')).resolves.toBe(malformed)
expect(store.recoveryWarning()).toMatch(/recovered from backup/i)
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/main/services/session-store.test.ts`

Expected: FAIL because `recoveryWarning()` and the `.corrupt` archive do not exist.

- [x] **Step 3: Implement recovery metadata and archival**

Retain invalid file contents in the internal `DiskState`. During first load, atomically write the first corrupt primary to `${filePath}.corrupt` without replacing an existing archive. Record one immutable warning string on the store instance. Do not change the public `load(): Promise<AppState>` contract.

```ts
recoveryWarning(): string | undefined {
  return this.startupRecoveryWarning
}
```

Archive failures must not prevent safe backup/empty recovery; the warning must say the corrupt file could not be archived when that occurs.

- [x] **Step 4: Write failing renderer notice tests**

Extend the fake `getSnapshot()` result with `recoveryWarning: 'CodeFly recovered state from backup.'` and assert `initialize()` places that message into the existing warning notice. Add the optional field to `AppSnapshot`.

- [x] **Step 5: Run the renderer test and verify RED**

Run: `npm test -- src/renderer/src/store/use-app-store.test.ts`

Expected: FAIL because initialization ignores `recoveryWarning`.

- [x] **Step 6: Wire and render the warning**

Have `buildGetSnapshot` add `recoveryWarning: store.recoveryWarning()` after `coordinator.snapshot()` initializes the store. In `initialize()`, preserve existing state/capability behavior and seed the existing dismissible notice only when the optional warning is present.

- [x] **Step 7: Verify recovery behavior**

Run: `npm test -- src/main/services/session-store.test.ts src/renderer/src/store/use-app-store.test.ts && npm run typecheck`

Expected: all focused tests pass and both TypeScript projects exit 0.

## Task 2: Preserve Terminal Output Emitted Before xterm Mounts

**Files:**
- Modify: `src/renderer/src/components/TerminalWorkspace.test.tsx`
- Modify: `src/renderer/src/components/TerminalWorkspace.tsx`

- [x] **Step 1: Write a failing early-output test**

Render the workspace without an active session, invoke the captured `onTerminalData` listener for a known session ID, then activate/mount that session. Assert its terminal receives the early marker in order. Also send more than 64 KiB before mount and assert retained data is bounded to the newest 64 KiB.

```ts
terminalDataListener?.({ sessionId: 'session-1', data: 'CODEFLY_FAKE_AGENT_READY\r\n' })
rerender(<TerminalWorkspace sessions={[session]} activeSessionId="session-1" restoreSession={restoreSession} />)
expect(terminals[0]!.write).toHaveBeenCalledWith('CODEFLY_FAKE_AGENT_READY\r\n')
```

- [x] **Step 2: Run the component test and verify RED**

Run: `npm test -- src/renderer/src/components/TerminalWorkspace.test.tsx`

Expected: FAIL because unknown/unmounted session output is currently discarded.

- [x] **Step 3: Implement bounded pending output**

Keep a `Map<string, string>` in the component. If a terminal-data or terminal-exit event arrives before its entry exists, append it and retain only the newest 65,536 UTF-16 code units. Immediately after `ensureEntry` stores a new entry, delete and flush that session's pending text. Remove pending data for deleted sessions and clear the map on unmount.

- [x] **Step 4: Verify terminal behavior**

Run: `npm test -- src/renderer/src/components/TerminalWorkspace.test.tsx`

Expected: routing, bounded buffering, input, resize, preservation, and cleanup tests pass.

## Task 3: Compensate Post-Start Persistence Failures

**Files:**
- Modify: `src/main/services/session-coordinator.test.ts`
- Modify: `src/main/services/session-coordinator.ts`

- [x] **Step 1: Write failing create and restore compensation tests**

Inject a failure only into the `creating -> running` update after `terminalService.start()` succeeds. Assert `create()` and `restore()` reject with the original persistence error, call `terminalService.stop(sessionId)`, and attempt to persist `{ status: 'error', lastError }`. Add a case where compensation persistence also fails and verify the original error remains the rejection while the PTY is still stopped.

- [x] **Step 2: Run coordinator tests and verify RED**

Run: `npm test -- src/main/services/session-coordinator.test.ts`

Expected: FAIL because the live PTY is not stopped after the final update rejects.

- [x] **Step 3: Implement one compensation helper**

Wrap each post-start `updateSession(...running...)` call. On failure, stop the just-started PTY, then best-effort persist `error` with the original message. Log stop/reconciliation failures with session context, but rethrow the original persistence error. Do not roll back a worktree whose `creating` record was already persisted.

- [x] **Step 4: Verify session transactions**

Run: `npm test -- src/main/services/session-coordinator.test.ts`

Expected: create/restore compensation and all existing lifecycle/concurrency tests pass.

## Task 4: Await Child-Process Cleanup Before Electron Quits

**Files:**
- Create: `src/main/shutdown-controller.test.ts`
- Create: `src/main/shutdown-controller.ts`
- Modify: `src/main/index.ts`

- [x] **Step 1: Write failing shutdown-gate tests**

Test a small `createBeforeQuitHandler()` function with fake events. The first event must call `preventDefault()`, concurrent/re-entrant events must share one shutdown, `quit()` must run only after shutdown resolves, and a rejected shutdown must be logged before the final quit is allowed.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/main/shutdown-controller.test.ts`

Expected: FAIL because the shutdown gate does not exist.

- [x] **Step 3: Implement and compose the gate**

The handler owns `shutdownComplete` and `shutdownInFlight`. It prevents quit until the single cleanup promise settles, marks cleanup complete, then calls `app.quit()`; the second `before-quit` event passes through without prevention. Replace the fire-and-forget listener in `src/main/index.ts` with this handler.

- [x] **Step 4: Verify shutdown behavior**

Run: `npm test -- src/main/shutdown-controller.test.ts src/main/services/terminal-service.test.ts src/main/services/session-coordinator.test.ts && npm run typecheck`

Expected: shutdown ordering and existing process cleanup tests pass.

## Task 5: Harden Renderer and IPC Ownership Boundaries

**Files:**
- Create: `src/main/window.test.ts`
- Modify: `src/main/window.ts`
- Modify: `src/main/ipc/register-ipc.test.ts`
- Modify: `src/main/ipc/register-ipc.ts`

- [x] **Step 1: Write failing window security tests**

Mock Electron and assert packaged mode always calls `loadFile` even when `ELECTRON_RENDERER_URL` is inherited, development accepts only `http(s)` loopback hosts, remote/invalid values fall back to `loadFile`, and `setWindowOpenHandler` returns `{ action: 'deny' }`.

- [x] **Step 2: Run the window tests and verify RED**

Run: `npm test -- src/main/window.test.ts`

Expected: packaged mode currently calls `loadURL`, and no child-window policy exists.

- [x] **Step 3: Implement safe renderer selection**

Import `app`, gate URL loading on `!app.isPackaged`, parse with `URL`, allow only `http:`/`https:` and `localhost`, `127.0.0.1`, or `::1`, and otherwise load the bundled renderer file. Deny every renderer-created child window.

- [x] **Step 4: Write failing IPC sender tests**

Invoke one request handler and each send-only terminal listener with a fake foreign `sender`; assert service methods are untouched and the invoke rejects or send listener reports the unauthorized event through the existing error logger.

- [x] **Step 5: Run the IPC tests and verify RED**

Run: `npm test -- src/main/ipc/register-ipc.test.ts`

Expected: foreign events are currently processed.

- [x] **Step 6: Enforce the owning webContents**

Add one `assertOwningSender(event)` helper and call it before payload parsing in every registered handler/listener. Preserve strict Zod validation and existing cleanup behavior.

- [x] **Step 7: Verify security boundaries**

Run: `npm test -- src/main/window.test.ts src/main/ipc/register-ipc.test.ts && npm run typecheck`

Expected: safe URL, denied child-window, sender ownership, schema, and disposer tests pass.

## Task 6: Extend Electron E2E and Re-run the Release Gate

**Files:**
- Modify: `e2e/codefly.spec.ts`
- Modify: `docs/superpowers/plans/2026-08-27-codefly-final-review-fixes.md`

- [x] **Step 1: Assert the startup marker reaches xterm**

After creating the first Claude session, assert the visible xterm rows contain `CODEFLY_FAKE_AGENT_READY`. This verifies the bounded pre-mount buffer through the real preload/IPC/renderer path.

- [x] **Step 2: Exercise the 900 by 600 native window**

Use `electronApp.evaluate` to call `BrowserWindow.getAllWindows()[0].setSize(900, 600)`. Assert the project actions, new-session button, active terminal, both visible bypass warnings, and launcher remain visible. Check the launcher bounding box remains inside the Playwright viewport, close it with Escape, then restore 1180 by 760 for the remaining serial journey.

- [x] **Step 3: Run E2E**

Run: `npm run test:e2e`

Expected: every Electron journey passes, including initial output and the minimum-size layout.

- [ ] **Step 4: Run the complete release gate**

Run in order:

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run package:win
```

Expected: typecheck exits 0; all Vitest and Playwright tests pass; `release/CodeFly Setup 0.1.0.exe` and its blockmap receive fresh timestamps.

- [x] **Step 5: Check repository state and commit**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional source/test/plan changes before commit.

```powershell
git add docs/superpowers/plans/2026-08-27-codefly-final-review-fixes.md src e2e/codefly.spec.ts
git commit -m "fix: close final desktop review findings"
```

## Completion Checklist

- [x] Corrupt primary state is retained once and recovery is visible to the user.
- [x] PTY output that precedes xterm mounting is bounded and delivered in order.
- [x] A failed post-start persistence transition cannot leave an untracked live PTY.
- [x] Electron quit waits for coordinator shutdown and cannot run cleanup twice.
- [x] Packaged builds never load an environment-provided renderer URL.
- [x] Renderer-created child windows are denied and foreign IPC senders are rejected.
- [x] The 900 by 600 layout and fake-agent startup marker are covered by Electron E2E.
- [ ] Fresh typecheck, unit/integration/component tests, E2E, and Windows packaging pass.
