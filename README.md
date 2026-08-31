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
  non-isolated session in the project's own directory.
- Optional, to actually use the Claude/Codex launcher entries: the
  [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or the
  [Codex CLI](https://github.com/openai/codex) (`codex`) installed and signed in. CodeFly
  detects them on `PATH` at startup; a missing or unauthenticated CLI leaves its launcher
  entry visible but disabled, with an installation hint.
- Optional: [Visual Studio Code](https://code.visualstudio.com/) (or its `code` command on
  `PATH`) to use the project row's "Open in VS Code" action.

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

## Git and worktree sessions

When you create a session in a project that is a Git repository with at least one commit,
CodeFly creates an isolated Git worktree and a same-named branch for that session, under
`<repository-root>/.worktrees/<worktree-name>`. Worktree names follow the pattern
`worktree-YYMMDD-N` (local date, `N` starting at 1 and incrementing per repository per day).
The `.worktrees` directory is added to the repository's *local* Git exclude file
(`.git/info/exclude`), never to the tracked `.gitignore`, so this never shows up as a change
for you to commit.

If the selected project is **not** a Git repository, or is a Git repository with no commits
yet (no resolvable `HEAD`), CodeFly falls back to an **ordinary session**: the session runs
directly in the project's own directory instead of an isolated worktree. This is shown as
"Ordinary session" in the sidebar instead of a worktree name.

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

A project row's Visual Studio Code and folder icons always open the project's **original,
user-selected directory** — never a session's worktree — and never change which session is
active or expand/collapse the row. Visual Studio Code is discovered via the `code` command
on `PATH`, then the standard per-user and machine-wide install locations; if none is found,
the action is disabled with an install hint. The folder action opens the directory in Windows
File Explorer via `shell.openPath` and has no such dependency.

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
either flag), the persistent bypass warning, worktree sequence numbering, restart
persistence, VS Code/Explorer row actions, and dirty-worktree delete protection followed by
a clean delete that retains the branch.

It runs with `CODEFLY_E2E=1`, which (only in `src/main/index.ts`, the app's composition
root — no domain service branches on this) substitutes a small fixture executable
(`e2e/fixtures/fake-agent.cjs`) for the real `claude`/`codex` CLIs and a fixed directory for
the "Add Project" picker. The fixture only replaces which *executable* is launched; the
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

- Claude and Codex sessions start in their assigned worktree, accept input, and produce
  terminal output with `--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox` respectively.
- If the separate title-generation process is unavailable or fails, the session still gets a
  usable local/fallback title rather than getting stuck on the placeholder.
- PowerShell and Command Prompt sessions work normally.
- The Visual Studio Code and File Explorer project-row actions work against a real VS Code
  install.
- Project paths containing spaces and paths containing Chinese characters work correctly
  end to end (add project, create a worktree session, delete it).
