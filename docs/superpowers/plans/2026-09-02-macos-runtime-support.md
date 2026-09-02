# macOS Runtime Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodeFly's unsigned Intel and Apple Silicon bundles usable on macOS for Shell, Claude, and Codex sessions without changing Windows behavior.

**Architecture:** Add a host-platform value and an explicit `shell` session kind to shared contracts, then keep OS decisions in small platform-aware helpers at the main-process and renderer boundaries. Session coordination, persistence, Git worktrees, IPC validation, and agent argument construction remain shared.

**Tech Stack:** Electron 44, TypeScript, React 19, Zustand, zod, node-pty, Vitest, Playwright, electron-builder.

**Authorization note:** The user requested fast implementation but did not authorize commits. The normal per-task commit steps are replaced with `git diff --check` checkpoints; leave all changes uncommitted.

---

### Task 1: Add the shared platform and Shell contracts

**Files:**
- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/contracts.test.ts`
- Create: `src/renderer/src/session-kind-options.ts`
- Create: `src/renderer/src/session-kind-options.test.ts`

- [x] **Step 1: Write failing contract tests**

Add assertions that `sessionKindSchema` accepts `shell`, `hostPlatformSchema` accepts only `win32`/`darwin`, `AppSnapshot` includes the platform, and stored preferences may include a partial `shell` record while still accepting old four-kind values.

```ts
expect(sessionKindSchema.safeParse('shell').success).toBe(true)
expect(hostPlatformSchema.safeParse('darwin').success).toBe(true)
expect(hostPlatformSchema.safeParse('linux').success).toBe(false)
expect(storedSessionKindPreferencesSchema.safeParse({ shell: { worktree: true } }).success).toBe(true)
```

- [x] **Step 2: Run the focused contract test and confirm RED**

Run: `npx vitest run src/shared/contracts.test.ts`

Expected: failure because `shell` and `hostPlatformSchema` do not exist.

- [x] **Step 3: Extend the contracts**

Implement these shapes and add `shell` to both full and lenient preference records:

```ts
export const hostPlatformSchema = z.enum(['win32', 'darwin'])
export const sessionKindSchema = z.enum(['shell', 'powershell', 'cmd', 'claude', 'codex'])
export type HostPlatform = z.infer<typeof hostPlatformSchema>
export type AppSnapshot = {
  platform: HostPlatform
  state: AppState
  capabilities: CapabilityState
  recoveryWarning?: string
}
```

Keep `DEFAULT_SESSION_KIND_PREFERENCES` as the complete Windows-compatible record, with `shell` disabled by default.

- [x] **Step 4: Write failing platform-catalog tests**

Test ordered visible kinds, ordinary-session shortcuts, and platform defaults:

```ts
expect(sessionKindOptions('win32').map(({ kind }) => kind)).toEqual(['powershell', 'cmd', 'claude', 'codex'])
expect(sessionKindOptions('darwin').map(({ kind }) => kind)).toEqual(['shell', 'claude', 'codex'])
expect(defaultSessionKindPreferences('darwin').shell).toEqual({ enabled: true, worktree: false })
expect(defaultSessionKindPreferences('darwin').cmd.enabled).toBe(false)
```

- [x] **Step 5: Implement `session-kind-options.ts`**

Export one typed catalog and two pure selectors so launcher/settings do not maintain duplicate platform tables:

```ts
export const sessionKindOptions = (platform: HostPlatform): readonly SessionKindOption[] =>
  PLATFORM_OPTIONS[platform]

