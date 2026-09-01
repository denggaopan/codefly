# CodeFly

CodeFly is a Windows-first desktop application for running local PowerShell, Command
Prompt, Claude Code, and Codex sessions against local projects. It is a focused terminal
workspace, not an embedded code editor: each session in a Git repository gets its own
isolated Git worktree and same-named branch, and Claude/Codex run through their locally
installed, already-authenticated CLIs. CodeFly never collects, stores, or reads API keys or
CLI credentials.

Built with Electron, React, TypeScript, xterm.js, and node-pty.

## Prerequisites

- Windows 10/11 x64.
- [Node.js](https://nodejs.org/) 22.12.0 or later, with npm.
- [Git for Windows](https://git-scm.com/download/win) on `PATH`. Required for isolated
  worktree sessions (see [Git and worktree sessions](#git-and-worktree-sessions) below);
  CodeFly still runs without it, but every session then falls back to an ordinary,
  non-isolated session in the project's own directory. Sessions created from a plain launcher
  entry run there by design and need no Git.
- Optional, to actually use the Claude/Codex launcher entries: the
  [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or the
  [Codex CLI](https://github.com/openai/codex) (`codex`) installed and signed in. CodeFly
  detects them on `PATH` at startup; a missing or unauthenticated CLI leaves its launcher
  entry visible but disabled, with an installation hint.
- Optional: [Visual Studio Code](https://code.visualstudio.com/) (or its `code` command on
  `PATH`) to use “Open project in VS Code” from a project's options menu.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the app in development mode with hot reload (via `electron-vite`).

## Scripts

| Script                 | Purpose                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run dev`           | Run the app in development mode with hot reload.                                                            |
| `npm run build`         | Type-check, then build the main, preload, and renderer bundles into `out/`.                                 |
| `npm run typecheck`     | Type-check the main/preload/shared sources and the renderer sources (two separate `tsc` project references). |
| `npm test`               | Run the Vitest unit/component/integration suite (`src/**/*.test.ts(x)`).                                    |
| `npm run test:watch`     | Run the Vitest suite in watch mode.                                                                          |
| `npm run test:e2e`       | Build the app, then run the Playwright Electron end-to-end suite (`e2e/codefly.spec.ts`).                    |
| `npm run package:win`    | Build the app, then produce a Windows x64 NSIS installer under `release/` via `electron-builder`.            |

## Session kinds and the New session menu

Every session kind — PowerShell, Command Prompt, Claude, Codex — has two switches under
**Session kinds** in Settings:

- **Enabled** decides whether the kind appears in the New session menu at all. Turning it off
  removes its entries; existing sessions of that kind are untouched. This is different from a
  missing CLI, which leaves the entry listed but disabled with a lookup hint.
- **New worktree** adds a *second* entry for that kind — e.g. both **Claude** and
  **Claude (new worktree)**. The plain entry runs the session in the project's own directory;
  the worktree entry gives it an isolated Git worktree and branch.

Defaults: all four kinds enabled, **New worktree** off for PowerShell and Command Prompt
(a quick terminal should not create a branch) and on for Claude and Codex (isolation is what
the agents want). Both switches are renderer-owned preferences stored in `localStorage`, like
the theme and language; the worktree choice itself is sent explicitly with each create
request, so the main process never infers it from a stored setting.

## Git and worktree sessions

When you create a session from a **(new worktree)** entry in a project that is a Git
repository with at least one commit, CodeFly creates an isolated Git worktree and a
same-named branch for that session, under `<repository-root>/.worktrees/<worktree-name>`.
Worktree names follow the pattern `worktree-YYMMDD-N` (local date, `N` starting at 1 and
incrementing per repository per day). The `.worktrees` directory is added to the repository's
*local* Git exclude file (`.git/info/exclude`), never to the tracked `.gitignore`, so this
never shows up as a change for you to commit.

A session created from a plain entry is an **ordinary session**: it runs directly in the
project's own directory. A requested worktree also falls back to an ordinary session when the
selected project is **not** a Git repository, or is a Git repository with no commits yet (no
resolvable `HEAD`). Either way the sidebar shows "Ordinary session" instead of a worktree
name.

Deleting a session with a worktree:

1. Stops its terminal/agent process and cancels any in-flight title generation.
2. Runs `git status` inside the worktree.
3. **If the worktree is dirty** (any changed, staged, or untracked files), the delete is
   **blocked** — CodeFly keeps the session and the worktree exactly as they are, and shows
   the number of changed files. Commit or discard the changes yourself (outside CodeFly),
   then delete again.
4. **If the worktree is clean**, CodeFly removes the worktree directory (without `--force`)
   and the session record.
5. **The branch is never deleted.** The same-named branch that was created for the session
   remains in the repository after the session (and its worktree) are gone, so your work is
   always recoverable from that branch.

CodeFly never force-removes a worktree and never deletes commits, stashes, or the original
project's files.

## Interactive Claude and Codex sessions

Interactive Claude sessions launch the resolved `claude` CLI with exactly one fixed
argument: **`--dangerously-skip-permissions`**. Interactive Codex sessions launch the
resolved `codex` CLI with exactly one fixed argument:
**`--dangerously-bypass-approvals-and-sandbox`**.

**These flags bypass Claude's/Codex's own permission and sandbox protections for the
lifetime of that session.** The agent can read, write, and execute commands in its worktree
without per-action confirmation. This is a deliberate design choice for a fast, low-friction
terminal workflow, and CodeFly keeps it continuously visible rather than hidden: whenever the
active session is a running Claude or Codex session, a compact "Permissions and sandbox
bypass enabled" warning badge is shown in that session's terminal header for as long as the
session is running. There is no per-session
setting to turn the bypass off in this release — if you don't want an agent running with its
protections bypassed, don't start a Claude or Codex session in CodeFly.

The background, non-interactive process CodeFly uses to generate a session's title (see
below) never receives either bypass flag, does not share the interactive session's PTY, and
runs in a neutral directory, not your project or worktree.

## Session titles

The title shown for a session starts as a placeholder (e.g. "New Claude session") and
updates once, based on the first text you submit in its terminal. Claude and Codex sessions
try an AI-generated title first (via a separate, non-interactive CLI invocation with a
15-second timeout); PowerShell and Command Prompt sessions, and any failed/timed-out AI
attempt, fall back to a local normalization of your input, and finally to plain truncation.
Title generation never delays your terminal input.

## Visual Studio Code and File Explorer

A project's options menu contains its Visual Studio Code and folder actions. Both always
open the project's **original, user-selected directory** — never a session's worktree — and
never change which session is active or expand/collapse the row. Visual Studio Code is
discovered via the `code` command on `PATH`, then the standard per-user and machine-wide
install locations; if none is found, the menu item is disabled with an install hint. The
folder action opens the directory in Windows File Explorer via `shell.openPath` and has no
such dependency.

## Settings

The title bar's gear button opens the settings dialog.

- **Launch at startup** registers (or removes) CodeFly as a Windows login item. The switch
  shows the value read back from the system *after* the write, so a change the OS refuses is
  never displayed as if it had taken effect.
- **Session kinds** holds two switches per kind — whether the kind is offered in the New
  session menu at all, and whether it also offers a **(new worktree)** entry. See
  [Session kinds and the New session menu](#session-kinds-and-the-new-session-menu).
- **Appearance** switches between the dark and light token sets.
- **Language** switches the interface between English and 简体中文. Like the theme, the
  preference is renderer-owned (`localStorage`) and never enters the persisted state file. It
  defaults to English rather than following the OS language, which keeps first launch — and
  the test suites, which assert English copy — deterministic. It covers static interface copy
  only: main-process text (tool-availability hints, session errors) and already-persisted
  session titles stay in the language they were produced in.
- **Version** shows the installed version and, on demand, queries GitHub's latest-release
  API. When the newest release ships a Windows installer, **Update now** downloads it inside
  the app and then asks whether to install it right away or later; when it does not, the
  section still just links out to the download page. See [Updates](#updates) below.
- **About CodeFly** links to the project repository, the changelog (the releases page), and
  the downloads page. The renderer can only ask for one of those three *named targets* — the
  main process resolves each to a URL from `src/shared/links.ts` before handing it to
  `shell.openExternal`, so the renderer can never make the app open an arbitrary address.

## Updates

CodeFly checks GitHub's latest-release API once in the background on startup. It stays
silent unless a newer version exists — a failed or offline check, an up-to-date install, and
a repository with no releases all produce no interruption at all. When there *is* a newer
version, a dialog offers **Update now** or **Later**.

**Update now** downloads that release's Windows installer inside the app, with a progress
bar and a **Cancel** button, into an `updates` folder under Electron's `userData` directory.
When the download finishes CodeFly asks again: **Install now** quits the app and launches the
installer (it has to quit — the installer replaces files the running app holds open), while
**Later** simply closes the dialog and leaves the downloaded installer on disk, so choosing
**Update now** again later finds it already there and skips straight to the install prompt.
The same flow is reachable on demand from **Check for updates** in Settings.

The renderer never names what gets downloaded or executed: the download, cancel, and install
IPC commands take no arguments, and the main process re-resolves the release asset itself and
refuses any download URL that is not an HTTPS GitHub release address. A release that publishes
no `.exe` asset offers only the download page, never an in-app download.

## Persistence

Projects and session metadata (not terminal scrollback, not PTY handles, not credentials)
are stored in a versioned JSON file under Electron's `userData` directory. Every session is
marked `stopped` the moment the app starts, regardless of its status when the app last
closed; click a stopped session to restart the same terminal or agent type in its original
directory. Restoring a Claude session passes `--continue` (continuing the most recent
conversation recorded for that directory) and restoring a Codex session runs
`codex resume --last`, so the prior agent conversation is reattached on a best-effort
basis; shell sessions restart fresh.

## Testing

```bash
npm test          # Vitest: unit, component, and Git-integration tests
npm run test:e2e   # Playwright: full Electron end-to-end journeys
```

The end-to-end suite (`e2e/codefly.spec.ts`) drives a real Electron window through adding a
project, creating Claude/Codex/PowerShell/Command-Prompt sessions, verifying the exact
bypass argv Claude and Codex receive (and that title-generation processes never receive
either flag), the persistent bypass warning, worktree sequence numbering, the per-kind
Session kinds switches (a kind switched off leaves the New session menu, a worktree switch
adds its second entry, and both survive a restart), restart persistence, VS Code/Explorer
options-menu actions, dirty-worktree delete protection followed by a clean delete that
retains the branch, and the whole update journey (startup prompt, **Later**, the Settings
hand-off, a real streamed download, and the installer launch).

It runs with `CODEFLY_E2E=1`, which (only in `src/main/index.ts`, the app's composition
root — no domain service branches on this) substitutes a small fixture executable
(`e2e/fixtures/fake-agent.cjs`) for the real `claude`/`codex` CLIs and a fixed directory for
the "Add Project" picker. The update test additionally supplies one published release offline
(`CODEFLY_E2E_RELEASE`) and records the installer that would have been executed
(`CODEFLY_E2E_INSTALL_LOG`) — the version comparison, asset picking, GitHub host allowlist,
streamed write, size check and rename are all real, writing into the suite's own user-data
directory. The fixture only replaces which *executable* is launched; the
bypass argument each session type receives is still produced by the same fixed, real
launch-adapter code path used in production. Every other seam — Git, PowerShell, `cmd.exe`,
the persisted state file, and the full worktree lifecycle — is the real, production
implementation. Without `CODEFLY_E2E` set (every production build and every packaged
install), none of this test-mode wiring is active.

## Packaging

```bash
npm run package:win
```

Produces an unsigned Windows x64 NSIS installer under `release/`. Packaging does not require
code-signing credentials.

### Manual smoke checklist (authenticated CLIs, packaged installer)

The automated suites above run entirely against test doubles for Claude/Codex and do not
require real, authenticated CLIs — a deliberate choice so CI and local development never
need live credentials. Before shipping a build, a human should still install the packaged
installer on a real Windows machine and verify, with real, logged-in `claude`/`codex`
CLIs:

- Claude and Codex sessions created from their **(new worktree)** entry start in their
  assigned worktree, accept input, and produce terminal output with
  `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` respectively;
  the same kinds created from their plain entry start in the project's own directory.
- If the separate title-generation process is unavailable or fails, the session still gets a
  usable local/fallback title rather than getting stuck on the placeholder.
- PowerShell and Command Prompt sessions work normally, and enabling their **New worktree**
  switch really produces a worktree session for them too.
- The Visual Studio Code and File Explorer project-options actions work against a real VS
  Code install.
- Project paths containing spaces and paths containing Chinese characters work correctly
  end to end (add project, create a worktree session, delete it).
- Toggling **Launch at startup** really adds/removes CodeFly under Windows' startup apps, and
  reopening the dialog still shows the system's actual state.
- **Check for updates** reaches GitHub over the network and reports a sensible result, both
  when a release exists and when none has been published yet.
- Against a real published release: the startup check raises the update dialog, **Update
  now** downloads the real installer with visible progress, **Cancel** stops it and leaves no
  partial file behind, and **Install now** quits CodeFly and launches the downloaded
  installer, which upgrades the existing install in place.
- Switching the language to 简体中文 translates the sidebar, launcher, terminal header, and
  dialogs, and the choice survives a restart.
