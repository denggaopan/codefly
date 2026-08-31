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

- **SessionCoordinator**：会话全生命周期编排（create / restore / stop / delete / submitFirstInput / shutdown）。关键约束：状态变更**先持久化成功再广播**（`emit`）；每个会话/项目用 promise 链实现互斥锁（`withLock`）；PTY 启动后持久化失败要补偿（停 PTY + 落 error 状态）。
- **TerminalService**：node-pty 封装与启动适配。Windows 上对 npm shim 有一条解析链：`.exe`/`.com` 直接跑 → `.cmd`/`.bat` 优先找同名 `.exe`，否则经 ComSpec 双引号包裹托管 → 无扩展名依次探测。**恢复会话时传 `{ resume: true }`**：claude 追加 `--continue`，codex 改用 `resume --last` 子命令，shell 会话不变。
- **WorktreeService**：worktree 创建（`worktree-YYMMDD-N` 命名，写入 `.git/info/exclude` 而非 `.gitignore`）、restore 前校验、删除保护（脏 worktree 阻止删除；**分支永不删除**；从不 `--force`）。非 Git 项目或无 commit 的仓库回退为 ordinary session（直接跑在项目目录）。
- **SessionStore**：版本化 JSON（Electron `userData/state.json`），写入前经 `appStateSchema` 校验，损坏时带 recoveryWarning 恢复。
- **TitleService**：首次输入后用独立的非交互 CLI 进程生成标题（15s 超时，中性目录，**绝不带 bypass 旗标**），失败回退本地归一化/截断。标题任务的幂等由持久化的 `titleState: pending→complete` 转移保证，内存 Set 只是快路径。
- **cli-locator**（infrastructure/）：在 PATH 及标准安装位置发现 pwsh/claude/codex/VS Code。

### 渲染进程（src/renderer/）

- `store/use-app-store.ts`（zustand）：action 调 `window.codefly` 并把返回记录立即合入 appState（返回值就是主进程刚持久化的内容）；`onStateChanged` 广播则整体替换 appState，作为最终事实来源。跨 `ipcRenderer.invoke` 的 rejection 会被 Electron 抹掉子类信息，**只能读 `error.message`，不能按错误类型分支**。
- `terminal/first-input-tracker.ts`：从 PTY 输入流中剥离 ANSI 转义序列、捕获首行提交文本（用于标题生成），之后纯透传。
- 组件：`ProjectSidebar`（项目手风琴 + 会话行，停止的会话显示 "Click to restore"）、`TerminalWorkspace`（xterm 实例管理）、`SessionLauncher`、`ConfirmDialog`。

### 关键产品约定（改动前先读 README.md 对应章节）

- 交互式 Claude/Codex 会话固定携带 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`，运行期间终端头部持续显示 bypass 警告；本版本无关闭开关。
- 应用启动时所有会话一律标记为 `stopped`；点击恢复在原目录重启同类型 CLI 并续接上次对话（见 TerminalService 的 resume 参数）。
- e2e 断言了 Claude/Codex 收到的**精确 argv**、标题进程不带 bypass 旗标、worktree 序号、重启持久化、脏 worktree 删除保护等——改这些行为必须同步改 `e2e/codefly.spec.ts`。

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
