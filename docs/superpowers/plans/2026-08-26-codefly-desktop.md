# CodeFly Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first Electron desktop application that manages local projects and isolated PowerShell, Command Prompt, Claude, and Codex sessions with automatic Git worktrees, resumable session records, concise titles, project-opening shortcuts, and explicit disclosure of the requested agent bypass mode.

**Architecture:** Electron's main process owns Git, filesystem, external application, persistence, and PTY operations behind a schema-validated preload bridge. A React renderer presents projects, sessions, tabs, and xterm.js terminals; a session coordinator keeps persisted metadata and ephemeral process state consistent. Services use dependency injection so unit and integration tests exercise behavior without requiring authenticated AI CLIs.

**Tech Stack:** Electron, electron-vite, React, TypeScript, xterm.js, node-pty, Zustand, Zod, Vitest, Testing Library, Playwright, electron-builder

---

## File Map

The implementation creates the following focused units:

- `package.json`: scripts, runtime dependencies, and development tooling.
- `.gitignore`: generated dependency, build, package, coverage, and E2E artifacts.
- `electron.vite.config.ts`: main, preload, and renderer build configuration.
- `electron-builder.yml`: Windows NSIS packaging and native-module unpack rules.
- `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`: strict TypeScript boundaries.
- `vitest.config.ts`, `tests/setup.ts`: shared unit/component test setup.
- `src/shared/contracts.ts`: persisted records, request/response types, schemas, and capability types.
- `src/shared/ipc.ts`: IPC channel constants only.
- `src/main/index.ts`: composition root and Electron lifecycle.
- `src/main/window.ts`: secure `BrowserWindow` creation.
- `src/main/infrastructure/command-runner.ts`: non-shell child-process execution.
- `src/main/infrastructure/cli-locator.ts`: Windows executable and command-shim discovery.
- `src/main/services/session-store.ts`: versioned atomic JSON state.
- `src/main/services/project-service.ts`: project registration and Git-root discovery.
- `src/main/services/external-app-service.ts`: VS Code and File Explorer opening.
- `src/main/services/worktree-service.ts`: worktree naming, creation, validation, and safe removal.
- `src/main/services/title-service.ts`: AI title invocation and deterministic fallbacks.
- `src/main/services/terminal-service.ts`: node-pty lifecycle and event routing.
- `src/main/services/session-coordinator.ts`: end-to-end session create, restore, stop, title, and delete transactions.
- `src/main/ipc/register-ipc.ts`: validated IPC handlers and event publication.
- `src/preload/index.ts`, `src/preload/index.d.ts`: typed, narrow renderer API.
- `src/renderer/index.html`: renderer entry document.
- `src/renderer/src/main.tsx`: React bootstrap.
- `src/renderer/src/App.tsx`: window shell and global composition.
- `src/renderer/src/store/use-app-store.ts`: normalized application/UI state.
- `src/renderer/src/components/TitleBar.tsx`: brand, open-session tabs, and launcher button.
- `src/renderer/src/components/ProjectSidebar.tsx`: add/search/project/session navigation and row actions.
- `src/renderer/src/components/SessionLauncher.tsx`: terminal/agent choice popover.
- `src/renderer/src/components/TerminalWorkspace.tsx`: per-session xterm instance preservation.
- `src/renderer/src/components/AgentBypassStatus.tsx`: persistent warning for Claude/Codex bypass mode.
- `src/renderer/src/components/ConfirmDialog.tsx`: accessible destructive confirmation.
- `src/renderer/src/terminal/first-input-tracker.ts`: non-blocking first-line reconstruction.
- `src/renderer/src/assets/vscode.svg`: bundled VS Code mark.
- `src/renderer/src/styles.css`: reference-inspired responsive desktop styling.
- `e2e/codefly.spec.ts`, `e2e/fixtures/fake-agent.cjs`: packaged UI and PTY workflow coverage.

## Task 1: Bootstrap the Electron Application and Test Harness

**Files:**
- Create: `package.json`
- Modify: `.gitignore`
- Create: `electron.vite.config.ts`
- Create: `electron-builder.yml`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `src/main/index.ts`
- Create: `src/main/window.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/styles.css`

- [ ] **Step 1: Create the package manifest**

Create `package.json` with these scripts and dependency groups; then run `npm install` so npm resolves compatible current versions and writes `package-lock.json`:

```json
{
  "name": "codefly",
  "version": "0.1.0",
  "private": true,
  "description": "A Windows-first workspace for local terminal and AI coding sessions",
  "main": "./out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "npm run typecheck && electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "npm run build && playwright test",
    "package:win": "npm run build && electron-builder --win nsis --x64"
  },
  "dependencies": {
    "@xterm/addon-fit": "latest",
    "@xterm/xterm": "latest",
    "node-pty": "latest",
    "react": "latest",
    "react-dom": "latest",
    "write-file-atomic": "latest",
    "zod": "latest",
    "zustand": "latest"
  },
  "devDependencies": {
    "@electron-toolkit/utils": "latest",
    "@playwright/test": "latest",
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitest/coverage-v8": "latest",
    "@vitejs/plugin-react": "latest",
    "electron": "latest",
    "electron-builder": "latest",
    "electron-vite": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest"
  },
  "build": {
    "extends": "./electron-builder.yml"
  }
}
```

Run: `npm install`

Expected: exit 0; `package-lock.json` and `node_modules` exist. Replace every `latest` entry in `package.json` with the exact version resolved in `package-lock.json` before committing, so later installs are reproducible.

Append these entries to `.gitignore` while retaining `.superpowers/`:

```gitignore
node_modules/
out/
release/
coverage/
test-results/
playwright-report/
```

- [ ] **Step 2: Add strict build and test configuration**

Create `electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
```

Create `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node", "electron-vite/node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["electron.vite.config.ts", "src/main/**/*.ts", "src/preload/**/*.ts", "src/shared/**/*.ts", "tests/**/*.ts"]
}
```

