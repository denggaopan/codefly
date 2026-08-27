# CodeFly AI Programming Desktop Design

Date: 2026-08-26
Status: Approved

## Overview

CodeFly is a Windows-first desktop application for running local PowerShell, Command Prompt, Claude Code, and Codex sessions against local projects. It provides a focused terminal workspace rather than an embedded code editor. Each session in a Git repository receives an isolated Git worktree, while non-Git repositories and repositories without an initial commit fall back to ordinary project-directory sessions.

The first release uses Electron, React, TypeScript, xterm.js, and node-pty. Claude and Codex run through their locally installed CLIs and existing CLI authentication. CodeFly does not collect or store API keys.

## Goals

- Add and switch among local projects.
- Open a registered project's original directory in Visual Studio Code from its project row.
- Open a registered project's original directory in Windows File Explorer from its project row.
- Create PowerShell, Command Prompt, Claude, and Codex sessions.
- Start interactive Claude and Codex sessions with their requested permission- and sandbox-bypass flags while keeping that state visibly disclosed.
- Give each eligible session an isolated worktree and same-named branch.
- Restore stopped sessions in their original directory with one click.
- Derive a concise title from the first submitted text.
- Safely remove a session and its worktree without losing uncommitted changes.
- Persist projects and session metadata across application restarts.
- Match the supplied reference's dark, terminal-focused visual language.

## Non-Goals

- An embedded file explorer or source-code editor.
- Git worktree creation and branch management outside session lifecycle needs.
- Direct OpenAI or Anthropic API integration.
- Cross-platform support in the first release.
- Launching external editors other than Visual Studio Code.
- Guaranteed restoration of Claude or Codex conversation context.
- Persistent terminal scrollback after the application exits.
- A per-session setting to disable the requested Claude/Codex bypass flags in the first release.
- Automatic commits, stashes, deletion of branches belonging to completed session creation, or forced worktree deletion.

## User Experience

### Window Layout

The application uses a dark two-column layout:

