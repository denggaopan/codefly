# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CodeFly 是一个支持 Windows 与 macOS 的 Electron 桌面应用：Windows 运行 PowerShell / CMD，macOS 运行本机 Shell，两个平台都能跑 7 种 coding agent CLI（默认只开 Claude Code / Codex，另 5 种 Gemini / GitHub Copilot / Cursor / Comate / Qwen Code 需在 Settings 开启）。会话可直接使用项目目录，也可获得独立的 Git worktree 和同名分支；Claude/Codex 通过本机已安装、已登录的 CLI 启动。技术栈：Electron + React 19 + TypeScript + xterm.js + node-pty + zustand + zod。

## 常用命令

```bash
npm run dev           # 开发模式（electron-vite 热重载）
npm run typecheck     # 两个 tsc 项目：tsconfig.node.json（main/preload/shared）+ tsconfig.web.json（renderer）
npm run build         # typecheck + 打包 main/preload/renderer 到 out/
npm test              # Vitest 全量单测（src/**/*.test.ts(x)，含真实 Git 集成测试）
npx vitest run src/main/services/terminal-service.test.ts        # 跑单个测试文件
npx vitest run <file> -t "test name"                              # 跑单个用例
npm run test:e2e      # build + Playwright 驱动真实 Electron 窗口（e2e/codefly.spec.ts）
npm run package:win   # build + electron-builder 产出 release/ 下的 NSIS 安装包（无需签名凭据）
npm run package:mac   # build + 在 Linux 容器里跑 electron-builder，产出 release/ 下 macOS x64/arm64 的 .app zip（需 Docker Desktop；未签名）
```

macOS 打包的几条约束（细节见 README「Packaging › macOS」）：electron-builder 在 Windows 主机上直接拒绝 `--mac`，所以 `scripts/package-mac.mjs` 先在宿主机 build，再把仓库 bind-mount 进 `scripts/mac-builder.Dockerfile` 的容器跑 `scripts/package-mac.container.sh`；容器用 `electron-builder.mac-cross.yml` 叠加基础配置、把 `electronDist` 置空（基础配置里那份是宿主机的 Windows Electron）；只向 electron-builder 要 `dir`，再用 Info-ZIP `zip -y` 压缩——非 macOS 上 electron-builder 用 7-Zip 打 zip 会解引用 `Electron Framework.framework` 里的符号链接；`dmg` 依赖 `hdiutil`，只能在 Mac 上产出。node-pty 自带 darwin 预编译二进制，宿主机的 `node_modules` 直接复用、无需编译。x64/arm64 产物均未签名、未公证，仅供内部测试；解压后先 `xattr -cr CodeFly.app`，再执行 `codesign --force --deep --sign - CodeFly.app`。

注意：在新建的 git worktree 里 `npm install` 后若报 "Electron failed to install correctly"，运行 `node node_modules/electron/install.js` 补下二进制。

## 架构

### 四进程布局与依赖注入

- `src/main/index.ts` 是 **Electron 侧的组合根**：所有服务在此实例化并通过构造函数注入。E2E 开关 `CODEFLY_E2E=1` 只在这个文件被读取——它把 Claude/Codex 的*可执行文件*换成 fixture（`e2e/fixtures/fake-agent.cjs`），但 argv、Git、PTY、持久化等全部走生产代码路径；任何 domain service 都不允许分支判断环境变量。
- `src/preload/index.ts` 通过 contextBridge 暴露 `window.codefly` API；`src/shared/ipc.ts` 定义 channel 名，`src/shared/contracts.ts` 用 zod `strictObject` 定义所有跨进程数据结构与请求 schema。启动 snapshot 携带可信的 `platform: 'win32' | 'darwin'`，renderer 据此选择会话类型与默认偏好。
- 每个 IPC handler（`src/main/ipc/register-ipc.ts`）先用对应 zod schema parse 请求、并校验 sender 是本窗口，才触碰服务；未知 id 留给服务抛类型化错误（`SessionNotFoundError` 等）。`terminal:write`/`terminal:resize` 是单向 send 通道，解析失败或下游错误只记日志不回抛。
- `src/pty-host/` 是**常驻的第四个进程**，持有全部 node-pty：关窗、renderer 重载、UI 崩溃、乃至就地升级都不结束会话，下一个 UI 连上来重新 attach。它有**自己的组合根**（`src/pty-host/index.ts`），因为 agent 可执行文件的查找随 node-pty 一起搬了过去——所以「只有组合根读环境变量」这条规则现在是**每个进程一个组合根**，E2E 的可执行文件替换在两边各读一次。协议在 `src/shared/pty-protocol.ts`（NDJSON + zod + `PTY_PROTOCOL_VERSION`）。

