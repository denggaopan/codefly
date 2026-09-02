# macOS Runtime Support Design

## Goal

Make the existing unsigned macOS x64 and arm64 bundles usable for internal testing while preserving the current Windows experience. macOS users can run a native shell, Claude Code, and Codex sessions in project directories or Git worktrees.

## Scope

- Support Apple Silicon and Intel macOS bundles.
- Show Shell, Claude, and Codex session kinds on macOS.
- Keep PowerShell, Command Prompt, Claude, and Codex on Windows.
- Find command-line tools from a Finder-launched application even when its inherited `PATH` is incomplete.
- Preserve project, worktree, restore, title generation, auto-launch, and external-app workflows on both supported platforms.
- Keep in-app installer download and execution Windows-only. macOS update checks open the Releases download page.
- Adapt the custom title bar to macOS traffic-light controls.
- Document unsigned internal installation and real-device smoke testing.

The first macOS release does not include Developer ID signing, notarization, DMG installation, macOS in-app self-update, Linux support, configurable shell profiles, or automated publishing.

## Platform Model

Add `shell` to `SessionKind` and add the host platform (`win32` or `darwin`) to the startup snapshot. The renderer uses that trusted main-process value to choose its visible session kinds, defaults, labels, and shortcut hints.

The persisted application state remains version 1. Adding `shell` is an additive schema change, so existing Windows projects and sessions remain valid. Local session-kind preferences are still read leniently and merged over platform-specific defaults:

| Platform | Visible kinds | Default ordinary session | Agent worktree default |
| --- | --- | --- | --- |
| Windows | PowerShell, Command Prompt, Claude, Codex | PowerShell | Enabled |
| macOS | Shell, Claude, Codex | Shell | Enabled |

Unsupported kinds are hidden in the renderer and rejected in the main process. UI filtering is not the security or correctness boundary.

## Runtime Architecture

The existing composition root continues to inject services. Platform-specific behavior stays at OS boundaries rather than entering `SessionCoordinator` or `WorktreeService`.

### CLI and Shell Resolution

`CliLocator` keeps `where.exe` behavior on Windows. On macOS it resolves fixed command names through the user's login shell with a short timeout, then checks known executable locations such as `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin`. It ignores shell-startup noise and accepts only an absolute path that exists as a file.

The native Shell session uses the absolute `$SHELL` value when valid and falls back to `/bin/zsh`. It starts as a login shell so its environment resembles Terminal.app. Claude and Codex are launched directly from the absolute paths returned by `CliLocator`; their existing arguments and resume behavior do not change.

Title generation reuses the same resolved agent path. Its existing non-interactive invocation, timeout, fallback title, and prohibition on bypass flags remain unchanged.

### Sessions and Worktrees

The renderer sends the explicit `shell` kind for a macOS Shell session. `SessionCoordinator` persists it without translating it to PowerShell and continues to obtain ordinary or worktree launch locations in the existing way. Restore starts the same kind from the recorded launch path.

`TerminalService` rejects `powershell` and `cmd` on macOS and rejects `shell` on Windows. This protects restore and direct IPC calls as well as launcher interactions.

### External Applications and Paths

Folder opening continues through Electron's cross-platform `shell.openPath`. VS Code discovery and launch use the current executable strategy on Windows and macOS application/`open` semantics on macOS, passing the project directory as a separate argument.

Project identity normalization becomes platform-aware. Windows comparison remains separator-normalized and case-insensitive; macOS keeps POSIX separators and canonical path case so valid paths are not rewritten as Windows paths.

### Window and Input

Windows retains its right-side title-bar overlay. macOS uses native traffic-light controls at the left and reserves their space in the renderer title bar; theme changes do not call Windows-only overlay methods on macOS.

The ordinary-session shortcut is `Ctrl+T` on Windows and `Cmd+T` on macOS. macOS `Cmd+V` remains in the browser/xterm paste flow. Agent `Shift+Enter` continues to emit the existing Meta+Enter-compatible sequence and is verified during real-device smoke testing.

## Updates and Startup

The Electron login-item API remains the implementation for launch at login on both platforms.

`AppInfoService` reports a downloadable update asset only on Windows. On macOS, a newer GitHub release is still reported, but without an executable asset, so both background and manual checks offer the Releases download page. `UpdaterService` also rejects download/install operations outside Windows as a defense-in-depth guard. Existing Windows download, integrity checking, cancellation, installer spawn, and cleanup behavior remains unchanged.

## Failure Handling

- A missing or invalid macOS login shell falls back to `/bin/zsh` for Shell sessions.
- Agent lookup timeouts, invalid output, and missing executables produce unavailable capabilities with actionable messages; startup still succeeds.
- Unsupported platform/session combinations fail before starting a PTY.
- External application failures surface through the existing notice/error path.
- macOS cannot download or execute a Windows installer even if a renderer or IPC caller requests it directly.
- Existing state recovery and local title fallback behavior is unchanged.

## Testing

Automated tests cover:

- `shell` and platform contract parsing, platform-specific session lists, defaults, and old local preference merging.
- macOS login-shell resolution, common install locations, startup noise, timeouts, invalid paths, and paths containing spaces.
- macOS Shell/agent start and restore specs, unsupported-kind rejection, and direct title-generation launch.
- Platform-aware project identity, VS Code/folder opening, login items, and window options/theme updates.
- macOS update-page fallback and updater guards alongside the full Windows updater regression suite.
- Renderer launcher, settings, icons, labels, shortcut hints, and update UI on both platforms.
- Type checking, the complete Vitest suite, production build, and structural inspection of both macOS archives including darwin `node-pty` prebuilds.

The README smoke checklist requires real runs on Apple Silicon and Intel macOS: clear quarantine, apply an ad-hoc signature where needed, launch from Finder, add paths with spaces and non-ASCII characters, create/restore/delete ordinary and worktree sessions, exercise logged-in Claude/Codex, open folders and VS Code, toggle launch at login, verify update-page fallback, and check `Cmd+V`/`Shift+Enter` behavior.