export const defaultSessionKindPreferences = (platform: HostPlatform): SessionKindPreferences => ({
  ...DEFAULT_SESSION_KIND_PREFERENCES,
  shell: { enabled: platform === 'darwin', worktree: false },
  powershell: { enabled: platform === 'win32', worktree: false },
  cmd: { enabled: platform === 'win32', worktree: false }
})
```

- [x] **Step 6: Run focused tests and inspect the diff**

Run: `npx vitest run src/shared/contracts.test.ts src/renderer/src/session-kind-options.test.ts`

Expected: both files pass. Then run `git diff --check`.

### Task 2: Resolve macOS shells and CLI executables

**Files:**
- Modify: `src/main/infrastructure/command-runner.ts`
- Modify: `src/main/infrastructure/command-runner.test.ts`
- Modify: `src/main/infrastructure/cli-locator.ts`
- Modify: `src/main/infrastructure/cli-locator.test.ts`

- [x] **Step 1: Write a failing command timeout test**

```ts
await expect(
  commandRunner.run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], undefined, { timeoutMs: 10 })
).rejects.toMatchObject({ code: expect.anything() })
```

- [x] **Step 2: Add optional runner timeout support**

Extend `CommandRunner.run` with an optional fourth `{ timeoutMs?: number }` argument and pass it to `execFile` as `timeout`. Existing callers and fakes remain valid because the argument is optional.

- [x] **Step 3: Write failing macOS locator tests**

Cover login-shell output containing noise, fallback paths, executable validation, unsafe names, and Shell resolution:

```ts
const locator = new CliLocator(runnerWith(run), isExecutable, {
  platform: 'darwin',
  environment: { SHELL: '/bin/zsh', HOME: '/Users/me' }
})
await expect(locator.resolveAgent('claude')).resolves.toBe('/opt/homebrew/bin/claude')
expect(run).toHaveBeenCalledWith('/bin/zsh', ['-lic', 'command -v -- claude'], undefined, { timeoutMs: 5000 })
```

Also verify an invalid `$SHELL` falls back to `/bin/zsh`, `~/.local/bin/codex` is checked, and Windows still makes the exact `where.exe` calls asserted today.

- [x] **Step 4: Implement platform-aware `CliLocator`**

Inject `platform`, environment, and an executable predicate. Keep fixed-name validation. On macOS:

1. Choose an absolute executable `$SHELL` or `/bin/zsh`.
2. run `<shell> -lic "command -v -- <fixed-name>"` with a five-second timeout;
3. parse non-empty lines, remove quotes, accept only absolute executable candidates;
4. fall back to `/opt/homebrew/bin`, `/usr/local/bin`, and `$HOME/.local/bin`.

Add `resolveShell()` and keep `resolvePowerShell()` Windows-only.

- [x] **Step 5: Run focused tests and inspect the diff**

Run: `npx vitest run src/main/infrastructure/command-runner.test.ts src/main/infrastructure/cli-locator.test.ts`

Expected: both files pass. Then run `git diff --check`.

### Task 3: Launch and restore macOS sessions

**Files:**
- Modify: `src/main/services/terminal-service.ts`
- Modify: `src/main/services/terminal-service.test.ts`
- Modify: `src/main/services/title-service.ts`
- Modify: `src/main/services/title-service.test.ts`
- Modify: `src/main/services/session-coordinator.ts`
- Modify: `src/main/services/session-coordinator.test.ts`

- [x] **Step 1: Write failing TerminalService tests**

Test that `shell` on Darwin launches the resolved shell with `['-l']`, Darwin agents launch their absolute files directly with existing flags/resume args, and unsupported combinations reject before `pty.spawn`:

```ts
await service.start(recordOfKind('shell'))
expect(ptyFactory.spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({ cwd: '/Users/me/project' }))