### Agent 注册表（src/shared/agent-kinds.ts）

7 种 agent kind 的**唯一事实来源**，主进程与 renderer 共用：`AGENT_KINDS`（有序，claude/codex 在前）、`isAgentKind()`、`AGENT_LAUNCH`（每项 `{ command, bypassArgs, bypassEnv?, resumeArgs, resumeSubcommand? }`）、`agentLaunchArgs(kind, resume)`、`agentLaunchEnv(kind)`。加这张表之前，「这是 agent 还是 shell」在 6 处各写一遍 `kind === 'claude' || kind === 'codex'`（PTY argv、capability 探测、标题生成、bypass 徽章、Shift+Enter/Ctrl+V 按键改写、空闲 Done 态），加一个 CLI 要把 6 处都找出来。

几条容易踩的约束：

- `resumeSubcommand` 必须**排在 bypassArgs 前面**（codex 是 `resume --last <bypass>`），其余 kind 是 `<bypass> <resumeArgs>`；`agentLaunchArgs` 是唯一决定这个顺序的地方。
- `command` 不等于 kind：`cursor → agent`、`comate → comatecli`，按 kind 查会找到错的程序（cursor 是编辑器启动器）或找不到。
- Comate 没有 bypass 旗标：它的 TUI 每次启动把 run mode 重置为 `process.env.ZULU_TERMINAL_RUN_MODE || 'manual'`，所以全放行只能走 `bypassEnv`；给它传一个编造的 `--yolo` 会被静默忽略。**bypass 徽章因此不能按「有没有 bypass argv」判断，只能按 `isAgentKind`。**
- Comate 的 `resumeArgs: ['--resume']` 在 comatecli 1.0.8 里**尚未实现**（argv 解析器只认 `-h/-l/-m/-t/-v`，多余参数静默忽略、不报错），是为后续版本预留的，代价为零。
- `sessionKindSchema` 里的两半（shell 与 agent）是**手写枚举**而非从本表派生，让 contracts.ts 保持是读线格式的唯一入口；两者一致由 `agent-kinds.test.ts` 断言。
- gemini / copilot / comate / qwen 的旗标是在本机实机验证过的（`--help` 或已安装产物的 argv 解析器），cursor 本机没装、只有厂商文档依据；某个 CLI 起不来就改这张表对应的一行。
- qwen 的 `--approval-mode=yolo` 是**文档有、实现未必有**：0.22.3 的 argv 解析器根本没有 approval 旗标，会静默忽略（实测 exit 0、CLI 照常启动），该版本只能靠 `~/.qwen/settings.json` 或 TUI 里 Shift+Tab 切换——CodeFly 不去写用户的 settings 文件。保留旗标的代价是零，而徽章在这种版本上是**多警告**而非少警告，方向是安全的。

### 主进程服务（src/main/services/）

- **ProjectService**：项目注册与派生信息。`register` 时用 `git rev-parse` 记 `repoRoot`，并解析远程为 `repoRemote: { host, webUrl }`（`git-remote.ts` 的纯函数 `parseRemoteWebUrl`：origin 优先否则第一个 remote，ssh/scp 形式转 https，hostname 含 github/gitlab 判 host，本地路径/`file:` 返回 undefined）。`refreshRemotes()` 在每次组装 snapshot 时对所有项目重算并只在变化时写回一次，**永不 reject**；单个项目 git 命令失败则保留旧值。「打开 Git 仓库」的 IPC 只传 projectId，主进程从持久化记录取 `webUrl` 并在 `ExternalAppService.openRepository` 再校验 http(s) 才 `shell.openExternal`——renderer 永远指定不了 URL。
- **SessionCoordinator**：会话全生命周期编排（create / restore / stop / delete / removeProject / submitFirstInput / shutdown）。`removeProject` 只停掉该项目仍在运行的 PTY 并一次写入删掉项目和它全部会话记录，**不碰磁盘**（worktree 与分支原样保留）；PTY 停止失败只记日志不阻止移除。`create` 的第三参 `{ worktree }` 决定是否找 WorktreeService 要位置——为 false 时**根本不调用它**，直接落在项目目录（不建分支、不写 exclude）。关键约束：状态变更**先持久化成功再广播**（`emit`）；每个会话/项目用 promise 链实现互斥锁（`withLock`）；PTY 启动后持久化失败要补偿（停 PTY + 落 error 状态）。
  注入的不再是具体的 `TerminalService` 而是结构接口 `SessionTerminal`，`PtyHostClient` 与 `TerminalService` 都满足它。
  两处语义**与 pty-host 之前相反**：① `shutdown()` 现在是「松手」不是「关闭」——有 `detach()` 就调它（PTY 继续跑），没有才退回 `stopAll()`，且**不再把 `running` 改写成 `stopped`**（只改 `creating`）；② 新增 `reconcile(liveSessionIds, { autoResume })`，启动时拿 host 真实持有的会话表对账：host 有的置 `running`，host 没有而记录是 `running` 的逐个 `restore`（带 resume，单个失败不影响其余），`creating` 落 `stopped`，**host 有但记录里没有的直接杀掉**（绝不留一个没有 UI 记录、还带 bypass 全放行的 agent 在后台）。`delete()` / `removeProject()` / `stop()` 是用户明确要求终结，仍然真杀。
