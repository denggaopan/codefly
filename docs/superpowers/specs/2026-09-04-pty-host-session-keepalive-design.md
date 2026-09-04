# CodeFly Resident pty-host: Sessions That Survive a Version Upgrade

Date: 2026-09-04
Status: Implemented

## Overview

CodeFly runs every session's PTY inside the Electron main process. That makes the lifetime of
an agent CLI exactly the lifetime of the window: closing CodeFly, a renderer crash, and above
all **installing an update** all kill every running Claude, Codex, or shell session. A user who
updates mid-task loses whatever those agents were doing.

This design moves node-pty into a **resident pty-host process** that outlives the UI — the
tmux model. The UI becomes a client that attaches to the host, and the host keeps the PTYs and
their child processes running across window closes, UI crashes, and in-place upgrades.

The requirement driving this is specifically "a version upgrade must not interrupt sessions",
and the option of "kill them, then auto-resume with each agent's own resume flag" was
considered and **rejected** by the product decision: `--continue` / `resume --last` restores a
conversation, not a half-finished task, and the agent process itself dies either way.

## Goals

- Closing the CodeFly window leaves every running session alive; reopening reattaches to it,
  with the terminal repainted from retained output.
- A Windows in-place upgrade (the NSIS installer CodeFly downloads and runs itself) leaves the
  PTYs and agent CLIs untouched. The newly installed UI attaches to the host that the *previous*
  build started.
- A UI crash or forced kill does not take sessions with it.
- Every session that was running when the UI last exited is running again after the next
  launch — either because the host still holds it, or, when the host is gone too (machine
  reboot, host crash), by restoring it with the agent's own resume flag.
- A session the user explicitly stopped stays stopped. It is never resurrected.
- No orphans: a PTY the UI has no record of gets killed, not left running with vendor bypass
  flags enabled and no window showing it.

## Non-Goals

- Surviving a **machine reboot**. Nothing keeps a process across a power cycle; those sessions
  fall back to resume-on-launch.
- Running the host as a Windows service or launchd agent. It is started on demand by the UI and
  exits when it has nothing to hold.
- Streaming full scrollback history into the cloud, or persisting scrollback to disk. The
  replay buffer is in host memory only (see Replay).
- Changing what a session *is*: same kinds, same worktree rules, same bypass flags, same argv.

## Architecture

Three processes become four:

```
Electron main  ──IPC(existing)──  preload / renderer
      │
      │  NDJSON over named pipe (Windows) / unix socket (macOS)
      ▼
  pty-host  ──node-pty──  PowerShell / CMD / Shell / 7 agent CLIs
   (resident, detached, survives the UI)
```

The host owns: node-pty, the launch adapters (the Windows npm-shim resolution chain, the macOS
login-shell probe), the CLI locator, one replay buffer per session, and the session table.

The main process keeps: persistence (`SessionStore`), orchestration (`SessionCoordinator`),
titling, capability probing, the updater, and the entire IPC/preload/renderer surface.

`src/main/services/pty-host-client.ts` deliberately exposes **the same public interface the old
`TerminalService` did** (`start` / `write` / `resize` / `stop` / `stopAll` / `isRunning` / `on`),
so `SessionCoordinator` and `register-ipc.ts` barely change and the existing tests' hand-written
fakes still apply. `SessionCoordinator` now depends on a structural `SessionTerminal` interface
that both the client and the old service satisfy.

### Protocol

`src/shared/pty-protocol.ts` is the single source of truth: zod-validated NDJSON, one `result`
per request, unsolicited `data` / `exit` events broadcast to every connected client. The `data`
and `exit` payloads are **byte-identical to the existing `terminal:data` / `terminal:exit` IPC
payloads**, so the main process forwards them to the renderer untouched.

Requests: `hello`, `spawn`, `write`, `resize`, `kill`, `replay`, `retire`.

Two rules matter more than the rest:

- **A client disconnect is a detach, never a kill.** This is the whole feature.
- **`kill` is the only way a session ends**, and it is only ever sent for an explicit user
  action (stop, delete, remove project) or an orphan.

### Version negotiation, and what happens during an upgrade

After an upgrade the host is deliberately the **older build** — it was started by the previous
version and is still holding that version's sessions. The new UI sends `hello` with its
`PTY_PROTOCOL_VERSION`; the host answers `welcome` with its own.

- Compatible (exact match) → the new UI adopts the sessions. **This is the upgrade path that
  makes the feature work.** The protocol version is therefore expected to stay stable across
  most releases; bumping it costs users their running sessions on that one upgrade.