- The title bar contains the CodeFly identity. (Revised 2026-08-27: open-session tabs and the global plus button were removed; sessions are switched via the sidebar's session rows.)
- The left sidebar contains Add Project, search, project groups, and their sessions.
- The main area contains one xterm.js terminal for the active session.
- Each project row's plus button opens a launcher for PowerShell, Command Prompt, Claude, and Codex in that project. (Revised 2026-08-27: moved from the title bar onto the project rows.)
- A compact warning badge in the active session's terminal header discloses when a Claude or Codex session is running with permission and sandbox bypass enabled. (Revised 2026-08-27: the original persistent bottom status strip was removed as too intrusive.)

The default window size is 1180 by 760 pixels, with a minimum size of 900 by 600 pixels. The sidebar remains fixed-width while the terminal fills the remaining space. Long titles and paths use ellipsis and expose their full value in a tooltip.

### Project and Session Rows

A project row shows the selected directory name and path. Its right-side actions contain a bundled blue Visual Studio Code SVG icon, a folder SVG icon, and the expand/collapse control in that order. Clicking the Visual Studio Code icon opens the project's original user-selected directory in VS Code. Clicking the folder icon opens the same original directory in Windows File Explorer. Neither action targets an active session worktree, toggles the project row, or changes the active session. The icons have accessible `Open project in VS Code` and `Open project folder` labels.

Its child session rows show:

- The terminal or agent icon.
- The concise session title.
- The worktree name as a secondary technical label, or `Ordinary session` for a fallback session.
- A `Running`, `Click to restore`, or error status.
- A delete icon at the far right.

Clicking a running session switches to it. Clicking a stopped session immediately restarts the same terminal or agent type in its saved directory and makes it active. Clicking the delete icon stops event propagation so it never restores the session accidentally.

Before the first input produces a title, the row uses a temporary label such as `New Claude session`. Title generation updates the row and tab without interrupting terminal input. Manual title editing is outside the first-release scope.

### Session Launcher

The launcher lists:

1. New terminal: PowerShell
2. New terminal: Command Prompt
3. Claude
4. Codex

Unavailable CLIs remain visible but disabled with an installation hint. PowerShell and Command Prompt use Windows system executables and do not require separate installation checks.

## Architecture

### Electron Main Process

The main process owns all privileged operations:

- Project directory selection and validation.
- Git repository discovery and worktree lifecycle commands.
- CLI executable discovery.
- node-pty process creation, input, resizing, output, and termination.
- Background title-generation processes.
- Persistent state reads, validation, migration, and atomic writes.

The main process is divided into focused services:

- `ProjectService`: project registration, removal, lookup, and repository-root discovery.
- `ExternalAppService`: Visual Studio Code discovery plus safe VS Code and File Explorer project opening.
- `WorktreeService`: sequence allocation, worktree creation, status checks, and removal.
- `TerminalService`: PTY lifecycle and terminal event routing.
- `TitleService`: first-input tracking result handling, AI title adapters, and fallback rules.
- `SessionStore`: versioned, atomic persistence of projects and session metadata.

### Preload Bridge

The preload script exposes a typed, narrow API through `contextBridge`. It supports project selection, opening a registered project in Visual Studio Code or Windows File Explorer, project/session queries, session lifecycle commands, terminal input and resize events, and subscriptions to terminal/state updates.

`nodeIntegration` is disabled and `contextIsolation` is enabled. The renderer cannot access Node.js, spawn processes, or construct arbitrary shell commands. Every IPC request is schema-validated in the main process.

### Renderer

The React renderer owns visual state and interaction only:

- Project/sidebar navigation.
- Session tabs and launcher.
- xterm.js terminal instances and resize observation.
- Inline status, confirmation, and error surfaces.
- First-input observation before terminal data is forwarded over IPC.

The renderer keeps a normalized in-memory view of persisted metadata. Main-process events are authoritative for PTY and lifecycle state.

## Persistent Data Model

State is stored in a versioned JSON document under Electron's `userData` directory. Writes go to a sibling temporary file, are flushed, and then atomically replace the active state file. The previous valid file is retained as a recoverable backup when migration or parsing fails.

Each project contains:

- Stable generated ID.
- User-selected path.
- Resolved Git repository root when one exists.
- Display name and timestamps.

Each session contains:

- Stable generated ID and parent project ID.
- Kind: `powershell`, `cmd`, `claude`, or `codex`.
- Display title and title-generation state.
- Creation timestamp.
- Mode: `worktree` or `ordinary`.
- Worktree name, absolute path, and branch name when mode is `worktree`.
- Launch directory for both worktree and ordinary sessions.
- Runtime status persisted as `stopped` during application startup.

PTY handles, process IDs, terminal scrollback, and credentials are never persisted.

## Worktree Lifecycle

### Eligibility

When creating a session, CodeFly resolves the selected directory's repository root with Git. Worktree mode requires both a valid work tree and a resolvable `HEAD` commit. A non-Git project or repository without an initial commit uses ordinary mode and launches directly in the selected project directory.

If the selected path is below the repository root, the worktree is created under the root and the launch directory preserves the selected path's relative subdirectory inside the new worktree.

### Naming and Sequence Allocation

Names use the local calendar date and the form `worktree-YYMMDD-N`, where `N` starts at 1. The worktree directory and newly created branch use the same name.

Allocation is serialized per repository. The service finds the first available sequence after comparing:

- Persisted sessions for the repository.
- Existing `.worktrees` child directory names.
- Existing local branch names.
- Registered paths reported by `git worktree list --porcelain`.

This check prevents reuse after state loss or external Git operations. If a collision still occurs during creation, the service re-runs allocation once with the next available sequence.

### Creation

The target path is `<repository-root>/.worktrees/<worktree-name>`. Before first use, CodeFly adds `/.worktrees/` to the repository's local exclude file resolved by `git rev-parse --git-path info/exclude`. This avoids modifying the user's tracked `.gitignore`.

The service runs Git directly with an argument array equivalent to:

```text
git worktree add -b <worktree-name> <absolute-target-path> HEAD
```

The current working tree's uncommitted changes are intentionally excluded; the worktree starts from the current branch's `HEAD` commit. A session record is persisted only after successful worktree creation. If a later initialization step fails, CodeFly removes only the worktree and newly allocated branch it created during that attempt.

### Restore

All sessions are marked stopped when the application starts. Clicking a stopped worktree session validates that its directory remains registered with Git, then starts the saved terminal or agent type there. Clicking a stopped ordinary session starts it in the original project directory.

Restore starts a new CLI process. It does not pass Claude or Codex resume flags and does not promise to restore the previous agent conversation.

### Delete

Deleting a session follows this order:

1. Ask for confirmation.
2. Stop its PTY and cancel an in-flight title process.
3. For worktree sessions, run `git status --porcelain` inside the worktree.
4. If output is non-empty or status cannot be determined safely, stop and preserve the session and worktree.
5. If clean, remove the worktree without `--force`.
6. Remove the session record after Git confirms success.

The same-named branch remains after deletion. Ordinary sessions only stop their PTY and remove metadata; CodeFly never deletes files from the original project directory.

## Terminal and Agent Lifecycle

PowerShell sessions launch the installed Windows PowerShell executable selected by the application. Command Prompt sessions launch `cmd.exe`. Interactive Claude sessions launch the resolved local CLI with `--dangerously-skip-permissions`. Interactive Codex sessions launch the resolved local CLI with `--dangerously-bypass-approvals-and-sandbox`. Both use the session directory as their working directory.

The bypass arguments are fixed launch-adapter values and cannot be supplied or changed by the renderer. Claude and Codex terminal headers display `Permissions and sandbox bypass enabled` as a compact warning-tone badge for the entire lifetime of the interactive session (revised 2026-08-27 from the original two-surface destructive treatment). The first release intentionally has no per-session safe-mode toggle.

The application resolves executable locations without concatenating user input into shell command strings. Launch adapters own the executable, fixed arguments, environment inheritance, and display label for each session type.

PTY output streams from the main process to only the owning renderer terminal. Renderer input and resize events include a session ID and are accepted only for a live session owned by the current application window. A process exit keeps the session record, updates status to stopped, and preserves the visible scrollback until the app window closes or the session restarts.

Application shutdown terminates child PTYs and title processes. On the next launch, sessions appear stopped and restore on click.

## Visual Studio Code Integration

The project-row Visual Studio Code action always targets the original registered project path. It does not depend on the active session and does not open a worktree.

`ExternalAppService` discovers Visual Studio Code in this order:

1. A `code` command resolvable from the inherited process environment.
2. The current user's standard Visual Studio Code installation path.
3. The machine-wide standard Visual Studio Code installation path.

The service launches the resolved executable directly with the registered project path as a single argument. It never concatenates the path into a shell command. The action is disabled while no executable is available, and its tooltip explains that Visual Studio Code or the `code` command must be installed. A launch failure produces a project-scoped error without affecting sessions.

## Windows File Explorer Integration

The project-row folder action always targets the original registered project path. The main process resolves the path from the persisted project ID and opens it with Electron's `shell.openPath`, which delegates directory opening to Windows File Explorer. The renderer never supplies a path.

The folder action remains available independently of Visual Studio Code detection. If the directory no longer exists or Windows cannot open it, CodeFly keeps application state unchanged and displays a project-scoped error.

## First-Input Title Generation

Before forwarding terminal input, the renderer observes the first submitted textual line. It tracks printable characters, pasted text, backspace, and the first Enter key, while filtering control sequences. Input forwarding is never delayed. If no usable text can be reconstructed, the temporary title remains until a later non-empty submitted line is observed.

Once captured, only one title attempt is allowed per session:

1. Claude sessions use a separate non-interactive Claude CLI adapter.
2. Codex sessions use a separate non-interactive Codex CLI adapter.
3. PowerShell and Command Prompt sessions skip AI generation and begin with the local rule.

The background adapter runs in a neutral directory under Electron's `userData`, not in the project or worktree. It receives a fixed title instruction and the delimited first input through standard input, has a 15-second timeout, and accepts at most 4 KiB of output. It does not share the interactive PTY or modify its conversation. Title adapters never receive `--dangerously-skip-permissions` or `--dangerously-bypass-approvals-and-sandbox`.

The requested fallback order is:

1. AI-generated title for Claude and Codex.
2. Local normalization: choose the first non-empty sentence, remove common command/prompt prefixes and redundant punctuation, and collapse whitespace.
3. Direct truncation of the original input.

Every result is converted to one line, stripped of terminal control characters and wrapping quotes, and limited to 24 Unicode code points. An empty result advances to the next fallback. The title update is persisted and announced to the renderer.

## Error Handling

- Missing Claude or Codex: disable that launcher entry and show the executable lookup result plus an installation hint.
- Missing Visual Studio Code: disable the project-row action and show a tooltip explaining how to install VS Code or enable its `code` command.
- Visual Studio Code launch failure: keep the application state unchanged and show a project-scoped error with the resolved executable path.
- File Explorer launch failure: keep the application state unchanged and show a project-scoped error identifying the unavailable registered directory.
- Worktree creation failure: show copyable Git stderr, remove artifacts created by that attempt, and do not create a session record.
- Lost worktree path: mark the session `Path missing`; allow metadata removal without recreating or overwriting files.
- PTY failure or unexpected exit: preserve the session, show the exit state, and allow click-to-restart.
- Dirty worktree deletion: keep the session and worktree, list a concise changed-file count, and ask the user to commit or discard changes outside the delete flow.
- Git status uncertainty: fail closed and preserve the worktree.
- Title failure or timeout: silently advance through the configured fallback chain and never fail the session.
- Corrupt state file: preserve it as a backup, load the last valid backup if available, otherwise start with an empty state and show a recoverable warning.

Errors are scoped to the affected project or session. Modal dialogs are reserved for destructive confirmation; routine errors use inline notices or toasts.

## Security and Safety

- Renderer process isolation remains enabled.
- IPC payloads use explicit schemas and reject unknown fields.
- Git and executable invocation uses argument arrays rather than user-built shell strings.
- The VS Code and folder actions accept only a persisted project ID and resolve its path in the main process; renderer-provided paths are rejected.
- Project, worktree, and repository paths are resolved and validated before mutation.
- Worktree removal never uses `--force` in the first release.
- Branches belonging to completed session creation, commits, stashes, and original project files are never deleted automatically. A failed creation attempt may remove only the unused branch allocated by that same attempt.
- API keys and CLI credentials are not read, copied, or persisted by CodeFly.
- Terminal output is treated as untrusted text and is not rendered as HTML.
- The user-requested bypass flags apply only to interactive Claude and Codex PTYs; the UI continuously discloses that those agent protections are disabled.

## Testing Strategy

### Unit Tests

- Date-based worktree names, sequence discovery, and collision retry.
- Title capture, Unicode-safe length limits, sanitization, and all fallback transitions.
- Session state transitions for create, run, stop, restore, failure, and delete.
- Persistence parsing, migration, atomic replacement, and backup recovery.
- IPC schema validation and rejection of arbitrary executable arguments.
- Visual Studio Code executable discovery order and registered-project path validation.
- Windows File Explorer opening for existing, missing, space-containing, and non-ASCII project paths.

### Git Integration Tests

Tests create temporary repositories and execute the installed Git binary to verify:

- Worktree and same-named branch creation from `HEAD`.
- Sequential names across sessions and pre-existing branches/directories.
- Local exclusion of `.worktrees` without changing tracked `.gitignore`.
- Nested selected-directory launch-path mapping.
- Non-Git and no-commit fallback to ordinary mode.
- Dirty worktrees block deletion.
- Clean deletion removes the worktree and retains the branch.
- Missing external worktrees are reported without destructive recovery.

### Electron End-to-End Tests

- Add and switch projects.
- Open the original registered project in Visual Studio Code and verify the row action does not expand, collapse, or switch sessions.
- Open the original registered project in Windows File Explorer and verify the row action does not expand, collapse, or switch sessions.
- Open the launcher and create each session type through test launch adapters.
- Render PTY output, send input, and resize terminals.
- Verify Claude receives only `--dangerously-skip-permissions`, Codex receives only `--dangerously-bypass-approvals-and-sandbox`, and title processes receive neither flag.
- Keep the bypass warning visible for active Claude/Codex sessions and absent for PowerShell/CMD sessions.
- Generate and update the first-input title.
- Switch running sessions and restore stopped sessions by clicking their rows.
- Verify the delete icon does not trigger restore.
- Confirm deletion, dirty-worktree blocking, and persistence across relaunch.
- Exercise the minimum supported window size.

### Windows Packaging Smoke Tests

- Install and launch the packaged application.
- Start real PowerShell and Command Prompt PTYs.
- Detect present and absent Claude/Codex installations.
- Detect present and absent Visual Studio Code installations and open a project path containing spaces.
- Open existing project directories in Windows File Explorer and report missing paths safely.
- Verify paths containing spaces and non-ASCII characters.

Automated tests do not require real Claude/Codex authentication. Title adapters and agent PTYs use controllable test executables in CI; authenticated manual smoke tests cover the real CLIs.

## Acceptance Criteria

- A user can add a local project and create any of the four session types.
- A user can click the Visual Studio Code icon on a project row to open that project's original directory without changing the active session.
- A user can click the folder icon on a project row to open that project's original directory in Windows File Explorer without changing the active session.
- An eligible Git session creates `.worktrees/worktree-YYMMDD-N` and a same-named branch from the current `HEAD`.
- Non-Git and no-commit projects create ordinary sessions without mutating Git history.
- The first submitted text updates the title without delaying terminal input and follows the agreed AI/local/truncation fallback order.
- Closing and reopening CodeFly preserves projects and sessions as stopped records.
- Clicking a stopped session restarts its saved type in its saved directory.
- The delete icon never triggers restore.
- A dirty worktree cannot be deleted through CodeFly.
- A clean session deletion removes its worktree and record while retaining its branch.
- The packaged Windows application runs PowerShell and Command Prompt and clearly reports whether Claude and Codex are available.
- Interactive Claude and Codex sessions use the requested bypass flags, visibly disclose that state, and never pass those flags to title-generation processes.
