# CodeFly

CodeFly is a Windows and macOS desktop application for running local shell, Claude Code,
and Codex sessions against local projects. Windows provides PowerShell and Command Prompt;
macOS provides the user's login Shell. It is a focused terminal workspace, not an embedded
code editor: a session can run in the project directory or in its own isolated Git worktree
and same-named branch, and Claude/Codex run through their locally installed,
already-authenticated CLIs. CodeFly never collects, stores, or reads API keys or CLI
credentials.

Built with Electron, React, TypeScript, xterm.js, and node-pty.

## Prerequisites

- Windows 10/11 x64, or an Intel/Apple Silicon Mac using the matching internal-test bundle.
- [Node.js](https://nodejs.org/) 22.12.0 or later, with npm.
- [Git](https://git-scm.com/downloads) on `PATH` (Windows) or available to the macOS login
  shell. Required for isolated
  worktree sessions (see [Git and worktree sessions](#git-and-worktree-sessions) below);
  CodeFly still runs without it, but every session then falls back to an ordinary,
  non-isolated session in the project's own directory. Sessions created from a plain launcher
  entry run there by design and need no Git.
- Optional, to actually use the Claude/Codex launcher entries: the
  [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or the
  [Codex CLI](https://github.com/openai/codex) (`codex`) installed and signed in. CodeFly
  detects them on `PATH` on Windows and through the login shell on macOS; a missing or
  unauthenticated CLI leaves its launcher entry visible but disabled, with an installation
  hint. Finder-launched macOS apps do not inherit Terminal's `PATH`, so ensure
  `command -v claude` / `command -v codex` succeeds from a login shell.
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
| `npm run package:mac`    | Build the app, then produce unsigned macOS x64 and arm64 app bundles (`.zip`) under `release/` by running `electron-builder` in a Linux container (needs Docker). |

## Session kinds and the New session menu

Each session kind shown for the host platform has two switches under **Session kinds** in
Settings. Windows shows PowerShell, Command Prompt, Claude, and Codex; macOS shows Shell,
Claude, and Codex.

- **Enabled** decides whether the kind appears in the New session menu at all. Turning it off
  removes its entries; existing sessions of that kind are untouched. This is different from a
  missing CLI, which leaves the entry listed but disabled with a lookup hint.
- **New worktree** adds a *second* entry for that kind — e.g. both **Claude** and
  **Claude (new worktree)**. The plain entry runs the session in the project's own directory;
  the worktree entry gives it an isolated Git worktree and branch.

Defaults: every platform-visible kind is enabled, **New worktree** is off for native shells
(a quick terminal should not create a branch) and on for Claude and Codex (isolation is what
the agents want). Both switches are renderer-owned preferences stored in `localStorage`,
like the theme and language; the worktree choice itself is sent explicitly with each create
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

### Keyboard: paste and multi-line input

In Claude and Codex sessions **Ctrl+V** on Windows or **Cmd+V** on macOS pastes clipboard text
into the CLI prompt, and **Shift+Enter** inserts a newline while **Enter** sends the message.
CodeFly hands the platform paste shortcut back to the browser so xterm's paste path (including
bracketed paste) feeds the PTY. It sends Shift+Enter as `ESC CR`, the Meta/Alt+Enter-compatible
sequence both CLIs accept. Native Shell, PowerShell, and Command Prompt sessions keep xterm's
normal key handling.

## Session titles

The title shown for a session starts as a placeholder (e.g. "New Claude session") and
updates once, based on the first text you submit in its terminal. Claude and Codex sessions
try an AI-generated title first (via a separate, non-interactive CLI invocation with a
15-second timeout); Shell, PowerShell and Command Prompt sessions, and any failed/timed-out
AI attempt, fall back to a local normalization of your input, and finally to plain truncation.
Title generation never delays your terminal input.

## Visual Studio Code and project folders

A project's options menu contains its Visual Studio Code and folder actions. Both always
open the project's **original, user-selected directory** — never a session's worktree — and
never change which session is active or expand/collapse the row. Visual Studio Code is
discovered via the `code` command and standard install locations on Windows, or the standard
Visual Studio Code application locations on macOS; if none is found, the menu item is disabled
with an install hint. The folder action opens the directory in the platform file manager via
Electron's `shell.openPath` and has no such dependency.

## Git repository and removing a project

When the project directory is inside a Git repository that has a remote with a web address,
the options menu also offers **Open Git repository**. CodeFly reads the `origin` remote (or
the first remote when there is no `origin`), turns ssh/scp-style URLs such as
`git@github.com:owner/repo.git` into their https page, and opens it in your default browser.
The entry's icon follows the host: the GitHub mark for hosts containing `github`, the GitLab
mark for hosts containing `gitlab` (self-hosted instances included), and a plain Git mark
otherwise. Repositories without a remote, or whose remote is a local directory, get no entry.
Remotes are re-read every time the app starts, so adding or changing a remote is picked up on
the next launch. Only the project id ever crosses from the UI to the main process — the URL
that reaches the browser is always the one CodeFly derived itself, and it must be http(s).

**Remove from list** forgets a project after a confirmation. Any running sessions of that
project are stopped and all of its session records are removed together with it; nothing on
disk is touched — the project directory, its worktrees and their branches stay exactly as
they are. Re-adding the directory later starts with an empty session list.

## Settings

The title bar's gear button opens the settings dialog.

- **Launch at startup** registers (or removes) CodeFly as a platform login item. The switch
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
  API. Windows can download and launch a published `.exe` in-app; macOS links to the Releases
  page for the matching architecture. See [Updates](#updates) below.
- **About CodeFly** links to the project repository, the changelog (the releases page), and
  the downloads page. The renderer can only ask for one of those three *named targets* — the
  main process resolves each to a URL from `src/shared/links.ts` before handing it to
  `shell.openExternal`, so the renderer can never make the app open an arbitrary address.

## Updates

CodeFly checks GitHub's latest-release API once in the background on startup. It stays
silent unless a newer version exists — a failed or offline check, an up-to-date install, and
a repository with no releases all produce no interruption at all. When there *is* a newer
version, a dialog appears. Windows offers **Update now** when the release includes a Windows
installer. macOS offers the Releases page so the user can download the matching x64 or arm64
archive manually.

On Windows, **Update now** downloads that release's installer inside the app, with a progress
bar and a **Cancel** button, into an `updates` folder under Electron's `userData` directory.
While bytes are moving, **Cancel** is the only way out — clicking the backdrop or pressing
Escape does nothing, so a stray click cannot throw away a download that is nearly finished.
Both the release check and the download go through Chromium's network stack (Electron's
`net.fetch`), so they honour the system proxy exactly as a browser does — on a machine that
reaches GitHub through a proxy, the installer arrives in CodeFly as fast as it does in Chrome.

When the download finishes CodeFly asks again: **Install now** quits the app and launches the
installer (it has to quit — the installer replaces files the running app holds open), while
**Later** simply closes the dialog and leaves the downloaded installer on disk, so choosing
**Update now** again later finds it already there and skips straight to the install prompt.
Only that one installer is kept: every superseded installer and every `.part` file orphaned
by a crash mid-download is swept away as soon as a new download lands. The same flow is
reachable on demand from **Check for updates** in Settings.

CodeFly only quits once the operating system confirms the installer process actually started.
A blocked, quarantined, or missing installer leaves the app open with an explanation rather
than closing it and leaving nothing behind.

The renderer never names what gets downloaded or executed: the download, cancel, and install
IPC commands take no arguments, and the main process re-resolves the release asset itself and
refuses any download URL that is not an HTTPS GitHub release address. A non-Windows host, or
a release without a `.exe` asset, offers only the download page and never an in-app download.

## Persistence

Projects and session metadata (not terminal scrollback, not PTY handles, not credentials)
are stored in a versioned JSON file under Electron's `userData` directory. Every session is
marked `stopped` the moment the app starts, regardless of its status when the app last
closed; click a stopped session to restart the same terminal or agent type in its original
directory. Restoring a Claude session passes `--continue` (continuing the most recent
conversation recorded for that directory) and restoring a Codex session runs
`codex resume --last`, so the prior agent conversation is reattached on a best-effort
basis; shell sessions restart fresh.

The sidebar width is a renderer-owned preference (`localStorage`, like the theme and language)
and never enters the state file. Drag the seam between the sidebar and the terminal to resize
it; the handle is also keyboard-operable (focus it, then ArrowLeft/ArrowRight nudge, Home/End
jump to the bounds) and a double-click restores the default 300px. The width is clamped between
200px and 640px and can never leave the terminal workspace less than 360px, even when the window
is later made narrower.

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

### Windows

```bash
npm run package:win
```

Produces an unsigned Windows x64 NSIS installer under `release/`. Packaging does not require
code-signing credentials.

### macOS (from Windows or Linux, via Docker)

```bash
npm run package:mac
```

Produces `release/CodeFly-<version>-mac-x64.zip` and `release/CodeFly-<version>-mac-arm64.zip`,
each holding an unsigned `CodeFly.app`. electron-builder refuses to build macOS targets on a
Windows host, so `scripts/package-mac.mjs` builds `out/` on the host and then runs
electron-builder inside a small Linux container (`scripts/mac-builder.Dockerfile`:
`node:24-bookworm-slim` plus Info-ZIP) with the repository bind-mounted.

- Docker Desktop (or any Docker daemon) must be running. The image is built on first use and
  cached. Electron's darwin builds and electron-builder's icon toolset are downloaded once into
  `%LOCALAPPDATA%\codefly-mac-builder\cache` (`~/.cache/codefly-mac-builder` elsewhere).
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from the host shell are forwarded into the
  container; a loopback proxy address is rewritten to `host.docker.internal`.
- The host's `node_modules` is reused as is: node-pty ships darwin prebuilds, so nothing is
  compiled. `mac.files` in `electron-builder.yml` drops node-pty's Windows binaries from the
  bundle.
- The container asks electron-builder for `dir` only and compresses the bundle itself with
  `zip -y`, because the 7-Zip electron-builder uses for zip off macOS dereferences the symlinks
  inside `Electron Framework.framework`. `dmg` needs `hdiutil`, so it is only produced by
  `npx electron-builder --mac` on a Mac — that is what `mac.target` in `electron-builder.yml`
  describes.
- `electron-builder.mac-cross.yml` is the overlay the container uses: it clears `electronDist`
  so the darwin Electron is downloaded instead of the host's Windows copy being reused.

The bundles are for internal testing and are neither signed nor notarized. Download the
archive that matches the Mac (`mac-arm64.zip` for Apple Silicon, `mac-x64.zip` for Intel),
extract it, and prepare the app before the first launch:

```bash
xattr -cr CodeFly.app
codesign --force --deep --sign - CodeFly.app
```

The ad-hoc signature is local to that copy and is not a substitute for Developer ID signing
or notarization. Move `CodeFly.app` to `/Applications` if desired, then open it from Finder.
If Gatekeeper still intervenes, use **Open Anyway** under System Settings > Privacy &
Security. Do not redistribute this internal build as a normal public macOS release.

At runtime, macOS shows Shell, Claude, and Codex. CLI lookup runs through the user's login
shell and then checks common Homebrew/local install locations, so Finder launch works without
inheriting Terminal's `PATH`. PowerShell and Command Prompt remain Windows-only.

### Manual smoke checklist (authenticated CLIs, packaged builds)

The automated suites use test doubles for Claude/Codex and do not require live credentials.
Before handing off a build, test with real, logged-in `claude` and `codex` CLIs.

#### Windows x64

- Create ordinary and worktree PowerShell, Command Prompt, Claude, and Codex sessions; verify
  their working directories, input/output, restore, and deletion behavior.
- Verify Visual Studio Code and project-folder actions, project paths containing spaces and
  non-ASCII characters, and the Launch at startup toggle.
- Verify **Ctrl+V**, agent **Shift+Enter**, and the Windows in-app download/cancel/install
  update flow. Windows has no new-session accelerator: confirm `Ctrl+T` reaches the focused
  terminal instead of creating a PowerShell session.
- Check the pixel logo in the Claude and Codex startup banners for hairline seams. The
  terminal uses the WebGL renderer to keep Block Elements solid, and a machine whose GPU
  cannot provide a WebGL2 context falls back to the DOM renderer *silently* — cracks through
  the artwork are the visible symptom of that fallback.

#### macOS x64 and arm64 (two separate required runs)

Run the entire list once on a real Intel Mac with `mac-x64.zip` and once on a real Apple
Silicon Mac with `mac-arm64.zip`; a Rosetta-only run does not cover both architectures.

- Extract the archive, clear quarantine, apply the ad-hoc signature, move the app to
  `/Applications`, and launch it from Finder rather than Terminal.
- Add projects whose paths contain spaces and non-ASCII characters. Verify paths remain
  correctly cased and are not rewritten with Windows separators.
- Create Shell, Claude, and Codex from both their ordinary and **(new worktree)** entries.
  Verify the ordinary sessions use the project directory and worktree sessions use their
  assigned worktree and branch.
- Enter commands/prompts, close and reopen CodeFly, restore each stopped session, then delete
  both ordinary and clean worktree sessions. Confirm dirty-worktree protection still applies.
- Verify a failed title-generation process still produces a usable local fallback title.
- Check the pixel logo in the Claude and Codex startup banners for hairline seams (see the
  Windows list above: seams mean the WebGL renderer silently fell back to the DOM one).
- Verify **Open in Visual Studio Code**, **Open project folder** (Finder), and **Open Git
  repository** without changing the active session.
- Toggle **Launch at startup**, reopen Settings to confirm the system value, log out/in if the
  test machine permits, then turn the setting back off.
- Check for an available update and confirm macOS offers the Releases page only: it must not
  download or execute a Windows installer.
- Verify **Cmd+V** pastes into Claude and Codex, **Shift+Enter** inserts a newline without
  submitting, and `Cmd+T` creates an ordinary Shell session.
- Switch between English and Simplified Chinese and confirm the choice survives a restart.