- Incompatible → the new UI sends `retire`. The old host kills its sessions and exits, the new
  UI starts its own host, and the affected sessions are restored with the agents' resume flags.
  Retirement is attempted **once**, so two builds can never sit in a retire loop.

### Why the host must live outside the install directory (Windows)

This is the constraint that shapes the whole design. Two facts about the installer
electron-builder generates, both read out of `app-builder-lib` 26.15.3:

1. `allowOnlyOneInstallerInstance.nsh` kills processes **by image-path prefix**:
   `Get-CimInstance Win32_Process | ? {$_.Path.StartsWith('$INSTDIR', ...)}` → `Stop-Process`.
   It does not look at the executable name at all, and does not exclude sub-instances. On a
   machine where PowerShell is unavailable it falls back to matching **`IMAGENAME` =
   `CodeFly.exe`**.
2. On an upgrade the outgoing uninstaller runs with `--updated` and calls `un.atomicRMDir`,
   which **renames every file in `$INSTDIR` away**. If any single rename fails it rolls back and
   `Abort`s — the upgrade *fails*, it does not merely skip the locked file.

So a host started from `$INSTDIR` (even as an `ELECTRON_RUN_AS_NODE` second instance of
`CodeFly.exe`) is guaranteed to be killed, and could wedge the upgrade outright. Note the prefix
is a *string* prefix: `%LOCALAPPDATA%\Programs\CodeFly-pty-host\` would also be matched, since
the default `$INSTDIR` is `%LOCALAPPDATA%\Programs\CodeFly`.

`PtyHostRuntime` therefore stages everything the host needs into
`<userData>/pty-host/<appVersion>/` — i.e. under `%APPDATA%\codefly`, which the installer
neither matches nor deletes (an upgrade passes `--updated`, and `--delete-app-data` is not
configured) — and the executable is renamed to `codefly-pty-host.exe` so the `IMAGENAME`
fallback misses it too.

Measured facts behind the staging list (all verified on this machine, not inferred):

| Fact | Value |
| --- | --- |
| Minimal Windows Node runtime under `ELECTRON_RUN_AS_NODE=1` | `electron.exe` + `icudtl.dat` + `v8_context_snapshot.bin` — **no DLLs, no locales, no .pak files** |
| Its size | 256,059,537 bytes (electron.exe alone: 244,440,576) |
| node-pty under that runtime | loads and spawns a working ConPTY (`RESULT: node-pty works under ELECTRON_RUN_AS_NODE`) |
| node-pty 1.1.0 ABI | pure N-API (`napi_register_module_v1`), imports only KERNEL32/SHLWAPI/winpty.dll, CRT statically linked → **no rebuild for any host runtime** |
| node-pty in the package | `app.asar.unpacked/node_modules/node-pty`, 179 files / 9,740,705 bytes |
| Renaming a **running** exe | succeeds; a new file can then be written at the original path and the process keeps running |
| A detached child + its PTY child after the parent exits | both alive (`host alive=True ptyChild alive=True`) |

The 244 MB executable is **hard-linked** rather than copied where the filesystem allows it: a
hard link is an independent directory entry, so the process's image path is the staging path
(missing the `$INSTDIR` prefix check) while costing zero bytes and zero copy time, and the
installer's rename of the `$INSTDIR` name does not disturb the data the staged name points at.
`fs.link` falls back to `copyFile` silently when it cannot work — a different volume (the
installer lets users change the directory), a non-NTFS target, restricted permissions.

macOS needs none of this: an update there is the user replacing the `.app` by hand, and Unix
semantics keep a running process on its original inode. The host is launched straight from the
bundle.

## Session status becomes an intent

`SessionStore` used to rewrite every `running` / `creating` session to `stopped` on load,
because a PTY could not possibly have survived the process. It can now, so that rewrite would
be a lie.

- `creating` → `stopped` on load. A session that crashed mid-creation has neither a reliable
  PTY nor a conversation to resume.
- `running` stays `running`. It now means **"the user intends this to be running"**; whether a
  PTY exists is answered only by the host's session table.
- `stopped` still means the user stopped it, which is exactly why no new field is needed to tell
  "involuntarily interrupted" from "deliberately stopped".

`SessionCoordinator.reconcile(liveSessionIds)` runs at startup against the host's table:

| Host | AppState | Action |
| --- | --- | --- |
| has it | has it | keep/mark `running`; the UI attaches and replays |
| missing | `running` | `restore()` it (agent resume flags), one failure never blocks the others |
| missing | `creating` | `stopped` |
| has it | missing | kill it — an orphan agent running with bypass flags and no window is not acceptable |

`SessionCoordinator.shutdown()` inverts: it no longer stops PTYs, it **detaches**. It also stops
rewriting `running` to `stopped`. `delete()` and `removeProject()` keep killing, because those
are explicit user intent.

## Replay

The host retains the last `REPLAY_BUFFER_CHARS` (256 KB) of raw output per session. On attach
the renderer asks for it over a new `terminal:replay` IPC channel and writes it into the fresh
xterm instance **before** any live byte — a new `hydrated` flag on the renderer's terminal entry
gates live data into the existing pending-data buffer until the replay lands, because replay is
older than anything queued and has to be written first.

Raw bytes, not a serialized screen: the tail is free to maintain, and the agents' full-screen
TUIs repaint themselves on the resize that follows an attach. Truncation starts after the first
`\n` in the retained window so a replay never begins mid-escape-sequence — a blind cut can leave
a parser waiting for parameters or an OSC terminator that were trimmed away, swallowing the
printable bytes that follow, and a line feed is the one byte that can never appear inside an
escape sequence (it also cannot split a surrogate pair).

**The replay and the queued live bytes overlap, and the overlap has to be dropped.** The
snapshot is taken while the renderer is already queueing events, so every event that arrived
before the host answered is present *twice* — once inside the tail, once in the queue. Every
host `data` event therefore carries a monotonic per-session `sequence`, and `replayed` carries
the `throughSequence` its tail already covers; the renderer discards queued chunks at or below
that watermark. The counter is incremented, the tail appended, and the event published in one
synchronous block, so the watermark and the tail can never disagree. Chunks with no sequence at
all — the in-process fallback, and the renderer's own "[process exited]" notice — are never
discarded, because nothing claims to cover them.

The forced re-fit after hydration (zeroing `lastCols`/`lastRows` to defeat `applyFit`'s dedupe)
is what triggers that repaint: the host's PTY keeps whatever geometry the previous window
negotiated, and a TUI only redraws on a size change.

## Host lifecycle

- **Discovery/startup**: the UI connects to the endpoint (one per `userData` directory, so a
  second Windows account and the E2E suite's own `--user-data-dir` never adopt each other's
  sessions); if nothing answers it spawns a host `detached`, `stdio: 'ignore'`, `unref()`ed,
  with `ELECTRON_RUN_AS_NODE=1`, then retries with backoff.
- **Single instance**: binding the endpoint is the mutex. On macOS a stale socket file is
  distinguished from a live host by trying to connect before unlinking.
- **Idle exit**: zero sessions **and** zero clients for 60 s → exit. With sessions it never
  exits on its own, client or no client — that state *is* "the UI is closed, the agents are
  still working".
- **Startup grace (a separate deadline, 30 s)**: a host that has never had a client is idle by
  every measure and yet must not exit, because the client that spawned it is still working
  through its connect backoff. Coupling the two to one knob is silently unsafe, and the E2E run
  proved it: with the idle deadline shortened to 250 ms for the suite, the host exited ~340 ms
  after binding its endpoint — before the spawning client's first `hello` — so the app fell back
  to in-process PTYs and kept nothing alive, while every other test still passed. The grace has
  to exceed the launcher's whole connect schedule (~9.55 s); the idle deadline, which only
  matters after a client has come and gone, is then free to be short.
- **Logging**: stdio is ignored, so the host appends to a log file under `userData`.

## Relationship to the cloud-sync design

`docs/superpowers/specs/2026-09-04-cloud-sync-mobile-control-design.md` puts one
`@xterm/headless` instance per running session in the desktop process to produce cloud
snapshots. That belongs in this host, next to the PTY stream it already owns, sharing the same
`data` fan-out this protocol defines. A resident host is also what makes "a phone starts work on
a desktop" meaningful while no window is open.

## Risks and what is not yet verified

- **Protocol stability is now a user-visible cost.** Bumping `PTY_PROTOCOL_VERSION` retires the
  host and interrupts sessions on that upgrade — the one thing this design exists to prevent.
- **A repaint may not be perfect.** Whether one resize reliably makes every agent TUI redraw
  (ConPTY may not signal a resize to the same dimensions) is a real-app question, not a unit-test
  one; it is on the smoke checklist.
- **256 MB of staging** when hard-linking is unavailable (application installed to another
  volume). Cleanup of superseded versions is best-effort by design: the old directory is locked
  precisely while the old host still needs it.
- **`ELECTRON_RUN_AS_NODE` hosts show up as `codefly-pty-host.exe` in Task Manager.** Users need
  to be able to tell what that is; the name is the documentation.
- **Quitting CodeFly no longer stops the agents.** This is the intended behaviour, and it is a
  product change worth stating plainly in the README: the app is a window onto sessions, not
  their owner.