- **TerminalService**：node-pty 封装与启动适配，现在只是 **pty-host 起不来时的进程内回退**（会话随窗口一起结束）；生产路径上这份启动适配逻辑的等价副本活在 `src/pty-host/launch-spec.ts`，**改任何一边都要同步另一边**（e2e 断言了精确 argv）。Windows 上对 npm shim 有一条解析链：`.exe`/`.com` 直接跑 → `.cmd`/`.bat` 优先找同名 `.exe`，否则经 ComSpec 双引号包裹托管 → 无扩展名依次探测。macOS 的 Shell 用 `$SHELL -l`（无效时 `/bin/zsh -l`），agent 用绝对路径直接启动；macOS 拒绝 PowerShell/CMD，Windows 拒绝 Shell。**恢复会话时传 `{ resume: true }`**，具体 argv 由 `shared/agent-kinds.ts` 的注册表决定，shell 会话不变。agent 的启动 argv/env 一律来自 `agentLaunchArgs()` / `agentLaunchEnv()`，本服务不再自己拼旗标；`agentLaunchEnv` 的返回值只并进这一个交互式 PTY 的 env（Comate 的 bypass 是环境变量而非旗标）。
- **WorktreeService**：worktree 创建（`worktree-YYMMDD-N` 命名，写入 `.git/info/exclude` 而非 `.gitignore`）、restore 前校验、删除保护（脏 worktree 阻止删除；**分支永不删除**；从不 `--force`）。非 Git 项目或无 commit 的仓库回退为 ordinary session（直接跑在项目目录）。
- **SessionStore**：版本化 JSON（Electron `userData/state.json`），写入前经 `appStateSchema` 校验，损坏时带 recoveryWarning 恢复。每次 load 的归一化**只把 `creating` 改成 `stopped`**：`running` 要保留下来，因为 PTY 现在真的可能还活着——它表示的是「用户意图这个会话在跑」，真相只在 pty-host 的会话表里（由 `reconcile` 对账）。这也是**不需要新增字段**就能区分「非自愿中断」与「主动停止」的原因：主动停止/自己退出的会话本来就是 `stopped`，永远不会被自动拉起。
- **PtyHostClient / PtyHostLauncher**（`src/main/services/`）：主进程侧的 host 代理与引导。client 的公开接口**与旧 `TerminalService` 一致**（这是把风险压住的关键：coordinator 与 register-ipc 几乎不用改），额外提供 `connect()` / `attachedSessionIds()` / `replay()` / `detach()` / `onDisconnected()`。launcher 负责发现（endpoint 由 userData 路径哈希得到，一个 userData 一个 host）、`detached` + `ELECTRON_RUN_AS_NODE=1` 拉起、退避重连、以及**版本协商**：协议版本不同就发 `retire` 让旧 host 优雅退役再起自己的，**只重试一次**（两个版本互相 retire 会永远杀 PTY）。两者都**永不 reject**，失败折成 `unavailable`（没有 host，可以安全 resume）或 `incompatible`（那边还活着且持有 PTY，**绝不能 resume**，否则同一 worktree 会跑出两个 agent 进程）。
- **PtyHostRuntime**（`src/main/services/`）：把 host 需要的运行时搬到**安装目录之外**并按版本分目录（`<userData>/pty-host/<version>/`）。这不是优化而是必需：electron-builder 的 NSIS **按 `$INSTDIR` 路径前缀杀进程**（不看可执行文件名，PowerShell 不可用时才退回按 `CodeFly.exe` 匹配），升级时旧卸载器还会把 INSTDIR 里**每个文件 rename 走、任何一个失败就 Abort 整个升级**。所以 exe 必须改名为 `codefly-pty-host.exe`、必须不在 INSTDIR 前缀下。搬的内容：`electron.exe` + `icudtl.dat` + `v8_context_snapshot.bin`（**实测的最小 Node 运行时，不需要任何 DLL**）、`pty-host.mjs` + `chunks/*.mjs`、整个 `node-pty` 目录。大文件**优先硬链接**（`fs.link`，零字节零耗时，且进程映像路径报的是 staging 那个路径所以躲过前缀匹配），跨卷/非 NTFS 静默回退复制。macOS 与 dev 模式**完全不 staging**（替换 `.app` 不影响已运行进程的 inode）。