Create `tsconfig.web.json` with DOM libraries, `jsx: react-jsx`, strict mode, and includes for `src/renderer/src/**/*.ts`, `src/renderer/src/**/*.tsx`, `src/preload/index.d.ts`, and `src/shared/**/*.ts`.

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['tests/setup.ts'],
    coverage: { reporter: ['text', 'html'], exclude: ['out/**', 'release/**'] }
  }
})
```

Create `tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: Create a secure window that renders a placeholder shell**

Create `src/main/window.ts` with a `BrowserWindow` using `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a minimum size of 900 by 600, and preload path `../preload/index.js`. Load `ELECTRON_RENDERER_URL` in development and `../renderer/index.html` in production.

Create `src/main/index.ts`:

```ts
import { app } from 'electron'
import { createMainWindow } from './window'

app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (process.platform === 'darwin') createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

Create a no-op `src/preload/index.ts`, a renderer `index.html` with `<div id="root"></div>`, and a React entry that renders `<App />`. `App.tsx` should display `CodeFly` and `Workspace initializing` so startup can be checked before feature code exists.

- [ ] **Step 4: Add Windows packaging configuration**

Create `electron-builder.yml`:

```yaml
appId: com.codefly.desktop
productName: CodeFly
directories:
  output: release
files:
  - out/**
  - package.json
asarUnpack:
  - node_modules/node-pty/**
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 5: Verify the scaffold**

Run: `npm run typecheck && npm test && npm run build`

Expected: typecheck exits 0, Vitest reports no failing tests, and electron-vite creates `out/main`, `out/preload`, and `out/renderer`.

- [ ] **Step 6: Commit the scaffold**

```bash
git add .gitignore package.json package-lock.json electron.vite.config.ts electron-builder.yml tsconfig*.json vitest.config.ts tests src
git commit -m "build: bootstrap CodeFly Electron app"
```

## Task 2: Define Shared Contracts and IPC Schemas

**Files:**
- Create: `src/shared/contracts.ts`
- Create: `src/shared/ipc.ts`
- Test: `src/shared/contracts.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `src/shared/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { appStateSchema, createSessionRequestSchema, terminalResizeRequestSchema } from './contracts'

describe('shared contracts', () => {
  it('rejects an invalid session kind', () => {
    expect(createSessionRequestSchema.safeParse({ projectId: 'p1', kind: 'bash' }).success).toBe(false)
  })

  it('rejects unsafe terminal dimensions', () => {
    expect(terminalResizeRequestSchema.safeParse({ sessionId: 's1', cols: 0, rows: 30 }).success).toBe(false)
  })

  it('accepts an empty version-one state', () => {
    expect(appStateSchema.parse({ version: 1, projects: [], sessions: [] })).toEqual({
      version: 1,
      projects: [],
      sessions: []
    })
  })
})
```

- [ ] **Step 2: Run the tests and observe the missing module failure**

Run: `npm test -- src/shared/contracts.test.ts`

Expected: FAIL because `./contracts` does not exist.

- [ ] **Step 3: Implement the shared schemas and inferred types**

Create `src/shared/contracts.ts` with Zod schemas for these exact shapes:

```ts
import { z } from 'zod'

export const sessionKindSchema = z.enum(['powershell', 'cmd', 'claude', 'codex'])
export const runtimeStatusSchema = z.enum(['creating', 'running', 'stopped', 'error', 'missing'])
export const titleStateSchema = z.enum(['pending', 'complete'])

export const projectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repoRoot: z.string().min(1).optional(),
  createdAt: z.string().datetime()
})

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: sessionKindSchema,
  title: z.string().min(1),
  titleState: titleStateSchema,
  createdAt: z.string().datetime(),
  mode: z.enum(['worktree', 'ordinary']),
  worktreeName: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  launchPath: z.string().min(1),
  status: runtimeStatusSchema,
  lastError: z.string().optional()
}).superRefine((session, context) => {
  if (session.mode !== 'worktree') return
  for (const field of ['worktreeName', 'worktreePath', 'branchName'] as const) {
    if (!session[field]) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} is required in worktree mode` })
    }
  }
})

export const appStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(projectRecordSchema),
  sessions: z.array(sessionRecordSchema)
})

export const toolAvailabilitySchema = z.object({ available: z.boolean(), detail: z.string() })
export const capabilityStateSchema = z.object({
  claude: toolAvailabilitySchema,
  codex: toolAvailabilitySchema,
  vscode: toolAvailabilitySchema
})

export const createSessionRequestSchema = z.object({
  projectId: z.string().min(1),
  kind: sessionKindSchema
})
export const sessionIdRequestSchema = z.object({ sessionId: z.string().min(1) })
export const projectIdRequestSchema = z.object({ projectId: z.string().min(1) })
export const terminalWriteRequestSchema = z.object({ sessionId: z.string().min(1), data: z.string().max(65536) })
export const terminalResizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
})
export const firstInputRequestSchema = z.object({ sessionId: z.string().min(1), text: z.string().min(1).max(65536) })

