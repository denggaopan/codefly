# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CodeFly 是一个 Windows-first 的 Electron 桌面应用：在本地项目上运行 PowerShell / CMD / Claude Code / Codex 终端会话。Git 仓库中的每个会话获得独立的 Git worktree 和同名分支；Claude/Codex 通过本机已安装、已登录的 CLI 启动。技术栈：Electron + React 19 + TypeScript + xterm.js + node-pty + zustand + zod。

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
```

注意：在新建的 git worktree 里 `npm install` 后若报 "Electron failed to install correctly"，运行 `node node_modules/electron/install.js` 补下二进制。

## 架构

### 三进程布局与依赖注入

- `src/main/index.ts` 是**唯一的组合根**：所有服务在此实例化并通过构造函数注入。E2E 开关 `CODEFLY_E2E=1` 只在这个文件被读取——它把 Claude/Codex 的*可执行文件*换成 fixture（`e2e/fixtures/fake-agent.cjs`），但 argv、Git、PTY、持久化等全部走生产代码路径；任何 domain service 都不允许分支判断环境变量。
- `src/preload/index.ts` 通过 contextBridge 暴露 `window.codefly` API；`src/shared/ipc.ts` 定义 channel 名，`src/shared/contracts.ts` 用 zod `strictObject` 定义所有跨进程数据结构与请求 schema。
- 每个 IPC handler（`src/main/ipc/register-ipc.ts`）先用对应 zod schema parse 请求、并校验 sender 是本窗口，才触碰服务；未知 id 留给服务抛类型化错误（`SessionNotFoundError` 等）。`terminal:write`/`terminal:resize` 是单向 send 通道，解析失败或下游错误只记日志不回抛。

### 主进程服务（src/main/services/）

- **ProjectService**：项目注册与派生信息。`register` 时用 `git rev-parse` 记 `repoRoot`，并解析远程为 `repoRemote: { host, webUrl }`（`git-remote.ts` 的纯函数 `parseRemoteWebUrl`：origin 优先否则第一个 remote，ssh/scp 形式转 https，hostname 含 github/gitlab 判 host，本地路径/`file:` 返回 undefined）。`refreshRemotes()` 在每次组装 snapshot 时对所有项目重算并只在变化时写回一次，**永不 reject**；单个项目 git 命令失败则保留旧值。「打开 Git 仓库」的 IPC 只传 projectId，主进程从持久化记录取 `webUrl` 并在 `ExternalAppService.openRepository` 再校验 http(s) 才 `shell.openExternal`——renderer 永远指定不了 URL。
- **SessionCoordinator**：会话全生命周期编排（create / restore / stop / delete / removeProject / submitFirstInput / shutdown）。`removeProject` 只停掉该项目仍在运行的 PTY 并一次写入删掉项目和它全部会话记录，**不碰磁盘**（worktree 与分支原样保留）；PTY 停止失败只记日志不阻止移除。`create` 的第三参 `{ worktree }` 决定是否找 WorktreeService 要位置——为 false 时**根本不调用它**，直接落在项目目录（不建分支、不写 exclude）。关键约束：状态变更**先持久化成功再广播**（`emit`）；每个会话/项目用 promise 链实现互斥锁（`withLock`）；PTY 启动后持久化失败要补偿（停 PTY + 落 error 状态）。
- **TerminalService**：node-pty 封装与启动适配。Windows 上对 npm shim 有一条解析链：`.exe`/`.com` 直接跑 → `.cmd`/`.bat` 优先找同名 `.exe`，否则经 ComSpec 双引号包裹托管 → 无扩展名依次探测。**恢复会话时传 `{ resume: true }`**：claude 追加 `--continue`，codex 改用 `resume --last` 子命令，shell 会话不变。
- **WorktreeService**：worktree 创建（`worktree-YYMMDD-N` 命名，写入 `.git/info/exclude` 而非 `.gitignore`）、restore 前校验、删除保护（脏 worktree 阻止删除；**分支永不删除**；从不 `--force`）。非 Git 项目或无 commit 的仓库回退为 ordinary session（直接跑在项目目录）。
- **SessionStore**：版本化 JSON（Electron `userData/state.json`），写入前经 `appStateSchema` 校验，损坏时带 recoveryWarning 恢复。
- **TitleService**：首次输入后用独立的非交互 CLI 进程生成标题（15s 超时，中性目录，**绝不带 bypass 旗标**），失败回退本地归一化/截断。标题任务的幂等由持久化的 `titleState: pending→complete` 转移保证，内存 Set 只是快路径。
- **UpdaterService**：应用内更新下载与安装。`download()` **不接受任何参数**——它自己重新拉一次 latest release 并挑 Windows 安装包（`github-release.ts` 里的 `pickWindowsInstaller` 与 `latestReleaseSchema` 由它和 AppInfoService 共用），renderer 永远无法指定被下载/执行的 URL；只有 https 的 GitHub 域名才会被下载（`isTrustedInstallerUrl`）。流式写 `<userData>/updates/<name>.part`，完成后校验大小再 rename；进度经节流后广播。重复调用 `download()` 复用同一个 in-flight promise；`cancel()` 让它返回 `cancelled`（两个请求都挂了取消信号，元数据请求卡住时也能立刻收敛）。与 AppInfoService 一样**永不 reject**，所有失败折成结果。几条容易踩的约束：
  - `install()` **必须等 `'spawn'` 事件确认进程真的起来了才 `quit()`**。`child_process.spawn` 对不存在/被拦截/被隔离的可执行文件**不会同步抛错**，而是稍后 emit `'error'`——直接 quit 会让用户的应用关掉却没有任何安装程序在跑，而那个没人监听的 `'error'` 还会打崩主进程。失败或超时（5s）时**不退出**并返回 error。首次成功后 `install()` 幂等（quit 要先拆完所有 PTY，用户来得及点第二下）。
  - 大小未知（asset 无 `size` 且无 `Content-Length`）时**不能**当作"已校验"，至少要拒绝 0 字节——这个文件马上要被 rename 成 `.exe` 并执行。
  - 一次成功的下载会顺手清掉 `updates/` 里其它所有文件（旧版本安装包 + 崩溃留下的孤儿 `.part`），否则那个目录只增不减。清理失败只记日志，不能让成功的下载变失败。
  - `UpdaterFileSystem` 的 `fileSize`/`remove`/`listFiles` 契约上**不得抛**，但服务仍然自己兜了一层——注入的实现不归它管。
  - `DOWNLOAD_HEADERS` 带 `Accept-Encoding: identity`：否则网络栈会透明解压而 `Content-Length` 仍是压缩后的大小，完整性校验会永远失败。
  - 默认 fetch 是 `infrastructure/net-fetch.ts` 的 `electronFetch`（AppInfoService 同），**不是** Node 全局 `fetch`——原因见下面 net-fetch 条目。
- **net-fetch**（infrastructure/）：把 Electron `net.fetch`（Chromium 网络栈）适配成两个更新服务的 `FetchLike` 形状，请求带 `credentials: 'omit'`。必须用它而不是 Node 全局 `fetch`：undici 直连、既不读 Windows 系统代理也不读 `HTTP(S)_PROXY`，在需要代理才能顺畅访问 GitHub 的机器上，应用内下载只有约 10 KB/s（117 MB 要三小时），而浏览器几秒下完；`net.fetch` 像浏览器一样解析系统代理，同一文件实测 8 秒。只能在 `app` `ready` 之后调用（两个服务都在 `whenReady` 里构造）。测试用 `createNetFetch(fakeNetFetch)` 注入替身，不 mock `electron` 模块。
- **cli-locator**（infrastructure/）：在 PATH 及标准安装位置发现 pwsh/claude/codex/VS Code。

### 渲染进程（src/renderer/）

- `store/use-app-store.ts`（zustand）：action 调 `window.codefly` 并把返回记录立即合入 appState（返回值就是主进程刚持久化的内容）；`onStateChanged` 广播则整体替换 appState，作为最终事实来源。跨 `ipcRenderer.invoke` 的 rejection 会被 Electron 抹掉子类信息，**只能读 `error.message`，不能按错误类型分支**。
- `terminal/first-input-tracker.ts`：从 PTY 输入流中剥离 ANSI 转义序列、捕获首行提交文本（用于标题生成），之后纯透传。
- `terminal/terminal-key-bindings.ts`：纯函数 `resolveTerminalKey(kind, event)`，由 `TerminalWorkspace` 经 `terminal.attachCustomKeyEventHandler` 接入（该 handler 对 keydown/keypress/keyup 都会被调用，返回 false 即让 xterm 跳过该事件）。只对 agent 会话（claude/codex）生效，shell 会话一律返回 `xterm`、行为不变（PSReadLine/conhost 自己处理 `^V`）。两条改写：**Ctrl+V** 返回 `browser`——xterm 默认会把它变成 `^V` 发给 PTY 并 cancel 事件，两个 CLI 都不会因此粘贴文本；放行后浏览器默认 paste 事件走 xterm 自己的 paste 监听（含 bracketed paste）。**Shift+Enter** keydown 返回 `send` `AGENT_NEWLINE_SEQUENCE`（ESC CR，即终端对 Alt/Meta+Enter 的编码），keypress/keyup 返回 `browser` 防止 xterm 再发裸 CR。这是真机穿过 ConPTY 后 claude.exe 与 codex 都当作换行的**唯一**编码：Claude 直接读 VT 流、把它当 Meta+Enter；Codex 走 Win32 console 事件，ConPTY 把它译成 Alt+Enter。`\n` 会被 ConPTY 译成 Ctrl+Enter 而被 Codex 忽略；CSI-u（`ESC [13;2u`）会被 ConPTY 直接丢弃。所有送往 PTY 的字节（含这里发出的）都经 `TerminalWorkspace` 的 `forwardInput` 过 FirstInputTracker，ESC CR 不会被当成首行提交。
- 组件：`ProjectSidebar`（项目手风琴 + 会话行；状态由标题前的彩色圆点表示，文案只作为圆点的 `aria-label`/`title`，如停止的会话是 "Click to restore"。项目操作菜单固定四项 New session / Open in VS Code / Open project folder / Remove from list，`project.repoRemote` 存在时在 folder 与 remove 之间多一项 Open Git repository，图标由 `repo-host-icons.ts` 按 host 选：GitHub 是单色 glyph 走 `.icon-mono` 暗色反白，GitLab/Git 用品牌色；菜单打开时触发按钮的 ⋯ 换成 ✕ 图标；Remove 走 `ConfirmDialog` 二次确认，文案按该项目会话数选带/不带计数的 key）、`TerminalWorkspace`（xterm 实例管理）、`SessionLauncher`、`ConfirmDialog`、`UpdateDialog`。
- `UpdateDialog` + store 的 `updater` 状态机（`idle → available → downloading → ready → installing`，外加 `error`）：整个更新流程只有这一个界面，启动时的后台检查与 Settings 的手动检查都汇入它。**后台检查静默**——只有 `available` 才会改状态，失败/最新/无发布一律留在 `idle` 且不发 notice。进度事件只在 phase 仍是 `downloading` 时合并（避免过期事件把对话框拉回下载态），版本以事件为准而不是拿存的版本去比对——主进程在下载开始时会重新解析 release，检查与点击之间发布了新版本时用旧版本号过滤会让进度条整场停在 0。「稍后更新」只回 `idle`，已下载的安装包留在磁盘由主进程复用。`downloading` 与 `installing` 期间背景点击和 Escape **一律无效**：整窗背景对"丢弃一个快下完的下载"来说是太大的误点目标，取消只能走 Cancel 按钮；`installing` 阶段不提供任何按钮（应用正在退出，且防住双击起两个 NSIS 向导）。
- `SidebarResizer`：侧边栏与终端之间的拖拽分隔条（`role="separator"` 的 window splitter：指针拖动 + 方向键/Home/End + 双击复位）。宽度存 store 的 `sidebarWidth`，由 `App` 以内联 `--sidebar-width` 落到 `.app-body`；边界常量在 `sidebar-width.ts`（默认 300 / 最小 200 / 最大 640 / 工作区至少 360），CSS 的 `clamp()` 镜像同一组值兜底窗口后续变窄。持久化 localStorage key `codefly.sidebarWidth`，与 theme/locale 同源，不进 AppState。
- `i18n/`：自建类型安全字典，不引库。`en.ts` 是 key 的唯一来源（`TranslationKey` 由它推导），`zh-CN.ts` 被类型约束为必须全量实现——**新增 UI 文案必须同时加两个字典的 key**，否则编译不过。组件用 `useTranslation()` 取 `t`，纯函数（如 `session-status.ts`、store 的 notice）改为接收 `Translator` 或直接调 `translate(locale, ...)`。语言存 localStorage（与 theme 同源，不进持久化 AppState），**默认 en 且不跟随系统语言**：全部单测与 e2e 都断言英文文案，改默认值会全线挂。
- `SettingsDialog`：开机自启动 / 会话类型 / 外观 / 语言 / 版本与检查更新 / 关于链接。「会话类型」每种类型两个开关：`enabled`（关闭则不出现在新建菜单）与 `worktree`（开启则额外提供「X (new worktree)」入口）；存 localStorage（key `codefly.sessionKinds`，与 theme/locale 同源，不进持久化 AppState），默认全部启用、shell 的 worktree 关、agent 的 worktree 开（`DEFAULT_SESSION_KIND_PREFERENCES`）。**worktree 选择由创建请求显式携带（`createSessionRequestSchema.worktree`），主进程从不读这份偏好**。版本/更新/关于三块的数据由主进程 `AppInfoService` 提供，对话框每次打开时重新拉取；外链只接受 `shared/links.ts` 里的三个具名 target，URL 由主进程查表得到，renderer 不能让它打开任意地址。检查结果带 `asset`（该 release 确实发布了 Windows 安装包）时才出现「Update now」，它把版本交给 store 并立刻开始下载、关闭设置框，由 `UpdateDialog` 接手。

### 关键产品约定（改动前先读 README.md 对应章节）

- 交互式 Claude/Codex 会话固定携带 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`，运行期间终端头部持续显示 bypass 警告；本版本无关闭开关。
- 新建会话菜单的条目由 Settings 的「会话类型」开关决定：关闭的类型完全不出现（全部关闭时显示空态文案），开启 worktree 的类型有两个条目（普通 = 跑在项目目录，「(new worktree)」= 独立 worktree + 同名分支）。CLI 缺失是另一回事——条目仍在，只是 disabled 并附查找说明。
- 应用启动时所有会话一律标记为 `stopped`；点击恢复在原目录重启同类型 CLI 并续接上次对话（见 TerminalService 的 resume 参数）。
- 应用启动时后台检查一次更新：只有确实有新版本才弹 `UpdateDialog`，失败/最新/无发布全部静默。「立即更新」在应用内下载安装包（进度可见、可取消），完成后再问一次「立即安装 / 稍后」；「立即安装」= 启动安装包并退出应用。
- e2e 的更新用例另起一个 Electron 实例（启动检查每次启动只跑一次，模态框会挡住共用窗口的其它用例），用 `CODEFLY_E2E_RELEASE` 离线提供一个 release、`CODEFLY_E2E_INSTALL_LOG` 记录本该被执行的安装包路径；**磁盘写入是真的**（写进套件自己的 user-data 目录），只有网络与 spawn 被替换。
- e2e 断言了 Claude/Codex 收到的**精确 argv**、标题进程不带 bypass 旗标、worktree 序号（Claude=1、Codex=2、手动开启开关后的 cmd=3；PowerShell 是 ordinary）、会话类型开关的增删条目与重启存活、重启持久化、脏 worktree 删除保护、项目菜单的精确条目（fixture 仓库带一个 GitHub 形态的 `origin`，所以是 5 项且仓库图标为 mono glyph）等——改这些行为必须同步改 `e2e/codefly.spec.ts`。

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