- **TitleService**：首次输入后用独立的非交互 CLI 进程生成标题（15s 超时，中性目录，**绝不带 bypass 旗标**），失败回退本地归一化/截断。只有 `TitleCapableKind`（claude/codex）注册 adapter——这个类型**故意比注册表的 `AgentKind` 窄**，另 5 种 agent 的 `--print` 输出格式未经验证，而标题进程绝不能带 bypass，所以它们直接走本地归一化。标题任务的幂等由持久化的 `titleState: pending→complete` 转移保证，内存 Set 只是快路径。
- **UpdaterService**：应用内更新下载与安装仅支持 Windows；macOS 只检查版本并打开 Releases 页面，`download()` / `install()` 在任何副作用前直接拒绝。Windows 的 `download()` **不接受任何参数**——它自己重新拉一次 latest release 并挑 Windows 安装包（`github-release.ts` 里的 `pickWindowsInstaller` 与 `latestReleaseSchema` 由它和 AppInfoService 共用），renderer 永远无法指定被下载/执行的 URL；只有 https 的 GitHub 域名才会被下载（`isTrustedInstallerUrl`）。流式写 `<userData>/updates/<name>.part`，完成后校验大小再 rename；进度经节流后广播。重复调用 `download()` 复用同一个 in-flight promise；`cancel()` 让它返回 `cancelled`（两个请求都挂了取消信号，元数据请求卡住时也能立刻收敛）。与 AppInfoService 一样**永不 reject**，所有失败折成结果。几条容易踩的约束：
  - `install()` **必须等 `'spawn'` 事件确认进程真的起来了才 `quit()`**。`child_process.spawn` 对不存在/被拦截/被隔离的可执行文件**不会同步抛错**，而是稍后 emit `'error'`——直接 quit 会让用户的应用关掉却没有任何安装程序在跑，而那个没人监听的 `'error'` 还会打崩主进程。失败或超时（5s）时**不退出**并返回 error。首次成功后 `install()` 幂等（quit 要先拆完所有 PTY，用户来得及点第二下）。
  - 大小未知（asset 无 `size` 且无 `Content-Length`）时**不能**当作"已校验"，至少要拒绝 0 字节——这个文件马上要被 rename 成 `.exe` 并执行。
  - 一次成功的下载会顺手清掉 `updates/` 里其它所有文件（旧版本安装包 + 崩溃留下的孤儿 `.part`），否则那个目录只增不减。清理失败只记日志，不能让成功的下载变失败。
  - `UpdaterFileSystem` 的 `fileSize`/`remove`/`listFiles` 契约上**不得抛**，但服务仍然自己兜了一层——注入的实现不归它管。
  - `DOWNLOAD_HEADERS` 带 `Accept-Encoding: identity`：否则网络栈会透明解压而 `Content-Length` 仍是压缩后的大小，完整性校验会永远失败。
  - 默认 fetch 是 `infrastructure/net-fetch.ts` 的 `electronFetch`（AppInfoService 同），**不是** Node 全局 `fetch`——原因见下面 net-fetch 条目。