export type AppState = z.infer<typeof appStateSchema>
export type ProjectRecord = z.infer<typeof projectRecordSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type SessionKind = z.infer<typeof sessionKindSchema>
export type CapabilityState = z.infer<typeof capabilityStateSchema>
export type AppSnapshot = { state: AppState; capabilities: CapabilityState }
export type DeleteSessionResult = { status: 'deleted' } | { status: 'dirty'; changedFiles: number } | { status: 'failed'; message: string }
```

Create `src/shared/ipc.ts` with `IPC` constants for snapshot get, project add/open-code/open-folder, session create/restore/delete, first input, terminal write/resize, and state/terminal-data/terminal-exit events. Do not repeat string literals in main, preload, or renderer code.

- [ ] **Step 4: Run the schema tests and typecheck**

Run: `npm test -- src/shared/contracts.test.ts && npm run typecheck`

Expected: 3 tests pass and typecheck exits 0.

- [ ] **Step 5: Commit the contracts**

```bash
git add src/shared
git commit -m "feat: define application contracts"
```

## Task 3: Implement Versioned Atomic Session Storage

**Files:**
- Create: `src/main/services/session-store.ts`
- Test: `src/main/services/session-store.test.ts`

- [ ] **Step 1: Write failing persistence and recovery tests**

Use a temporary directory in `src/main/services/session-store.test.ts`. Assert that `load()` returns `{ version: 1, projects: [], sessions: [] }` when absent, `save()` round-trips valid state, runtime `running` and `creating` states load as `stopped`, and malformed primary JSON falls back to `<state>.bak` without overwriting the malformed file.

```ts
it('normalizes ephemeral statuses after restart', async () => {
  await store.save(stateWithSessions('running', 'creating'))
  const loaded = await store.load()
  expect(loaded.sessions.map((session) => session.status)).toEqual(['stopped', 'stopped'])
})
```

- [ ] **Step 2: Run the storage tests to verify failure**

Run: `npm test -- src/main/services/session-store.test.ts`

Expected: FAIL because `SessionStore` is missing.

- [ ] **Step 3: Implement `SessionStore`**

Implement this public API in `src/main/services/session-store.ts`:

```ts
export class SessionStore {
  constructor(private readonly filePath: string) {}
  load(): Promise<AppState>
  save(state: AppState): Promise<void>
  update(mutator: (state: AppState) => AppState): Promise<AppState>
}
```

`load()` parses with `appStateSchema`, tries `${filePath}.bak` after a primary failure, and normalizes `creating`/`running` to `stopped`. `save()` validates before writing, copies an existing valid primary file to `.bak`, and calls `writeFileAtomic(filePath, json, { encoding: 'utf8' })`. `update()` serializes mutations through a private promise queue so two session operations cannot lose each other's writes.

- [ ] **Step 4: Run storage tests**

Run: `npm test -- src/main/services/session-store.test.ts`

Expected: all storage round-trip, normalization, backup, and serialization tests pass.

- [ ] **Step 5: Commit storage**

```bash
git add src/main/services/session-store.ts src/main/services/session-store.test.ts
git commit -m "feat: persist projects and sessions atomically"
```

## Task 4: Add Command Infrastructure and Project Registration

**Files:**
- Create: `src/main/infrastructure/command-runner.ts`
- Create: `src/main/infrastructure/cli-locator.ts`
- Create: `src/main/services/project-service.ts`
- Test: `src/main/services/project-service.test.ts`

- [ ] **Step 1: Write failing project registration tests**

Test directory validation, case-insensitive deduplication on Windows, display-name extraction, Git root discovery, and non-Git fallback. Inject a fake command runner rather than requiring Git for these unit tests.

```ts
it('keeps a non-Git project without repoRoot', async () => {
  runner.run.mockRejectedValue(new Error('not a repository'))
  const project = await service.register('C:\\work\\plain-folder')
  expect(project).toMatchObject({ name: 'plain-folder', path: 'C:\\work\\plain-folder' })
  expect(project.repoRoot).toBeUndefined()
})
```

- [ ] **Step 2: Run the project tests to verify failure**

Run: `npm test -- src/main/services/project-service.test.ts`

Expected: FAIL because project and command services are missing.

- [ ] **Step 3: Implement safe command execution and CLI lookup**

`command-runner.ts` must expose:

```ts
export type CommandResult = { stdout: string; stderr: string; exitCode: number }
export interface CommandRunner {
  run(file: string, args: readonly string[], cwd?: string): Promise<CommandResult>
}
export const commandRunner: CommandRunner
```

Implement it with `execFile`, `windowsHide: true`, UTF-8 decoding, and no `shell`. Preserve stdout, stderr, and exit code in a typed `CommandError`.

`cli-locator.ts` must use `where.exe <name>` and return the first existing result. It also exposes `resolvePowerShell()` with `pwsh.exe` then `powershell.exe` precedence, and `resolveAgent('claude' | 'codex')`.

- [ ] **Step 4: Implement `ProjectService`**

Give `ProjectService` a `SessionStore`, `CommandRunner`, filesystem adapter, `clock`, and UUID factory. `register(selectedPath)` must resolve the real directory, reject files, return an existing project for a case-insensitive path match, probe `git -C <path> rev-parse --show-toplevel`, create a `ProjectRecord`, and persist it. `get(projectId)` throws a typed `ProjectNotFoundError` rather than accepting a renderer-provided path.

- [ ] **Step 5: Run project tests and typecheck**

Run: `npm test -- src/main/services/project-service.test.ts && npm run typecheck`

Expected: project tests pass and typecheck exits 0.

- [ ] **Step 6: Commit project infrastructure**

```bash
git add src/main/infrastructure src/main/services/project-service*
git commit -m "feat: register local projects safely"
```

## Task 5: Open Projects in VS Code and File Explorer

**Files:**
- Create: `src/main/services/external-app-service.ts`
- Test: `src/main/services/external-app-service.test.ts`

- [ ] **Step 1: Write failing external-app tests**

Cover VS Code lookup order (`where.exe code`, per-user install, machine install), direct argument-array spawning, File Explorer delegation through `shell.openPath`, missing paths, and launch failures. Assert that the service accepts a `ProjectRecord`, not a free-form path from IPC.

```ts
it('opens the original project path as one VS Code argument', async () => {
  locator.resolveVSCode.mockResolvedValue('C:\\Program Files\\Microsoft VS Code\\Code.exe')
  await service.openInVSCode(projectAt('C:\\work space\\app'))
  expect(spawnDetached).toHaveBeenCalledWith(
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    ['C:\\work space\\app']
  )
})
```

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- src/main/services/external-app-service.test.ts`