await expect(darwinService.start(recordOfKind('cmd'))).rejects.toThrow(/not supported on macOS/i)
await expect(winService.start(recordOfKind('shell'))).rejects.toThrow(/not supported on Windows/i)
```

- [x] **Step 2: Implement platform-gated launch specs**

Expand the injected locator to include `resolveShell`. Preserve the existing Windows shim adapter exactly. Add a direct Darwin adapter and make `resolveSpec` exhaustive over all five kinds.

- [x] **Step 3: Write and pass title/coordinator tests**

Add `shell: 'New Shell session'` to fallback titles. Verify `create` persists `kind: 'shell'`, and verify Darwin title adapters launch agent paths directly without Windows shim wrapping. Keep title generation agent-only.

- [x] **Step 4: Run the service tests and inspect the diff**

Run: `npx vitest run src/main/services/terminal-service.test.ts src/main/services/title-service.test.ts src/main/services/session-coordinator.test.ts`

Expected: all pass. Then run `git diff --check`.

### Task 4: Adapt projects, VS Code, and window chrome

**Files:**
- Modify: `src/main/services/project-service.ts`
- Modify: `src/main/services/project-service.test.ts`
- Modify: `src/main/services/external-app-service.ts`
- Modify: `src/main/services/external-app-service.test.ts`
- Modify: `src/main/window.ts`
- Modify: `src/main/window.test.ts`

- [x] **Step 1: Write failing project identity tests**

Assert Windows paths remain case-insensitive while Darwin paths retain POSIX separators/case and deduplicate canonical equivalents returned by `realpath`.

- [x] **Step 2: Implement platform-aware path keys**

Inject `NodeJS.Platform` into `ProjectService`; use the existing Windows normalization only on `win32`, and strip only trailing POSIX separators on Darwin.

- [x] **Step 3: Write failing macOS VS Code tests**

Test detection of `/Applications/Visual Studio Code.app` and launch through `/usr/bin/open` with separate arguments:

```ts
expect(spawnDetached).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Visual Studio Code', '/Users/me/project'])
```

Keep every current Windows direct-spawn and `ComSpec` fallback assertion.

- [x] **Step 4: Implement the macOS external-app adapter**

Inject platform into `ExternalAppService`. On Darwin, check system/user app locations and launch with `/usr/bin/open`; continue to use `shell.openPath` for folders and vetted `shell.openExternal` for repository URLs.

- [x] **Step 5: Write failing macOS window tests**

Call `createMainWindow('darwin')` and assert `titleBarStyle: 'hiddenInset'`, no `titleBarOverlay`, no Windows `.ico`, and traffic-light-safe settings. Call `applyWindowTheme(window, theme, 'darwin')` and assert it changes native/background colors without calling `setTitleBarOverlay`.

- [x] **Step 6: Implement platform-specific BrowserWindow options**

Make platform an injectable defaulted argument. Keep current Windows options byte-for-byte and use native macOS chrome without the Windows overlay call.

- [x] **Step 7: Run focused tests and inspect the diff**

Run: `npx vitest run src/main/services/project-service.test.ts src/main/services/external-app-service.test.ts src/main/window.test.ts`

Expected: all pass. Then run `git diff --check`.

### Task 5: Make updates fail closed outside Windows

**Files:**
- Modify: `src/main/services/app-info-service.ts`
- Modify: `src/main/services/app-info-service.test.ts`
- Modify: `src/main/services/updater-service.ts`
- Modify: `src/main/services/updater-service.test.ts`

- [x] **Step 1: Write failing platform update tests**

For the same release containing a Windows `.exe`, assert Darwin returns `status: 'available'` without `asset`. Assert Darwin `download()` and `install()` return errors before network, disk, or spawn calls.

```ts
expect(await macAppInfo.checkForUpdates()).toEqual(expect.objectContaining({ status: 'available' }))
expect(await macAppInfo.checkForUpdates()).not.toHaveProperty('asset')
await expect(macUpdater.download()).resolves.toEqual({ status: 'error', message: expect.stringMatching(/Windows only/i) })
```

- [x] **Step 2: Implement platform guards**

Inject `NodeJS.Platform` into both services. `AppInfoService` only calls `pickWindowsInstaller` on `win32`; `UpdaterService.download/install` return a stable Windows-only error elsewhere. Do not change Windows parsing, trust checks, streaming, cancellation, cleanup, or spawn confirmation.

- [x] **Step 3: Run full update tests and inspect the diff**

Run: `npx vitest run src/main/services/app-info-service.test.ts src/main/services/updater-service.test.ts src/renderer/src/components/UpdateDialog.test.tsx src/renderer/src/store/use-app-store.test.ts`

Expected: all pass. Then run `git diff --check`.

### Task 6: Wire platform state into the renderer and composition root

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/register-ipc.test.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `src/renderer/src/store/use-app-store.ts`
- Modify: `src/renderer/src/store/use-app-store.test.ts`
- Modify: `src/renderer/src/components/SessionLauncher.tsx`
- Modify: `src/renderer/src/components/SessionLauncher.test.tsx`
- Modify: `src/renderer/src/components/SettingsDialog.tsx`
- Modify: `src/renderer/src/components/SettingsDialog.test.tsx`
- Modify: `src/renderer/src/components/TerminalWorkspace.tsx`
- Modify: `src/renderer/src/components/ProjectSidebar.tsx`
- Modify: `src/renderer/src/session-kind-icons.ts`
- Add an appropriate Shell SVG asset beside the existing session-kind assets if the icon helper uses files.
- Modify: `src/renderer/src/i18n/en.ts`
- Modify: `src/renderer/src/i18n/zh-CN.ts`
- Modify: `src/renderer/src/styles.css`

- [x] **Step 1: Write failing snapshot/store tests**

Update fake snapshots with `platform`. Assert initialization stores Darwin, merges local preferences over Darwin defaults after the snapshot arrives, and sets `document.documentElement.dataset.platform = 'darwin'`.

- [x] **Step 2: Wire the main-process platform**

Validate the production platform is `win32` or `darwin`, pass it into platform-aware services/window functions, add it to every snapshot, and extend E2E fakes with `resolveShell`. Preserve the `CODEFLY_E2E` composition boundary.

- [x] **Step 3: Implement platform-aware renderer state**

Add `platform` to `AppStore`. Read session preferences after the snapshot platform is known and merge over `defaultSessionKindPreferences(snapshot.platform)`. Persist the complete five-kind record. Reset to Windows defaults for deterministic browser tests.

- [x] **Step 4: Write failing launcher/settings tests**

Render with Darwin state and assert Shell/Claude/Codex are present, PowerShell/Command Prompt are absent, the shortcut is `Cmd+T`, and creating Shell sends `('shell', false)`. Assert Settings shows exactly the same three kind rows.

- [x] **Step 5: Update renderer components and translations**

Consume `sessionKindOptions(platform)` in both launcher and settings, add `sessionKind.shell` in English and Chinese, render a Shell icon, and display Shell in terminal/sidebar labels. Add a Darwin CSS rule that reserves left-side traffic-light space while keeping the settings button at the right.

- [x] **Step 6: Verify manual-download update behavior**

Retain the existing `downloadable: false` branch in `UpdateDialog`; update Windows-specific copy so Darwin users see a neutral “download this release from the Releases page” message.

- [x] **Step 7: Run renderer and IPC tests**

Run: `npx vitest run src/shared/contracts.test.ts src/main/ipc/register-ipc.test.ts src/renderer/src/session-kind-options.test.ts src/renderer/src/store/use-app-store.test.ts src/renderer/src/components/SessionLauncher.test.tsx src/renderer/src/components/SettingsDialog.test.tsx src/renderer/src/components/TerminalWorkspace.test.tsx src/renderer/src/components/ProjectSidebar.test.tsx`

Expected: all pass. Then run `git diff --check`.

### Task 7: Document and validate internal macOS packages

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify if required by structural checks: `electron-builder.yml`
- Modify if required by structural checks: `scripts/package-mac.container.sh`

- [x] **Step 1: Update product and prerequisite documentation**

Replace “Windows-first/package only” statements with Windows/macOS runtime support. Document macOS requirements: Git, Claude/Codex discoverable from the login shell, unsigned internal install, `xattr -cr`, ad-hoc `codesign --force --deep --sign -`, and separate x64/arm64 artifacts.

- [x] **Step 2: Add the real macOS smoke checklist**

Include Finder launch, paths with spaces/non-ASCII text, ordinary/worktree Shell and agents, restore/delete, VS Code/folder actions, login item, manual update link, `Cmd+V`, and `Shift+Enter`. Mark Intel and Apple Silicon as separate required runs.

- [x] **Step 3: Run documentation and package-configuration checks**

Run: `rg -n "Windows-first|where\.exe|package ≠|Windows installer" README.md CLAUDE.md`

Expected: only intentionally platform-specific statements remain.

Run: `git diff --check`.

### Task 8: Full verification

**Files:**
- Verify all files changed by Tasks 1-7.

- [x] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: exit 0.

- [x] **Step 2: Run the complete unit/integration suite**

Run: `npm test`

Expected: all test files and tests pass.

- [x] **Step 3: Build production output**

Run: `npm run build`

Expected: typecheck and electron-vite build exit 0.

- [x] **Step 4: Build both macOS archives when Docker is available**

Run: `npm run package:mac`

Expected: `release/CodeFly-0.11.8-mac-x64.zip` and `release/CodeFly-0.11.8-mac-arm64.zip` are produced. If Docker is unavailable, report this as an environment limitation and still inspect any existing archives without claiming a fresh package build.

- [x] **Step 5: Inspect archive structure**

Use an archive listing tool to verify each zip contains `CodeFly.app`, the expected Electron architecture, preserved framework symlinks, and only the matching `node-pty/prebuilds/darwin-*` runtime binary.

- [x] **Step 6: Review scope and working tree**

Run: `git diff --check`, `git status --short`, and `git diff --stat`.

Expected: no whitespace errors; only macOS support, tests, design/plan, and documentation are changed; nothing is committed or pushed.