- **net-fetch**（infrastructure/）：把 Electron `net.fetch`（Chromium 网络栈）适配成两个更新服务的 `FetchLike` 形状，请求带 `credentials: 'omit'`。必须用它而不是 Node 全局 `fetch`：undici 直连、既不读 Windows 系统代理也不读 `HTTP(S)_PROXY`，在需要代理才能顺畅访问 GitHub 的机器上，应用内下载只有约 10 KB/s（117 MB 要三小时），而浏览器几秒下完；`net.fetch` 像浏览器一样解析系统代理，同一文件实测 8 秒。只能在 `app` `ready` 之后调用（两个服务都在 `whenReady` 里构造）。测试用 `createNetFetch(fakeNetFetch)` 注入替身，不 mock `electron` 模块。
- **cli-locator**（infrastructure/）：`resolveAgent(kind)` 查 `AGENT_LAUNCH[kind].command` 而不是 kind 本身——`cursor` 的可执行名是 `agent`，`comate` 的是 `comatecli`，按 kind 查会找到错的程序或找不到。Windows 保留 `where.exe`；macOS 通过用户登录 shell 的 `command -v`（5s 超时）并回退 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`，Shell 解析 `$SHELL` 或 `/bin/zsh`。VS Code 的 macOS app 查找属于 `ExternalAppService`。

### 渲染进程（src/renderer/）

- `store/use-app-store.ts`（zustand）：action 调 `window.codefly` 并把返回记录立即合入 appState（返回值就是主进程刚持久化的内容）；`onStateChanged` 广播则整体替换 appState，作为最终事实来源。跨 `ipcRenderer.invoke` 的 rejection 会被 Electron 抹掉子类信息，**只能读 `error.message`，不能按错误类型分支**。
- 项目折叠状态和活动项目/会话通过 `workspace:save` 在每次变更时写入 `SessionStore` 的 `workspace` 字段，启动 snapshot 到达后统一恢复；不能只用 localStorage 或关闭事件保存，强杀 Chromium 会丢失尚未刷盘的数据。搜索临时展开不修改保存状态，恢复活动会话不强制展开所属项目，也不自动重启已停止的会话。
- `terminal/first-input-tracker.ts`：从 PTY 输入流中剥离 ANSI 转义序列、捕获首行提交文本（用于标题生成），之后纯透传。
- `terminal/terminal-key-bindings.ts`：纯函数 `resolveTerminalKey(kind, event)`，由 `TerminalWorkspace` 经 `terminal.attachCustomKeyEventHandler` 接入（该 handler 对 keydown/keypress/keyup 都会被调用，返回 false 即让 xterm 跳过该事件）。只对 agent 会话（claude/codex）生效，shell 会话一律返回 `xterm`、行为不变。两条改写：**Ctrl+V / Cmd+V** 返回 `browser`，让浏览器默认 paste 事件走 xterm 自己的 paste 监听（含 bracketed paste）；**Shift+Enter** keydown 返回 `send` `AGENT_NEWLINE_SEQUENCE`（ESC CR，即终端对 Alt/Meta+Enter 的编码），keypress/keyup 返回 `browser` 防止 xterm 再发裸 CR。所有送往 PTY 的字节（含这里发出的）都经 `TerminalWorkspace` 的 `forwardInput` 过 FirstInputTracker，ESC CR 不会被当成首行提交。
- `TerminalWorkspace` 的渲染器：`terminal.open()` 之后立刻挂 `WebglAddon`。这是正确性而非性能选择——xterm 默认的 DOM renderer 把 cell 排在**非整数**的 CSS 网格上（Cascadia Mono 在 100% 缩放下一格宽 8.7875px）且用字体字形画 Block Elements，于是 agent 用 U+2588 与四分块字符画的像素 logo 在相邻 cell 之间接不上，实心区域里会透出背景色的发丝缝（"Claude Code 图标有裂痕"）；WebGL renderer 以整数设备像素定格，并用自带的矢量 CustomGlyphs 表画这些码位，接缝消失。三条连带约束：① 激活失败（GPU 被屏蔽 / `--disable-gpu` / 驱动过旧）与运行期 context loss **一律静默回退 DOM renderer**，只是缝隙回来，会话不受影响——正因为静默，e2e 里那条断言 `.xterm-screen canvas` 存在且 `.xterm-rows` 不存在的用例是唯一的守卫；② canvas 渲染后 DOM 里**没有终端文本**，e2e 只能经 pane host 元素上的 `codeflyTerminal` 反向引用读 xterm buffer（`visibleTerminalText`），别再写 `.xterm-rows` 的文本断言；③ 光有 WebGL 还不够，见下条。
- `terminal/block-glyph-alignment.ts`：把 cell 宽**强制成偶数设备像素**，否则 WebGL 下 logo 仍有裂痕。xterm 画 Block Elements 时每一份是 `deviceCellWidth / 8`，多数码位是单个矩形（分数边界只是让轮廓变柔），但 **U+259B（▛）由两个"相接而非重叠"的矩形拼成**——左半块与右上象限在 `deviceCellWidth / 2` 处对接。cell 宽为奇数时该接缝落在半像素上，两个 `fillRect` 各在同一列抗锯齿出 50%，合成后只有 75%，于是实心色里漏出一列 25% 的背景。Claude Code 的启动 logo 头部正是 `▐▛███▛█`（`#d77757` 前景 + 纯黑背景），所以每个 ▛ 从 logo 顶边一直漏到眼睛，就是用户看到的两条竖直裂痕。修法是加 1 个设备像素的 `letterSpacing`（`device.cell.width = device.char.width + Math.round(letterSpacing)`），把接缝推到整像素上；150% 缩放下这是 0.67 CSS px，字符网格几乎没变宽。是否需要取决于 dpr（Cascadia Mono 默认字号：dpr 1/1.25 得偶数，1.5/1.75/2 得奇数），而 dpr 会在应用运行期变化（窗口移到另一块缩放不同的屏），所以**每次 `applyFit` 都重算**：从 renderer 的 canvas 位图宽度除以列数量出实际 cell 宽，再减掉已生效的 `letterSpacing` 还原字符宽——否则会在 0/1 之间来回抖。没有 canvas 说明在 DOM renderer 上，直接跳过。
- 组件：`ProjectSidebar`（项目手风琴 + 会话行；状态由标题前的彩色圆点表示，文案只作为圆点的 `aria-label`/`title`，如停止的会话是 "Click to restore"。项目操作菜单固定四项 New session / Open in VS Code / Open project folder / Remove from list，`project.repoRemote` 存在时在 folder 与 remove 之间多一项 Open Git repository，图标由 `repo-host-icons.ts` 按 host 选：GitHub 是单色 glyph 走 `.icon-mono` 暗色反白，GitLab/Git 用品牌色；菜单打开时触发按钮的 ⋯ 换成 ✕ 图标；Remove 走 `ConfirmDialog` 二次确认，文案按该项目会话数选带/不带计数的 key）、`TerminalWorkspace`（xterm 实例管理）、`SessionLauncher`、`ConfirmDialog`、`UpdateDialog`、`RocketFlight`（见下条）。
- `TitleBar` 的钉住按钮（设置右边）：窗口置顶开关。偏好是 renderer 自己的（localStorage key `codefly.windowPinned`，与 theme/locale 同源，不进 AppState），效果在主进程（`window.ts` 的 `applyWindowPinned` → `setAlwaysOnTop`），跨 IPC 的只有一个布尔。**按钮渲染的是主进程回读的 `isAlwaysOnTop()` 而不是请求值**——窗口管理器拒绝置顶时按钮不能撒谎；store 只在「这次请求被拒 且 用户此后没再点」时才回滚，避免旧请求的迟到答复覆盖新点击。启动时无条件重放一次（即便是未置顶的默认值），让窗口标志与偏好收敛。
- `rocket-flight.ts` + `RocketFlight.tsx`：点击顶部栏品牌区（logo + CodeFly 字标）掉落一枚火箭的彩蛋。几何全在 `rocket-flight.ts` 的纯函数里（`random` 注入，消费顺序固定：drop 距离 → pitch → cruise 距离 → drop 时长），组件只量启动点、调 `element.animate`。**角度约定**：火箭 SVG 画成头朝上，`headingDeg` 就是 CSS `rotate()` 值（0 = 头朝上、顺时针为正），对应方向向量 `(sin h, -cos h)`（屏幕 y 向下），所以水平向右 = 90°、巡航 heading = `90 + pitchDeg`；位置与朝向写在**同一个 `transform`** 里由一条动画驱动，不拆成两个动画，否则"头朝哪飞哪"会漂。四段：nose-down 垂直下落（≤500px，且不超出窗口底部）→ 原地转向 → 3s 缓慢巡航 → 冲出屏幕（距离取视口对角线，任何 heading 都能飞出去）。彩蛋纯装饰：portal 到 `document.body`、`z-index` 在所有对话框之上但 `pointer-events: none`；多次点击可同时有多枚；`prefers-reduced-motion: reduce` 或没有 Web Animations（jsdom）时直接走 `onDone`，不留下不动的火箭。品牌区变成 button 后必须 `no-drag`，所以旁边补了 `.title-bar-drag-area` 撑住窗口拖拽区。
- `UpdateDialog` + store 的 `updater` 状态机（`idle → available → downloading → ready → installing`，外加 `error`）：整个更新流程只有这一个界面，启动时的后台检查与 Settings 的手动检查都汇入它。**后台检查静默**——只有 `available` 才会改状态，失败/最新/无发布一律留在 `idle` 且不发 notice。进度事件只在 phase 仍是 `downloading` 时合并（避免过期事件把对话框拉回下载态），版本以事件为准而不是拿存的版本去比对——主进程在下载开始时会重新解析 release，检查与点击之间发布了新版本时用旧版本号过滤会让进度条整场停在 0。「稍后更新」只回 `idle`，已下载的安装包留在磁盘由主进程复用。`downloading` 与 `installing` 期间背景点击和 Escape **一律无效**：整窗背景对"丢弃一个快下完的下载"来说是太大的误点目标，取消只能走 Cancel 按钮；`installing` 阶段不提供任何按钮（应用正在退出，且防住双击起两个 NSIS 向导）。
- `SidebarResizer`：侧边栏与终端之间的拖拽分隔条（`role="separator"` 的 window splitter：指针拖动 + 方向键/Home/End + 双击复位）。宽度存 store 的 `sidebarWidth`，由 `App` 以内联 `--sidebar-width` 落到 `.app-body`；边界常量在 `sidebar-width.ts`（默认 300 / 最小 200 / 最大 640 / 工作区至少 360），CSS 的 `clamp()` 镜像同一组值兜底窗口后续变窄。持久化 localStorage key `codefly.sidebarWidth`，与 theme/locale 同源，不进 AppState。
- `i18n/`：自建类型安全字典，不引库。`en.ts` 是 key 的唯一来源（`TranslationKey` 由它推导），`zh-CN.ts` 被类型约束为必须全量实现——**新增 UI 文案必须同时加两个字典的 key**，否则编译不过。组件用 `useTranslation()` 取 `t`，纯函数（如 `session-status.ts`、store 的 notice）改为接收 `Translator` 或直接调 `translate(locale, ...)`。语言存 localStorage（与 theme 同源，不进持久化 AppState），**默认 en 且不跟随系统语言**：全部单测与 e2e 都断言英文文案，改默认值会全线挂。
- `SettingsDialog`：开机自启动 / 会话类型 / 外观 / 语言 / 版本与检查更新 / 关于链接。「会话类型」用 `sessionKindOptions(platform)`，每项带 `group`：`primary`（Windows 是 PowerShell/CMD/Claude/Codex，macOS 是 Shell/Claude/Codex）平铺渲染，`additional`（5 种 opt-in agent，两平台相同）收进一个默认收起的可展开分组。展开态**不是**简单的 `useState(false)`：对话框关闭时只返回 `null` 而组件仍挂载，所以展开态会跨次打开残留——收起写在 `if (!open) return null` 那个分支里（render 期间、组件不可见时同步 `setMoreKindsExpanded(false)`），**无论有没有 opt-in 开启，每次打开都是收起的**（Settings 以既有类型为主，已开启的那项一次 caret 点击就能展开）。**不能放在「每次 open」的 effect 里**：effect 在重开后 paint 之后才跑，用户会看到一帧展开态；e2e 的重试型断言看不见这一帧，一次性读 `aria-expanded` 才能抓到。每种类型两个开关：`enabled`（关闭则不出现在新建菜单）与 `worktree`（开启则额外提供「X (new worktree)」入口）。偏好存 localStorage（key `codefly.sessionKinds`，与 theme/locale 同源，不进持久化 AppState），按平台默认值合并：本机 shell 的 worktree 关、agent 的 worktree 开。**worktree 选择由创建请求显式携带（`createSessionRequestSchema.worktree`），主进程从不读这份偏好**。版本/更新/关于三块的数据由主进程 `AppInfoService` 提供，对话框每次打开时重新拉取；外链只接受 `shared/links.ts` 里的三个具名 target，URL 由主进程查表得到，renderer 不能让它打开任意地址。只有 Windows 检查结果带 `.exe` asset 时才出现「Update now」；macOS 始终链接 Releases 页面。