Expected: FAIL because `ExternalAppService` does not exist.

- [ ] **Step 3: Implement `ExternalAppService`**

Implement:

```ts
export class ExternalAppService {
  capabilities(): Promise<Pick<CapabilityState, 'vscode'>>
  openInVSCode(project: ProjectRecord): Promise<void>
  openInExplorer(project: ProjectRecord): Promise<void>
}
```

Resolve VS Code from `where.exe code`, `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, then `%ProgramFiles%\Microsoft VS Code\Code.exe`. Spawn detached with `[project.path]`, `stdio: 'ignore'`, and no shell. Use Electron `shell.openPath(project.path)` for Explorer and treat a non-empty return string as failure. Verify `project.path` still exists before either action.

- [ ] **Step 4: Run external-app tests**

Run: `npm test -- src/main/services/external-app-service.test.ts`

Expected: lookup, safe path handling, and failure tests pass.

- [ ] **Step 5: Commit external application support**

```bash
git add src/main/services/external-app-service*
git commit -m "feat: open projects in VS Code and Explorer"
```

## Task 6: Implement Git Worktree Lifecycle

**Files:**
- Create: `src/main/services/worktree-service.ts`
- Test: `src/main/services/worktree-service.test.ts`

- [ ] **Step 1: Write failing real-Git integration tests**

Create temporary repositories using the real Git binary. Configure a local test identity, create one committed file, and verify:

- `worktree-260826-1` and then `worktree-260826-2` for an injected 2026-08-26 clock.
- Worktree directory and branch names match.
- Existing branches, directories, persisted sessions, and `git worktree list` entries advance the sequence.
- `/.worktrees/` is added through `git rev-parse --git-path info/exclude`, not tracked `.gitignore`.
- A selected nested directory maps to the same relative directory in the worktree.
- Non-Git and no-commit repositories return ordinary mode.
- Dirty worktrees return `{ status: 'dirty' }` and remain present.
- Clean removal deletes the worktree but leaves the branch.

Run tests serially so repositories do not compete for Git locks.

- [ ] **Step 2: Run the worktree test and observe failure**

Run: `npm test -- src/main/services/worktree-service.test.ts --no-file-parallelism`

Expected: FAIL because `WorktreeService` is missing.

- [ ] **Step 3: Implement naming, probing, and creation**

Implement these result types and methods:

```ts
export type SessionLocation =
  | { mode: 'ordinary'; launchPath: string }
  | { mode: 'worktree'; launchPath: string; worktreeName: string; worktreePath: string; branchName: string; repoRoot: string }

export type RemoveWorktreeResult =
  | { status: 'removed' }
  | { status: 'dirty'; changedFiles: number }
  | { status: 'missing' }

export class WorktreeService {
  create(project: ProjectRecord, knownSessions: readonly SessionRecord[]): Promise<SessionLocation>
  validate(session: SessionRecord): Promise<'valid' | 'missing'>
  remove(session: SessionRecord): Promise<RemoveWorktreeResult>
  rollback(location: Extract<SessionLocation, { mode: 'worktree' }>): Promise<void>
}
```

Serialize `create()` calls with a per-repository promise queue. Probe `git -C <repo> rev-parse --verify HEAD`; on failure return ordinary mode. Build `worktree-YYMMDD-N` from local date. Collect used names from session records, `.worktrees` entries, `git branch --format=%(refname:short)`, and `git worktree list --porcelain`. Append the exclude rule only when absent. Run `git worktree add -b <name> <absoluteTarget> HEAD` with an argument array. On one detected collision, recompute and retry once.

- [ ] **Step 4: Implement validation and safe removal**

`validate()` checks path existence and confirms it appears in `git worktree list --porcelain`. `remove()` counts lines from `git status --porcelain`; non-empty output returns dirty, missing paths return missing, and clean paths run `git worktree remove <absolutePath>` without `--force`. `rollback()` is only callable for a not-yet-persisted location and removes its worktree followed by `git branch -D <branch>`.

- [ ] **Step 5: Run worktree tests**

Run: `npm test -- src/main/services/worktree-service.test.ts --no-file-parallelism`

Expected: all naming, fallback, exclude, nested-path, dirty-delete, clean-delete, and retained-branch cases pass.

- [ ] **Step 6: Commit worktree support**

```bash
git add src/main/services/worktree-service*
git commit -m "feat: isolate sessions with Git worktrees"
```

## Task 7: Generate Titles with AI and Deterministic Fallbacks

**Files:**
- Create: `src/main/services/title-service.ts`
- Create: `src/renderer/src/terminal/first-input-tracker.ts`
- Test: `src/main/services/title-service.test.ts`
- Test: `src/renderer/src/terminal/first-input-tracker.test.ts`

- [ ] **Step 1: Write failing title sanitization and fallback tests**

Cover Chinese and English text, ANSI removal, quote removal, whitespace collapse, 24-code-point truncation, AI timeout, empty AI output, and fallback priority. Assert PowerShell/CMD never call an AI adapter. Assert the Claude title adapter uses only `--print`, the Codex title adapter uses only `exec --skip-git-repo-check -`, and neither receives an interactive-session bypass flag.

```ts
it('uses Claude, then local normalization, then direct truncation', async () => {
  claude.generate.mockRejectedValue(new Error('offline'))
  expect(await service.generate('claude', '请帮我修复 skipped trades 统计。后面是细节')).toBe('请帮我修复 skipped trades 统计')
})
```

- [ ] **Step 2: Write failing first-input tracker tests**

Feed chunks for printable keys, paste, backspace, ANSI arrow keys, empty Enter, and a final Enter. Verify the tracker returns the first reconstructed non-empty line once and never alters the chunks that the terminal receives.

- [ ] **Step 3: Run title tests and verify failure**

Run: `npm test -- src/main/services/title-service.test.ts src/renderer/src/terminal/first-input-tracker.test.ts`

Expected: FAIL because both units are missing.

- [ ] **Step 4: Implement title adapters and fallbacks**

Implement `TitleService.generate(sessionId, kind, input)` and `TitleService.cancel(sessionId)`. The session ID keys the in-flight process map so deletion and shutdown can cancel the correct child. Use an injected `TitleAdapter` map. The production Claude adapter spawns the resolved executable with exactly `['--print']`; the Codex adapter uses exactly `['exec', '--skip-git-repo-check', '-']` so the neutral title directory does not need to be a repository. These arrays must not be composed from the interactive terminal launch specifications. Send this fixed instruction plus delimited input on stdin:

```text
Return one concise session title only. Use the input language. No quotes, markdown, or explanation. Limit the title to 24 characters.