### 关键产品约定（改动前先读 README.md 对应章节）

- 交互式 agent 会话固定携带各自厂商的 bypass（见 `AGENT_LAUNCH`：claude `--dangerously-skip-permissions`、codex `--dangerously-bypass-approvals-and-sandbox`、gemini/qwen `--approval-mode=yolo`、copilot `--allow-all-tools`、cursor `--force`、comate 环境变量 `ZULU_TERMINAL_RUN_MODE=yolo`），运行期间终端头部持续显示 bypass 警告；本版本无关闭开关。
- 新建会话菜单的条目由 Settings 的「会话类型」开关决定：关闭的类型完全不出现（全部关闭时显示空态文案），开启 worktree 的类型有两个条目（普通 = 跑在项目目录，「(new worktree)」= 独立 worktree + 同名分支）。CLI 缺失是另一回事——条目仍在，只是 disabled 并附查找说明（说明里写的是真正被查找的可执行名，不是产品名）。**5 种 opt-in agent 默认 `enabled: false`**，所以默认安装的新建菜单与加它们之前完全一致；但它们的 `worktree` 默认是 `true`，一开启就直接有两个条目。
- **退出 CodeFly 不结束会话**：PTY 活在常驻的 pty-host 里，关窗/崩溃/就地升级都不打断 agent，下次启动 attach 回去并用 host 保留的输出尾部（每会话 256 KB）重绘终端，再补发一次 resize 让全屏 TUI 自己重画。真正结束会话的只有：会话自己退出、删除会话、把项目移出列表、协议变更导致 host 退役、重启机器。host 在「零会话且零客户端」持续 60 秒后自退——但**「还没有任何客户端连过」是另一个更长的期限**（`STARTUP_GRACE_TIMEOUT_MS`，30 秒，必须大于 launcher 约 9.55 秒的连接预算）：刚被拉起的 host 按任何标准都是空闲的，可它正在等那个把它拉起来的客户端连上来。这两件事共用一个旋钮会**静默地**坏掉——e2e 把空闲期限调成 250ms 时，host 在绑定 endpoint 后约 340ms 就退了，应用悄悄回退到进程内 PTY、什么都没保活，而其它用例照常全过。启动时 host 没有的 `running` 会话仍按原目录重启并续接上次对话（resume 参数）。
- 应用启动时后台检查一次更新：只有确实有新版本才弹 `UpdateDialog`，失败/最新/无发布全部静默。Windows 的「立即更新」在应用内下载安装包（进度可见、可取消），完成后再问一次「立即安装 / 稍后」；macOS 只打开 Releases 页面，不做应用内自更新。
- e2e 的更新用例另起一个 Electron 实例（启动检查每次启动只跑一次，模态框会挡住共用窗口的其它用例），用 `CODEFLY_E2E_RELEASE` 离线提供一个 release、`CODEFLY_E2E_INSTALL_LOG` 记录本该被执行的安装包路径；**磁盘写入是真的**（写进套件自己的 user-data 目录），只有网络与 spawn 被替换。
- e2e 断言了 Claude/Codex 收到的**精确 argv**、标题进程不带 bypass 旗标、worktree 序号（Claude=1、Codex=2、手动开启开关后的 cmd=3；PowerShell 是 ordinary）、会话类型开关的增删条目与重启存活、opt-in agent 默认收起且关闭（展开后 5 个开关全 off、worktree 开关 disabled，开启 Gemini 后菜单出现两个条目，即使已开启重开时仍是收起的）、**会话跨重启保活**（关掉 UI 进程后 host 仍在、重启后 4 个会话全是 running、host pid 不变、重启前打的字经回放仍在屏上、继续输入能接到同一个 PTY 上）、脏 worktree 删除保护、项目菜单的精确条目（fixture 仓库带一个 GitHub 形态的 `origin`，所以是 5 项且仓库图标为 mono glyph）等——改这些行为必须同步改 `e2e/codefly.spec.ts`。保活那条用例有两个非显然的约束：① **不能用 Playwright 的 `app.close()`**——它会等 Electron 在 Windows job 对象里的所有进程，包括那个「应该活下来」的 host，于是 worker 永远挂着；只能终止 UI 进程（这也正好模拟崩溃/强关路径）。② 套件的 `afterAll` 必须先把项目移出列表（等于杀掉所有 PTY），host 才会在 e2e 缩短的 idle 期限内自退，否则测试机上会堆积常驻进程；`CODEFLY_PTY_HOST_IDLE_MS` 与 `CODEFLY_E2E_HOST_PID_LOG` 就是为这两件事准备的。