<input>
USER_INPUT
</input>
```

Run in `<userData>/title-generator`, stop after 15 seconds, and stop reading after 4 KiB. Sanitize output to one line and 24 Unicode code points. On failure or empty output, use the first non-empty sentence with prompt prefixes and redundant punctuation removed; finally truncate the raw input.

- [ ] **Step 5: Implement the input tracker**

`FirstInputTracker.push(data)` must return `{ submitted?: string; passthrough: data }`. Ignore ANSI control sequences for capture, apply backspace to captured code points, treat CR or LF as submission, and keep waiting after an empty line. Once a non-empty line is returned, mark the tracker complete and never return another submission.

- [ ] **Step 6: Run title tests**

Run: `npm test -- src/main/services/title-service.test.ts src/renderer/src/terminal/first-input-tracker.test.ts`

Expected: all adapter, timeout, fallback, Unicode, and tracker cases pass.

- [ ] **Step 7: Commit title generation**

```bash
git add src/main/services/title-service* src/renderer/src/terminal
git commit -m "feat: title sessions from first input"
```

## Task 8: Manage PTY Processes and Launch Adapters

**Files:**
- Create: `src/main/services/terminal-service.ts`
- Test: `src/main/services/terminal-service.test.ts`

- [ ] **Step 1: Write failing PTY lifecycle tests**

Inject a fake `IPtyFactory` and test start, duplicate-start rejection, write, resize, output routing by session ID, exit transition, stop, and stop-all. Test launch specifications for PowerShell, CMD, Claude, and Codex, including `.cmd` shims with paths containing spaces. Assert Claude receives exactly `['--dangerously-skip-permissions']` and Codex receives exactly `['--dangerously-bypass-approvals-and-sandbox']` before any `.cmd` host wrapping.

- [ ] **Step 2: Run terminal tests to verify failure**

Run: `npm test -- src/main/services/terminal-service.test.ts`

Expected: FAIL because `TerminalService` is missing.

- [ ] **Step 3: Implement terminal launch specifications**

Define:

```ts
export type TerminalEventMap = {
  data: { sessionId: string; data: string }
  exit: { sessionId: string; exitCode: number }
}