## 测试约定

- 测试与源码同目录（`*.test.ts(x)`），风格是构造函数注入 + 手写 Fake（见 `terminal-service.test.ts` 的 `FakePty`/`FakePtyFactory`、`session-coordinator.test.ts` 的 `buildHarness`），不 mock 模块。
- worktree-service 测试包含真实 Git 集成用例，全量 `npm test` 约需 1.5 分钟；日常改动先跑相关文件。
- 发版前的人工冒烟清单在 README.md「Manual smoke checklist」——自动化套件全部使用测试替身，不覆盖真实已登录 CLI。

## 版本号规范

遵循语义化版本（SemVer，https://semver.org/lang/zh-CN/），格式 `MAJOR.MINOR.PATCH`：

- **MAJOR**：做了不向下兼容的破坏性变更时递增。
- **MINOR**：以向下兼容的方式新增功能时递增。
- **PATCH**：做了向下兼容的问题修复时递增。
- 高位递增时低位归零：MAJOR 递增则 MINOR、PATCH 归零；MINOR 递增则 PATCH 归零。
- 版本一经发布不得修改内容，任何改动必须以新版本发布。
- `0.y.z` 为初始开发阶段，任何内容都可能随时变化；`1.0.0` 标志公共 API 稳定。本项目目前处于 `0.y.z` 阶段。
- 先行版在版本号后加 `-` 标识（如 `1.0.0-alpha`），优先级低于对应正式版；构建元数据加 `+` 标识（如 `1.0.0+20130313`），不参与优先级比较。

完整规则（标识符格式、优先级比较细节等）以 https://semver.org/lang/zh-CN/ 为准。

**本项目约定**：重新打安装包（`npm run package:win`）发布前，先按上述规则递增 `package.json` 的 `version`，用独立的 `chore` 提交记录版本号变更，不要混入 feat/fix 提交。

## 提交规范

- 提交信息：英文、Conventional Commits 前缀（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），聚焦"为什么"。
- `docs/superpowers/` 下的 specs 与 plans 是带日期的历史设计存档，记录当时的决策，不随代码演进更新；当前行为以代码和 README 为准。