export class TerminalService {
  start(session: SessionRecord): Promise<void>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  stop(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  isRunning(sessionId: string): boolean
  on<K extends keyof TerminalEventMap>(event: K, listener: (payload: TerminalEventMap[K]) => void): () => void
}
```

PowerShell resolves `pwsh.exe` before `powershell.exe`; CMD uses `%ComSpec%` or `cmd.exe`. Claude uses the resolved executable plus `['--dangerously-skip-permissions']`. Codex uses the resolved executable plus `['--dangerously-bypass-approvals-and-sandbox']`. Keep these fixed arrays in the main-process launch adapter; do not accept overrides from IPC, persisted state, or renderer settings.

If an npm command shim ends in `.cmd`, use `%ComSpec%` with fixed `/d /s /c` wrapping generated only from the trusted resolved path and the corresponding fixed bypass argument. Spawn through node-pty with `cwd: session.launchPath`, inherited environment, `TERM=xterm-256color`, 120 columns, and 30 rows.

- [ ] **Step 4: Implement lifecycle cleanup**

Keep PTYs in a `Map<string, IPty>`. Remove the entry before publishing exit, make `stop()` idempotent, wait up to two seconds for exit, then call `kill()` once. Never persist process IDs. Return unsubscribe functions from every event subscription.

- [ ] **Step 5: Run terminal tests**

Run: `npm test -- src/main/services/terminal-service.test.ts`

Expected: all lifecycle and adapter cases pass.

- [ ] **Step 6: Commit terminal support**

```bash
git add src/main/services/terminal-service*
git commit -m "feat: run local shells and coding agents"
```

## Task 9: Orchestrate Complete Session Transactions

**Files:**
- Create: `src/main/services/session-coordinator.ts`
- Test: `src/main/services/session-coordinator.test.ts`

- [ ] **Step 1: Write failing create, restore, title, and delete tests**

Use mocked services to prove transaction order:

- Create location, persist a `creating` record, start PTY, then persist `running`.
- If PTY start fails for a new worktree, remove the temporary record and call `rollback()`.
- Restore validates a worktree before start and marks missing paths.
- First input starts one title job per session and persists the eventual title.
- Delete stops PTY before status inspection.
- Dirty delete returns `{ status: 'dirty' }` and retains metadata.
- Clean delete removes worktree then metadata, leaving branch handling to `WorktreeService`.
- Missing worktree allows metadata removal after confirmation.

- [ ] **Step 2: Run coordinator tests to verify failure**

Run: `npm test -- src/main/services/session-coordinator.test.ts`

Expected: FAIL because `SessionCoordinator` is missing.

- [ ] **Step 3: Implement the coordinator API**

Implement:

```ts
export class SessionCoordinator {
  snapshot(): Promise<AppState>
  create(projectId: string, kind: SessionKind): Promise<SessionRecord>
  restore(sessionId: string): Promise<SessionRecord>
  stop(sessionId: string): Promise<void>
  submitFirstInput(sessionId: string, text: string): Promise<void>
  delete(sessionId: string): Promise<DeleteSessionResult>
  shutdown(): Promise<void>
  onStateChanged(listener: (state: AppState) => void): () => void
}
```

Use initial titles `New PowerShell session`, `New Command Prompt session`, `New Claude session`, and `New Codex session`. Generate IDs with `crypto.randomUUID()`. Emit state only after validated persistence. Guard create/delete/restore by session ID or project ID locks so double-clicks cannot duplicate work.

- [ ] **Step 4: Implement title and exit updates**

Subscribe once to terminal exits. Unexpected exits persist `stopped`; explicit stop uses the same final state. `submitFirstInput()` changes `titleState` from pending before calling `TitleService.generate(sessionId, kind, text)`, ignores later submissions, persists sanitized results, and emits state. If the title process fails beyond all fallbacks, keep the temporary title and mark `titleState: complete`.

- [ ] **Step 5: Run coordinator tests**

Run: `npm test -- src/main/services/session-coordinator.test.ts`

Expected: all transaction ordering, rollback, restore, title-once, and deletion safety cases pass.

- [ ] **Step 6: Commit orchestration**

```bash
git add src/main/services/session-coordinator*
git commit -m "feat: coordinate persistent session lifecycle"
```

## Task 10: Expose a Validated Preload API

**Files:**
- Create: `src/main/ipc/register-ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Create: `src/preload/index.d.ts`
- Test: `src/main/ipc/register-ipc.test.ts`

- [ ] **Step 1: Write failing IPC validation tests**

Use a fake `ipcMain` registrar. Assert every command parses its request with the corresponding Zod schema, unknown session/project IDs are resolved in services, terminal events are published only to non-destroyed windows, and project selection cancellation returns `null`.

- [ ] **Step 2: Run IPC tests to verify failure**

Run: `npm test -- src/main/ipc/register-ipc.test.ts`

Expected: FAIL because `registerIpc` is missing.

- [ ] **Step 3: Implement main-process handlers**

`registerIpc()` must register handlers for the constants from `src/shared/ipc.ts`. The add-project handler calls `dialog.showOpenDialog({ properties: ['openDirectory'] })`, then `ProjectService.register()`. Open-code and open-folder accept only `projectId`, resolve the record with `ProjectService.get()`, and call `ExternalAppService`. Session handlers call `SessionCoordinator`. Terminal write and resize are send-only channels after schema parsing.

Return one disposer that removes every handler/listener. Publish `stateChanged`, terminal data, and terminal exit to the owning `BrowserWindow.webContents` only when it is not destroyed.

- [ ] **Step 4: Implement the preload bridge and renderer declaration**

Expose exactly this shape from `src/preload/index.ts`:

```ts
export type CodeFlyApi = {
  getSnapshot(): Promise<AppSnapshot>
  addProject(): Promise<ProjectRecord | null>
  openProjectInVSCode(projectId: string): Promise<void>
  openProjectFolder(projectId: string): Promise<void>
  createSession(projectId: string, kind: SessionKind): Promise<SessionRecord>
  restoreSession(sessionId: string): Promise<SessionRecord>
  deleteSession(sessionId: string): Promise<DeleteSessionResult>
  submitFirstInput(sessionId: string, text: string): Promise<void>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  onStateChanged(listener: (state: AppState) => void): () => void
  onTerminalData(listener: (event: { sessionId: string; data: string }) => void): () => void
  onTerminalExit(listener: (event: { sessionId: string; exitCode: number }) => void): () => void
}
```

Use `contextBridge.exposeInMainWorld('codefly', api)`. In `index.d.ts`, augment `Window` with `codefly: CodeFlyApi`.

- [ ] **Step 5: Compose production services in `src/main/index.ts`**

Create the state path with `path.join(app.getPath('userData'), 'state.json')`, instantiate each service once, register IPC after window creation, call `coordinator.shutdown()` during `before-quit`, and dispose IPC subscriptions when the window closes. Build `AppSnapshot` by combining persisted coordinator state with Claude/Codex lookup results from `cli-locator` and the VS Code result from `ExternalAppService.capabilities()`.

- [ ] **Step 6: Run IPC tests and typecheck**

Run: `npm test -- src/main/ipc/register-ipc.test.ts && npm run typecheck`

Expected: IPC tests pass and neither preload nor renderer exposes Node APIs.

- [ ] **Step 7: Commit the process boundary**

```bash
git add src/main/index.ts src/main/ipc src/preload
git commit -m "feat: expose secure desktop IPC API"
```

## Task 11: Build the Project and Session Navigation UI

**Files:**
- Create: `src/renderer/src/store/use-app-store.ts`
- Create: `src/renderer/src/components/TitleBar.tsx`
- Create: `src/renderer/src/components/ProjectSidebar.tsx`
- Create: `src/renderer/src/components/SessionLauncher.tsx`
- Create: `src/renderer/src/components/AgentBypassStatus.tsx`
- Create: `src/renderer/src/components/ConfirmDialog.tsx`
- Modify: `src/renderer/src/App.tsx`
- Test: `src/renderer/src/App.test.tsx`
- Test: `src/renderer/src/components/ProjectSidebar.test.tsx`

- [ ] **Step 1: Write failing UI interaction tests**

Use `// @vitest-environment jsdom` and a complete fake `window.codefly`. Test loading snapshot state, adding a project, searching sessions, choosing all four launcher kinds, switching a running session, restoring a stopped session, delete-event propagation, dirty-delete feedback, VS Code action, folder action, capability-disabled entries, and the active-session bypass warning. The warning must be present for Claude/Codex and absent for PowerShell/CMD.

```tsx
it('opens Explorer without toggling the project or restoring a session', async () => {
  render(<App />)
  await user.click(await screen.findByRole('button', { name: 'Open project folder' }))
  expect(api.openProjectFolder).toHaveBeenCalledWith('project-1')
  expect(api.restoreSession).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run renderer tests to verify failure**

Run: `npm test -- src/renderer/src/App.test.tsx src/renderer/src/components/ProjectSidebar.test.tsx`

Expected: FAIL because the store and components are missing.

- [ ] **Step 3: Implement the Zustand store**

The store holds `AppState`, `CapabilityState`, `activeProjectId`, `activeSessionId`, `launcherOpen`, `searchQuery`, and one dismissible notice. Actions call `window.codefly`, then rely on returned records and `onStateChanged` to reconcile authoritative state. `initialize()` registers one state subscription and returns its disposer.

- [ ] **Step 4: Implement navigation components**

`TitleBar` renders the CodeFly mark, currently running/opened tabs, and plus button. `ProjectSidebar` renders Add Project, search, project groups, the bundled VS Code icon button, folder button, expand control, and session rows. Put action buttons before the expand control and call `event.stopPropagation()` on both project actions and the session delete action.

`AgentBypassStatus` reads the active session kind and runtime status. For a running Claude or Codex session it renders `Permissions and sandbox bypass enabled` with `role="status"`; for stopped sessions, PowerShell, CMD, or no active session it renders nothing. Place it at the bottom of the main workspace so it remains visible while terminal output scrolls.

Stopped rows display `Click to restore`; clicking calls `restoreSession`. Running rows only set active session. The delete button opens `ConfirmDialog`; after confirmation, a dirty result shows `Worktree has N changed files. Commit or discard them before deleting.`

- [ ] **Step 5: Implement the session launcher**

Render PowerShell, Command Prompt, Claude, and Codex in that order. Show `Ctrl+T` beside PowerShell. Disable Claude/Codex from capability state and include the capability detail as visible help text. Creating a session closes the launcher and selects the returned session.

- [ ] **Step 6: Run UI tests**

Run: `npm test -- src/renderer/src/App.test.tsx src/renderer/src/components/ProjectSidebar.test.tsx`

Expected: all project, launcher, restore, delete, and external-action tests pass.

- [ ] **Step 7: Commit navigation UI**

```bash
git add src/renderer/src/store src/renderer/src/components src/renderer/src/App.tsx
git commit -m "feat: add project and session navigation"
```

## Task 12: Integrate xterm.js and First-Input Capture

**Files:**
- Create: `src/renderer/src/components/TerminalWorkspace.tsx`
- Test: `src/renderer/src/components/TerminalWorkspace.test.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Write failing terminal workspace tests**

Mock `Terminal` and `FitAddon`. Verify one terminal instance per opened session, hidden terminals remain mounted during switches, output routes by session ID, keystrokes always call `writeTerminal`, first submission calls `submitFirstInput` exactly once, resize calls include positive rows/columns, and all API/event subscriptions dispose on unmount.

- [ ] **Step 2: Run the terminal tests to verify failure**

Run: `npm test -- src/renderer/src/components/TerminalWorkspace.test.tsx`

Expected: FAIL because `TerminalWorkspace` is missing.

- [ ] **Step 3: Implement terminal ownership**

Maintain a `Map<sessionId, { terminal, fitAddon, tracker, element }>` in `TerminalWorkspace`. Create an entry when a session first becomes active and keep its element mounted with `display: none` while inactive so in-process scrollback survives tab changes. Dispose entries only after session deletion or component unmount.

Subscribe once to terminal data and dispatch it to the matching terminal. On xterm `onData`, call `tracker.push(data)`, immediately call `window.codefly.writeTerminal(sessionId, passthrough)`, then fire-and-forget `submitFirstInput` when `submitted` exists. Fit on activation and through `ResizeObserver`; send only changed positive dimensions.

- [ ] **Step 4: Add terminal headers and process status**

Above each terminal, render title, full launch path, session kind, and running/stopped status. A running Claude/Codex header also renders the same `Permissions and sandbox bypass enabled` text used by `AgentBypassStatus`. Preserve existing xterm contents after an unexpected exit and show a compact restart action that calls the same restore path as the sidebar.

- [ ] **Step 5: Run terminal and tracker tests**

Run: `npm test -- src/renderer/src/components/TerminalWorkspace.test.tsx src/renderer/src/terminal/first-input-tracker.test.ts`

Expected: all routing, input, resize, preservation, and cleanup tests pass.

- [ ] **Step 6: Commit terminal UI**

```bash
git add src/renderer/src/components/TerminalWorkspace* src/renderer/src/App.tsx
git commit -m "feat: embed persistent session terminals"
```

## Task 13: Apply the Reference-Inspired Visual System

**Files:**
- Create: `src/renderer/src/assets/vscode.svg`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/renderer/src/components/TitleBar.tsx`
- Modify: `src/renderer/src/components/ProjectSidebar.tsx`
- Modify: `src/renderer/src/components/SessionLauncher.tsx`
- Modify: `src/renderer/src/components/TerminalWorkspace.tsx`
- Modify: `src/renderer/src/components/AgentBypassStatus.tsx`
- Test: `src/renderer/src/App.test.tsx`

- [ ] **Step 1: Add visual and accessibility assertions**

Extend component tests to assert accessible names for all icon-only buttons, focus restoration after closing the launcher/dialog, keyboard activation of session rows, visible disabled-tool explanations, title/path `title` attributes for ellipsized content, and destructive-state styling on the bypass warning.

- [ ] **Step 2: Run the accessibility assertions to verify failure**

Run: `npm test -- src/renderer/src/App.test.tsx`

Expected: FAIL on missing labels, focus behavior, or tooltip attributes.

- [ ] **Step 3: Add the bundled VS Code SVG and intentional styling**

Add a local blue VS Code SVG asset with `viewBox="0 0 24 24"`; do not fetch it at runtime. Define CSS variables for canvas, panel, elevated panel, border, text, muted text, blue accent, green running state, amber warning, and red destructive state.

Use `Bahnschrift` for application chrome and `Cascadia Mono` for terminal metadata and xterm. Build the dark layered background with a subtle radial blue highlight rather than a flat fill. Match the approved structure: 46-pixel title bar, 300-pixel sidebar, compact session rows, blue active rail, status pills, rounded launcher, and a fixed bottom bypass strip using the destructive red token. Use a 180ms staggered opacity/translate reveal for the sidebar and terminal only; honor `prefers-reduced-motion`.

- [ ] **Step 4: Add responsive desktop behavior**

At widths below 1000 pixels, reduce the sidebar to 250 pixels and tab widths to 150 pixels. At the 900-pixel minimum, preserve terminal readability, truncate labels, and keep project action icons reachable. Do not introduce a mobile navigation mode because the product is Windows desktop only.

- [ ] **Step 5: Run UI tests and make a development build**

Run: `npm test -- src/renderer && npm run build`

Expected: renderer tests pass and the production renderer bundle builds without asset warnings.

- [ ] **Step 6: Manually inspect at two sizes**

Run: `npm run dev`

Verify at 1180x760 and 900x600: no clipped action buttons, launcher remains inside the window, xterm resizes, keyboard focus is visible, and project/session paths truncate with tooltips.

- [ ] **Step 7: Commit visual polish**

```bash
git add src/renderer
git commit -m "style: match CodeFly desktop reference"
```

## Task 14: Add End-to-End Coverage and Windows Packaging Verification

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/codefly.spec.ts`
- Create: `e2e/fixtures/fake-agent.cjs`
- Create: `e2e/fixtures/create-repo.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/services/terminal-service.ts`
- Create: `README.md`

- [ ] **Step 1: Create deterministic E2E fixtures**

`create-repo.ts` creates a temporary Git repository, configures a local identity, commits one file, and prints its path. `fake-agent.cjs` writes `process.argv.slice(2)` as JSON to the file named by `CODEFLY_E2E_ARGV_LOG`, prints a ready marker, echoes stdin, and exits on `exit`. In `CODEFLY_E2E=1` only, allow dependency composition to use the fixture executable for Claude/Codex and `CODEFLY_E2E_PROJECT` as the directory-dialog result. Production builds without that environment retain real services.

- [ ] **Step 2: Write failing Electron E2E tests**

Create `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]]
})
```

Launch Electron with Playwright's `_electron.launch({ args: ['.'], env: { ...process.env, CODEFLY_E2E: '1', CODEFLY_E2E_PROJECT: repoPath } })`. Cover:

1. Add the fixture project.
2. Create Claude and verify `.worktrees/worktree-YYMMDD-1` is displayed.
3. Verify the Claude argv log is exactly `['--dangerously-skip-permissions']` and the persistent bypass warning is visible.
4. Submit text and observe title replacement without either bypass argument appearing in the title-process argv log.
5. Create Codex and verify its argv is exactly `['--dangerously-bypass-approvals-and-sandbox']`.
6. Create PowerShell/CMD and verify the bypass warning is absent while either is active.
7. Create a second worktree session and observe sequence 2.
8. Stop/relaunch the app and click a stopped session to restore it.
9. Click mocked VS Code and Explorer actions without toggling the project row.
10. Make a worktree dirty and verify delete is blocked.
11. Clean it, delete the session, verify directory removal and branch retention.

- [ ] **Step 3: Run E2E and observe the first actionable failure**

Run: `npm run test:e2e`

Expected: the test reaches the application and initially fails at the first missing test-mode integration or UI contract; do not weaken assertions to pass.

- [ ] **Step 4: Complete test-mode dependency injection and pass E2E**

Keep the E2E switches in the main-process composition root. Do not add test conditionals to renderer components or domain services. Run until all workflows pass.

Run: `npm run test:e2e`

Expected: all Electron E2E tests pass on Windows.

- [ ] **Step 5: Document installation and runtime prerequisites**

Create `README.md` with Node/npm prerequisites, `npm install`, `npm run dev`, `npm test`, `npm run test:e2e`, `npm run package:win`, Git requirement for isolated sessions, ordinary-session fallback, local Claude/Codex installation expectations, the two fixed interactive bypass flags and their risk, VS Code behavior, worktree location, dirty-delete protection, and the fact that branches remain after session deletion.

- [ ] **Step 6: Run the full verification suite**

Run:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run package:win
```

Expected: typecheck passes, all unit/integration/component/E2E tests pass, and `release/` contains a Windows x64 NSIS installer.

- [ ] **Step 7: Perform authenticated manual smoke checks**

On a Windows machine with logged-in `claude` and `codex` CLIs, install the generated package and verify both agents start in their assigned worktrees, accept input, produce terminal output, and fall back to local titles if the separate title process is unavailable. Also verify PowerShell, CMD, VS Code, File Explorer, paths with spaces, and paths containing Chinese characters.

- [ ] **Step 8: Commit the verified application**

```bash
git add playwright.config.ts e2e src/main README.md package.json package-lock.json
git commit -m "test: verify CodeFly desktop workflows"
```

## Completion Checklist

- [ ] Every acceptance criterion in `docs/superpowers/specs/2026-08-26-ai-programming-desktop-design.md` maps to at least one automated or manual verification above.
- [ ] `git status --short` contains no unintended files; `node_modules`, `out`, `release`, coverage output, and Playwright artifacts are ignored.
- [ ] No renderer code imports Node.js or Electron modules directly.
- [ ] No Git, CLI, VS Code, or Explorer path is accepted directly from the renderer.
- [ ] Interactive Claude and Codex PTYs receive their exact requested bypass flag, title processes receive neither flag, and the active agent UI continuously displays the bypass warning.
- [ ] No worktree deletion uses force and no completed-session branch is deleted.
- [ ] The packaged installer starts successfully on Windows x64.
