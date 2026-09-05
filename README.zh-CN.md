# CodeFly

[English](README.md) | 简体中文

CodeFly 是一款适用于 Windows 和 macOS 的桌面应用，用于围绕本地项目运行 Shell 和编程 agent 会话。Windows 提供 PowerShell 和命令提示符，macOS 提供用户的登录 Shell。默认提供 Claude Code 和 Codex，还可通过设置开关启用 Gemini、GitHub Copilot、Cursor、Comate 和 Qwen Code（见[会话类型与新建会话菜单](#会话类型与新建会话菜单)）。CodeFly 专注于终端工作区，不内嵌代码编辑器：会话既可以直接运行在项目目录中，也可以使用独立的 Git worktree 和同名分支。每个 agent 都通过本地已安装、已登录的 CLI 运行。CodeFly 从不收集、存储或读取 API 密钥或 CLI 凭据。

基于 Electron、React、TypeScript、xterm.js 和 node-pty 构建。

## 环境要求

- Windows 10/11 x64，或使用对应内部测试包的 Intel / Apple Silicon Mac。
- [Node.js](https://nodejs.org/) 22.12.0 或更高版本，以及 npm。
- [Git](https://git-scm.com/downloads) 需要位于 Windows 的 `PATH` 中，或可由 macOS 登录 Shell 访问。独立 worktree 会话需要 Git（见 [Git 与 worktree 会话](#git-与-worktree-会话)）；没有 Git 时 CodeFly 仍可运行，但所有会话都会回退为项目自身目录中的普通、非隔离会话。通过普通入口创建的会话本来就运行在项目目录中，不需要 Git。
- 可选：使用某个 agent 的启动入口前，需要安装并登录它的 CLI。默认提供的两种 CLI 是 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（`claude`）和 [Codex CLI](https://github.com/openai/codex)（`codex`）；其他可选类型对应 `gemini`、`copilot`、`agent`、`comatecli` 和 `qwen`。CodeFly 在 Windows 上通过 `PATH` 查找它们，在 macOS 上通过登录 Shell 查找。CLI 缺失或未登录时，启动入口仍会显示，但处于禁用状态，鼠标悬停时显示安装提示。从 Finder 启动的 macOS 应用不会继承“终端”的 `PATH`，因此请确保在登录 Shell 中执行 `command -v claude`（或所使用的其他 CLI）能够成功。
- 可选：[Visual Studio Code](https://code.visualstudio.com/)（或 `PATH` 中的 `code` 命令），用于项目操作菜单中的“在 VS Code 中打开项目”（Open project in VS Code）。

## 快速开始

```bash
npm install
npm run dev
```

`npm run dev` 通过 `electron-vite` 以支持热重载的开发模式启动应用。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `npm run dev` | 以支持热重载的开发模式运行应用。 |
| `npm run build` | 执行类型检查，然后将主进程、preload 和渲染进程构建产物输出到 `out/`。 |
| `npm run typecheck` | 检查 main/preload/shared 和 renderer 源码的类型，使用两个独立的 `tsc` 项目引用。 |
| `npm test` | 运行 Vitest 单元、组件和集成测试（`src/**/*.test.ts(x)`）。 |
| `npm run test:watch` | 以监听模式运行 Vitest 测试。 |
| `npm run test:e2e` | 构建应用，然后运行 Playwright Electron 端到端测试（`e2e/codefly.spec.ts`）。 |
| `npm run package:win` | 构建应用，再通过 `electron-builder` 在 `release/` 中生成 Windows x64 NSIS 安装包。 |
| `npm run package:mac` | 构建应用，再在 Linux 容器内运行 `electron-builder`，于 `release/` 中生成未签名的 macOS x64 和 arm64 应用压缩包（`.zip`），需要 Docker。 |

## 添加项目

点击侧边栏底部的 **Add Project（添加项目）**，可以选择本地项目目录、重新打开最近使用的项目，或克隆 Git 仓库。“最近使用的项目”最多保留 50 个已从列表移除的项目，重启后仍然保留，且不包含当前列表中的项目。重新打开只会将目录加回列表，不会恢复已经移除的会话。

克隆时，输入 HTTPS 或 SSH 仓库地址并选择目标目录。CodeFly 会显示完整的目标路径，创建一个以仓库名命名的子目录，并在 Git 完成克隆后添加项目。已有目标文件夹不会被覆盖。私有仓库使用已有的 Git 凭据或 SSH 配置，请在克隆前完成身份验证配置。历史记录从当前版本开始保留，此前移除的记录无法自动找回。

## 会话类型与新建会话菜单

项目初始为展开状态，点击项目名称只切换该项目会话列表的展开或收起。切换会话不会改变这些状态，项目行也不显示“当前项目”高亮。搜索会临时展示匹配的会话，清空搜索后恢复各项目原有的展开或收起状态。

在项目操作菜单中打开 **New session（新建会话）**。点击启动面板外部、按 Escape 或点击关闭按钮均可关闭面板。不可用入口及其 worktree 变体都会在鼠标悬停时显示安装提示。

Settings（设置）的 **Session kinds（会话类型）** 为当前平台显示的每种会话类型提供两个开关。Windows 显示 PowerShell、Command Prompt（命令提示符）、Claude 和 Codex；macOS 显示 Shell、Claude 和 Codex。

- **Enabled（启用）** 决定该类型是否出现在新建会话菜单中。关闭后会移除其入口，已有的同类型会话不受影响。这与 CLI 缺失不同：CLI 缺失时入口仍然显示，但禁用并附带查找提示。
- **New worktree（新建 worktree）** 为该类型增加第二个入口，例如同时提供 **Claude** 和 **Claude (new worktree)**。普通入口在项目自身目录中运行会话，worktree 入口则为会话分配独立的 Git worktree 和分支。

默认情况下，当前平台可见的上述类型全部启用。本机 Shell 的 **New worktree** 默认关闭，因为快捷终端无需创建分支；agent 的该选项默认开启，以便使用隔离环境。两个开关都由渲染进程管理，与主题和语言一样存储在 `localStorage` 中。创建会话时会显式发送是否使用 worktree 的选择，主进程不会根据存储的设置自行推断。

### 更多 agent CLI

两个平台还支持五种 agent CLI，位于同一设置区域默认收起的 **More agent CLIs（更多 agent CLI）** 分组中：**Gemini**（`gemini`）、**GitHub Copilot**（`copilot`）、**Cursor**（`agent`）、**Comate**（`comatecli`）和 **Qwen Code**（`qwen`）。它们默认全部关闭，因此默认安装的新建会话菜单与之前保持一致。

启用后，它们的行为与 Claude 或 Codex 相同：出现在新建会话菜单中，同时提供普通入口和 **(new worktree)** 入口（**New worktree** 默认开启），携带各自的权限绕过设置，运行期间显示绕过警告，并支持 Shift+Enter 换行及 Ctrl/Cmd+V 粘贴。CLI 缺失时，入口仍然显示，但处于禁用状态，安装提示会明确写出 CodeFly 实际查找的可执行文件名。注意 Cursor 对应 `agent`，Comate 对应 `comatecli`，并非产品名称。

无论这五种类型中是否有已启用的类型，每次打开设置时该分组都处于收起状态。设置优先展示原有类型，点击一次展开箭头即可访问已启用的其他类型。

它们与 Claude 和 Codex 有两处刻意保留的差异：

- **不使用 AI 生成会话标题。** 这些 CLI 的非交互输出格式尚未经过本项目验证，而标题生成进程绝不能使用权限绕过设置，因此标题直接由本地首条输入归一化逻辑生成。
- **Comate 不支持恢复对话。** 恢复已停止的会话会在同一目录重新打开 CLI；`comatecli` 1.0.8 没有恢复参数，因此恢复 Comate 会话会开启新对话，无法续接之前的对话。

## Git 与 worktree 会话

当项目是至少有一次提交的 Git 仓库时，通过 **(new worktree)** 入口创建会话会在 `<repository-root>/.worktrees/<worktree-name>` 下创建独立的 Git worktree 和同名分支。worktree 按 `worktree-YYMMDD-N` 命名，使用本地日期，`N` 从 1 开始，按仓库和日期递增。`.worktrees` 目录会加入仓库的本地 Git 排除文件（`.git/info/exclude`），不会写入受版本控制的 `.gitignore`，因此不会产生需要提交的变更。

通过普通入口创建的是**普通会话**，直接运行在项目自身目录中。如果选中的项目不是 Git 仓库，或者仓库尚无提交、无法解析 `HEAD`，请求创建的 worktree 会话也会回退为普通会话。这两种情况下，侧边栏均显示“Ordinary session（普通会话）”，而非 worktree 名称。

删除带有 worktree 的会话时：

1. 停止终端或 agent 进程，并取消尚未完成的标题生成。
2. 在 worktree 中运行 `git status`。
3. **如果 worktree 有未提交的变更**（包括已修改、已暂存或未跟踪文件），会阻止删除，保留会话和 worktree，并显示变更文件数量。请自行在 CodeFly 之外提交或放弃变更，然后再次删除。
4. **如果 worktree 是干净的**，CodeFly 会移除 worktree 目录和会话记录，移除时不使用 `--force`。
5. **永远不会删除分支。** 为会话创建的同名分支在会话和 worktree 移除后仍保留在仓库中，因此始终可以从该分支找回工作成果。

CodeFly 从不强制移除 worktree，也不删除提交、stash 或原项目文件。

## 交互式 agent 会话

每个交互式 agent 会话都会使用对应厂商固定的权限绕过方式启动 CLI，不额外添加其他设置：

| 会话类型 | 可执行文件 | 每个交互式会话携带的权限绕过设置 |
| --- | --- | --- |
| Claude | `claude` | `--dangerously-skip-permissions` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `gemini` | `--approval-mode=yolo` |
| GitHub Copilot | `copilot` | `--allow-all-tools` |
| Cursor | `agent` | `--force` |
| Comate | `comatecli` | 会话环境变量 `ZULU_TERMINAL_RUN_MODE=yolo` |
| Qwen Code | `qwen` | `--approval-mode=yolo`（见下方说明） |

Comate 是唯一没有权限绕过参数的 CLI：其 TUI 每次启动都会将运行模式重置为 `ZULU_TERMINAL_RUN_MODE || "manual"`，因此必须通过环境变量传递设置。该变量仅用于对应的交互式 PTY，不会设置到 CodeFly 自身进程中。

Qwen Code 存在另一种例外：文档描述了 `--approval-mode=yolo` 参数，但并非每个版本都实现了它。0.22.3 会忽略该参数且不报错，权限审批模式实际取自 `~/.qwen/settings.json`，或通过 TUI 中的 Shift+Tab 切换。CodeFly 仍会传递该参数，使其在 CLI 支持后立即生效，但不会写入用户的设置文件。因此，在这类版本中，徽章可能提示 CLI 实际尚未启用的权限绕过，只会多警告，不会少警告。

**这些设置会在会话存续期间绕过 agent 自身的权限和沙箱保护。** agent 可以在 worktree 中读取、写入和执行命令，无需逐次操作确认。这是为快速、低摩擦终端工作流做出的设计选择，CodeFly 会持续明确展示：当当前会话是正在运行的 agent 会话时，终端标题栏始终显示紧凑的“Permissions and sandbox bypass enabled（已启用权限与沙箱绕过）”警告徽章。本版本没有按会话关闭绕过的设置；如果不希望 agent 绕过自身保护，请勿在 CodeFly 中启动 agent 会话。

CodeFly 用于生成会话标题的后台非交互进程（见下文）不会携带这些绕过参数，不共享交互会话的 PTY，并运行在中立目录中，而非项目或 worktree 目录。

### 键盘操作：粘贴与多行输入

所有 agent 会话均支持在 Windows 上用 **Ctrl+V**、在 macOS 上用 **Cmd+V** 将剪贴板文本粘贴到 CLI 输入区，使用 **Shift+Enter** 换行，使用 **Enter** 发送消息。CodeFly 将系统粘贴快捷键交还浏览器，由 xterm 的粘贴流程（包括 bracketed paste）将内容送入 PTY。Shift+Enter 会以 `ESC CR` 发送，这是这些 CLI 接受的兼容 Meta/Alt+Enter 的序列。本机 Shell、PowerShell 和命令提示符会话保留 xterm 的默认键盘处理方式。

## 会话标题

会话标题最初是占位文本，例如“New Claude session（新 Claude 会话）”，在终端提交第一条文本后更新一次。Claude 和 Codex 会话会先尝试通过独立的非交互 CLI 调用生成 AI 标题，超时为 15 秒。其他类型，包括本机 Shell 和五种可选 agent CLI，以及 AI 标题生成失败或超时的情况，都回退为对输入进行本地归一化处理，最后再回退为简单截断。标题生成不会延迟终端输入。

## Visual Studio Code 与项目文件夹

项目操作菜单提供 Visual Studio Code 和文件夹操作。两者始终打开用户最初选择的项目目录，不会打开会话的 worktree，也不会切换当前会话或改变项目行的展开、收起状态。在 Windows 上，CodeFly 通过 `code` 命令和标准安装目录查找 Visual Studio Code；在 macOS 上则检查标准应用安装位置。未找到时，菜单项禁用并显示安装提示。文件夹操作通过 Electron 的 `shell.openPath` 在系统文件管理器中打开目录，无需安装 Visual Studio Code。

## Git 仓库与移除项目

如果项目目录位于 Git 仓库中，且仓库存在可访问网页的远程地址，操作菜单还会显示 **Open Git repository（打开 Git 仓库）**。CodeFly 读取 `origin` 远程地址；没有 `origin` 时读取第一个远程地址，将 `git@github.com:owner/repo.git` 等 ssh/scp 形式转换为 https 页面，并在默认浏览器中打开。菜单图标随远程主机变化：主机名包含 `github` 时使用 GitHub 图标，包含 `gitlab` 时使用 GitLab 图标（包括自托管实例），其他情况使用普通 Git 图标。没有远程地址或远程地址为本地目录的仓库不会显示此入口。每次启动应用都会重新读取远程地址，因此新增或修改远程地址会在下次启动时生效。UI 向主进程只传递项目 ID，浏览器打开的 URL 始终由 CodeFly 自行推导，且必须使用 http(s)。

**Remove from list（从列表移除）** 会在确认后移除项目记录。该项目所有正在运行的会话都会停止，全部会话记录也会一并移除；磁盘内容不会改变，项目目录、worktree 及其分支均原样保留。以后重新添加该目录时，会话列表为空。

## 窗口置顶

设置齿轮旁的图钉按钮可让 CodeFly 保持在其他窗口之上，方便在其他应用中工作时关注后台运行的 agent。再次点击可取消置顶；按钮的按下状态和使用正常图标颜色填充的图钉表示当前已置顶。

该偏好由渲染进程管理，与主题和语言一样保存在 `localStorage` 中，不写入状态文件；实际窗口行为由主进程控制。IPC 只传递布尔值，按钮显示的是从窗口回读的实际置顶状态，而非请求的值，因此窗口管理器拒绝请求时不会显示错误状态。下次启动时会重新应用该偏好。

## 标题栏火箭

点击 Logo 和 **CodeFly** 字标会发射一枚火箭：它先头朝下随机下落一段距离，最多 500px 且不超出窗口底部，再转向随机的向右航向，缓慢巡航三秒，最后冲出屏幕。火箭头始终朝向飞行方向，位置和朝向由同一段动画中的一个 `transform` 控制；几何计算全部位于 `src/renderer/src/rocket-flight.ts` 的纯函数中，并通过注入随机数来源让测试能验证这一行为。

火箭仅作装饰：通过 portal 挂载到 `document.body`，显示在所有对话框上方且不接收指针事件，因此不会拦截点击。多次点击可同时发射多枚火箭；用户启用 `prefers-reduced-motion: reduce` 时完全跳过飞行动画。品牌区域现在是按钮，必须设置 `-webkit-app-region: no-drag`，它与操作按钮之间的空白区域负责保留窗口拖拽能力。

## 设置

标题栏的齿轮按钮用于打开设置对话框。

- **Launch at startup（开机自启动）** 将 CodeFly 注册为系统登录项或移除该登录项。开关显示的是写入后从系统回读的值，因此系统拒绝的变更不会被显示为已生效。
- **Session kinds（会话类型）** 为每种类型提供两个开关，分别控制是否出现在新建会话菜单中，以及是否提供 **(new worktree)** 入口。见[会话类型与新建会话菜单](#会话类型与新建会话菜单)。
- **Appearance（外观）** 在深色和浅色主题配置之间切换。
- **Language（语言）** 在 English 和简体中文界面之间切换。该偏好与主题一样由渲染进程管理，存储在 `localStorage` 中，不进入持久化状态文件。默认使用英语，不跟随系统语言，以保证首次启动和断言英文文案的测试套件行为一致。它仅覆盖静态界面文案：主进程文本（工具可用性提示、会话错误）和已持久化的会话标题仍保留生成时的语言。
- **Version（版本）** 显示已安装版本，并按需查询 GitHub 最新 Release API。Windows 可以在应用内下载并启动已发布的 `.exe`；macOS 会提供 Releases 页面链接，以下载对应架构的版本。见[更新](#更新)。
- **About CodeFly（关于 CodeFly）** 提供项目仓库、更新日志（Releases 页面）和下载页面链接。渲染进程只能请求这三个具名目标之一，主进程从 `src/shared/links.ts` 中解析对应 URL，再传给 `shell.openExternal`，因此渲染进程无法让应用打开任意地址。

## 更新

CodeFly 启动时会在后台查询一次 GitHub 最新 Release API。只有存在更新版本时才显示对话框；检查失败、离线、已是最新版或仓库尚无 Release 时均不打扰用户。发现新版本且 Release 包含 Windows 安装包时，Windows 会提供 **Update now（立即更新）**。macOS 则提供 Releases 页面，让用户手动下载对应的 x64 或 arm64 压缩包。

在 Windows 上，**Update now（立即更新）** 会在应用内下载安装包，显示进度条和 **Cancel（取消）** 按钮，文件存入 Electron `userData` 目录下的 `updates` 文件夹。下载期间只能通过 **Cancel（取消）** 退出，点击背景或按 Escape 均无效，避免误操作丢弃即将完成的下载。版本检查和下载都使用 Chromium 的网络栈，即 Electron 的 `net.fetch`，因此会像浏览器一样遵循系统代理；通过代理访问 GitHub 时，CodeFly 的安装包下载速度可与 Chrome 保持一致。

下载完成后会再次确认：**Install now（立即安装）** 退出应用并启动安装程序，因为安装程序需要替换应用当前占用的文件；会话仍会继续运行，见[关闭窗口后继续运行的会话](#关闭窗口后继续运行的会话)。**Later（稍后）** 只关闭对话框，已下载的安装包保留在磁盘上。之后再次选择 **Update now（立即更新）** 时可直接使用该文件，跳过下载并进入安装确认。只保留这一个安装包：新下载完成后，会清理所有过期安装包和因下载中途崩溃而遗留的 `.part` 文件。也可以随时通过设置中的 **Check for updates（检查更新）** 进入同一流程。

CodeFly 仅在操作系统确认安装程序进程确实启动后退出。安装程序被阻止、隔离或丢失时，应用会保持打开并解释原因，不会退出后留下无安装程序运行的状态。

渲染进程不能指定下载或执行的内容：下载、取消和安装的 IPC 命令均不接受参数，主进程自行重新解析 Release 资源，并拒绝所有非 HTTPS GitHub Release 地址的下载 URL。非 Windows 平台或不包含 `.exe` 资源的 Release 只提供下载页面，不提供应用内下载。

## 关闭窗口后继续运行的会话

CodeFly 的 PTY 由常驻的 **pty-host** 进程持有，应用按需启动它后便让其继续运行。因此，关闭 CodeFly、重新加载渲染进程、UI 崩溃或安装更新，都不会打断会话及其中运行的 agent CLI。重新打开 CodeFly 时会连接该 host，利用其保存的输出（每个会话最近的 256 KB）重绘各终端，并发送一次尺寸更新，使全屏 agent TUI 重绘当前画面。

这使得就地更新不会中断工作。**Install now（立即安装）** 替换应用时，host 仍持有 PTY，新安装的版本会连接到之前版本启动的会话。按设计，更新后继续运行的 host 仍是旧版本。连接时双方会协商协议版本，只有修改协议的 Release 才需要让旧 host 退役；这种情况下，会话使用各 agent 自身的恢复参数重新启动，而非直接接管。

Windows 上的 host 不能运行在安装目录中：NSIS 生成的安装程序会终止所有进程映像路径以安装目录开头的进程，与可执行文件名无关；升级还会将该目录内的每个文件重命名移走，任一失败都会中止整个升级。因此，Windows 打包版本会把 host 所需文件放到 Electron `userData` 目录下的 `pty-host/<version>/`，并将可执行文件命名为 `codefly-pty-host.exe`，可在任务管理器中据此查找。在文件系统允许时，244 MB 的 Electron 二进制通过硬链接而非复制放置，所以通常几乎不消耗额外空间和时间；安装到不同卷时则回退为实际复制。macOS 无需此处理：替换 `.app` 后，运行中的进程仍使用原有 inode。

真正结束会话的情况包括：会话自行退出（退出 agent 或在 Shell 中执行 `exit`）、删除会话、将所属项目从列表移除、协议变更导致 host 退役，以及重启计算机。退出 CodeFly 不会结束会话。当 host 连续一分钟既没有会话、也没有窗口连接时，它会自行退出。

## 持久化

每个项目分组各自的展开或收起状态会在重启后保留。CodeFly 会自动打开上一个窗口中选中的会话，即使其所属项目处于收起状态。工作区偏好每次变更都会原子写入 `state.json`，不依赖关闭事件，因此 UI 意外退出后也能保留。搜索只会临时展开匹配分组。恢复时会忽略已删除的项目和会话；如果之前选中的会话已经停止，则只显示它，不自动重启。

项目和会话元数据保存在 Electron `userData` 目录下带版本号的 JSON 文件中，不包含终端滚动历史、PTY 句柄或凭据。记录中的 `running` 表示预期状态，实际运行情况需要确认：启动时，CodeFly 会询问 pty-host 当前持有的 PTY，并核对两份列表。host 仍持有的会话会直接接管，不作改动；已经不在 host 中的会话会在原目录重新启动；host 持有但状态文件没有记录的会话则会被终止，避免无人管理地继续运行。标为 `stopped`、即已自行退出的会话不会自动重启，点击它即可重新启动相同类型的终端或 agent。重新启动 agent 会话时，会按各厂商的方式要求 CLI 续接上次对话：`claude --continue`、`codex resume --last`、`gemini --resume latest`、`copilot --continue`、`agent --resume`、`qwen --continue`。这是尽力恢复机制；`comatecli` 本身不支持恢复，因此恢复 Comate 会话会开启新对话。Shell 会话始终重新开始。

侧边栏宽度与主题和语言一样，是渲染进程管理的 `localStorage` 偏好，不写入状态文件。拖动侧边栏与终端之间的分隔线可调整宽度；也支持键盘操作：聚焦分隔线后，ArrowLeft/ArrowRight 微调，Home/End 跳到边界，双击恢复默认 300px。宽度限制为 200px 到 640px，且终端工作区始终至少保留 360px，即使之后缩小窗口也会遵守此限制。

窗口本身的状态不会保存：CodeFly 每次都以最大化方式打开，为终端和项目侧边栏提供完整屏幕空间。取消最大化后，窗口恢复为 1180×760。

## 测试

```bash
npm test          # Vitest：单元、组件和 Git 集成测试
npm run test:e2e   # Playwright：完整 Electron 端到端流程
```

端到端测试套件（`e2e/codefly.spec.ts`）驱动真实 Electron 窗口，覆盖添加项目、创建 Claude/Codex/PowerShell/Command Prompt 会话、验证 Claude 和 Codex 收到的精确绕过参数（以及标题生成进程不会收到这两个参数）、持续显示的绕过警告、worktree 序号、各会话类型开关（关闭类型后入口消失、开启 worktree 后增加第二入口、可选 agent CLI 默认收起且关闭，设置重启后保留）、重启持久化、VS Code/资源管理器菜单操作、有未提交变更的 worktree 删除保护、干净 worktree 删除后仍保留分支，以及完整更新流程（启动提示、**Later（稍后）**、设置入口衔接、真实流式下载和安装程序启动）。

测试以 `CODEFLY_E2E=1` 运行。该开关只在应用组合根 `src/main/index.ts` 中处理，领域服务不会依据它分支；它用小型测试可执行文件（`e2e/fixtures/fake-agent.cjs`）替换真实的 `claude`/`codex` CLI，并为“Add Project（添加项目）”目录选择器提供固定目录。更新测试还会通过 `CODEFLY_E2E_RELEASE` 离线提供一个已发布版本，并通过 `CODEFLY_E2E_INSTALL_LOG` 记录本应执行的安装程序。版本比较、资源选择、GitHub 主机允许列表、流式写入、大小检查和重命名都走真实实现，写入测试套件自己的用户数据目录。测试替身只替换启动哪个可执行文件；各会话类型收到的绕过参数仍由生产环境同一套固定的真实启动适配逻辑生成。其余环节，包括 Git、PowerShell、`cmd.exe`、持久化状态文件和完整 worktree 生命周期，都使用真实生产实现。未设置 `CODEFLY_E2E` 时，包括所有生产构建和安装版本，这些测试接线都不会生效。

## 打包

`npm run package:win` 或 `npm run package:mac` 成功后，`release/` 按语义化版本排序，仅保留最新三个版本。旧安装包、macOS 压缩包、blockmap、发布说明和带版本号的发布/验证记录会一起移除。解包应用、缓存、`latest*.yml` 及无关文件保持原样。如需仅执行清理而不构建，运行 `npm run release:prune`。

### Windows

```bash
npm run package:win
```

在 `release/` 下生成未签名的 Windows x64 NSIS 安装包。打包不需要代码签名凭据。

### macOS（通过 Docker 从 Windows 或 Linux 打包）

```bash
npm run package:mac
```

生成 `release/CodeFly-<version>-mac-x64.zip` 和 `release/CodeFly-<version>-mac-arm64.zip`，每个压缩包都包含未签名的 `CodeFly.app`。electron-builder 拒绝在 Windows 主机上构建 macOS 目标，因此 `scripts/package-mac.mjs` 先在宿主机构建 `out/`，再将仓库 bind-mount 到小型 Linux 容器中运行 electron-builder。容器定义为 `scripts/mac-builder.Dockerfile`，使用 `node:24-bookworm-slim` 和 Info-ZIP。

- 必须运行 Docker Desktop 或其他 Docker daemon。镜像首次使用时构建并缓存。Electron 的 darwin 构建和 electron-builder 图标工具集只需下载一次，在 Windows 上缓存到 `%LOCALAPPDATA%\codefly-mac-builder\cache`，其他平台缓存到 `~/.cache/codefly-mac-builder`。
- 宿主 Shell 的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 会转发到容器，回环代理地址会改写为 `host.docker.internal`。
- 宿主机的 `node_modules` 直接复用；node-pty 自带 darwin 预编译文件，无需编译。`electron-builder.yml` 中的 `mac.files` 会从应用包中排除 node-pty 的 Windows 二进制。
- 容器只要求 electron-builder 输出 `dir`，再自行用 `zip -y` 压缩。原因是 electron-builder 在非 macOS 平台使用的 7-Zip 会解引用 `Electron Framework.framework` 内部的符号链接。`dmg` 需要 `hdiutil`，因此只能在 Mac 上通过 `npx electron-builder --mac` 生成；这也是 `electron-builder.yml` 中 `mac.target` 描述的目标。
- 容器使用 `electron-builder.mac-cross.yml` 作为叠加配置，清空 `electronDist`，以下载 darwin Electron，避免复用宿主机的 Windows 版本。

这些应用包仅用于内部测试，未签名、未公证。请下载与 Mac 匹配的压缩包：Apple Silicon 使用 `mac-arm64.zip`，Intel 使用 `mac-x64.zip`。解压后，在首次启动前执行：

```bash
xattr -cr CodeFly.app
codesign --force --deep --sign - CodeFly.app
```

临时签名只对这份本地副本生效，不能替代 Developer ID 签名或公证。可按需将 `CodeFly.app` 移至 `/Applications`，然后从 Finder 打开。如果 Gatekeeper 仍阻止启动，请在“系统设置 > 隐私与安全性”中选择 **Open Anyway（仍要打开）**。不要将此内部构建作为常规公开 macOS 版本重新分发。

macOS 运行时显示 Shell、Claude 和 Codex。CLI 查找先经过用户登录 Shell，再检查常见 Homebrew 和本地安装位置，因此从 Finder 启动时无需继承“终端”的 `PATH`。PowerShell 和命令提示符仍仅适用于 Windows。

### 手工冒烟验收清单（已登录 CLI 与打包版本）

自动化测试使用 agent CLI 测试替身，不需要真实凭据。交付构建前，请使用真实、已登录的 `claude` 和 `codex` CLI 验证。

五种可选 agent CLI 默认关闭，不属于必测范围。启用其中一种做冒烟测试时，请验证自动化测试无法覆盖的两点：CLI 确实能在其权限绕过设置下启动（Comate 使用 `ZULU_TERMINAL_RUN_MODE=yolo` 环境变量，而非命令行参数）；恢复已停止会话时能续接先前对话。Comate 例外，它不支持恢复，预期应开启新对话。

#### Windows x64

- 分别创建普通和 worktree 模式的 PowerShell、命令提示符、Claude 和 Codex 会话，验证工作目录、输入输出、恢复和删除行为。
- 验证 Visual Studio Code 与项目文件夹操作、包含空格和非 ASCII 字符的项目路径，以及开机自启动开关。
- 将窗口置顶，确认它保持在其他应用窗口之上；重启 CodeFly 后确认仍然置顶，再取消置顶。
- 验证 **Ctrl+V**、agent 的 **Shift+Enter**，以及 Windows 应用内下载、取消、安装的更新流程。Windows 没有新建会话快捷键：确认 `Ctrl+T` 传入当前聚焦的终端，而不会创建 PowerShell 会话。
- 使用真实安装版本验证会话保活，这是自动化测试无法演练的环节，因为测试运行未打包应用，不会部署 host 文件，也不会运行安装程序。启动 Claude 会话并交给它一个长任务，然后：
  1. 退出 CodeFly。任务管理器中必须仍有 `codefly-pty-host.exe`，agent 必须继续工作，输出持续写入 `userData` 下的 host 日志。
  2. 重新打开 CodeFly。会话必须恢复为 **running（运行中）**，并重绘画面，而非变成已停止。检查 agent 当前画面清晰完整，不能只绘制一半，因为重绘依赖一次尺寸更新到达 TUI。
  3. 保持该会话运行，执行覆盖更新（**Update now（立即更新）** → **Install now（立即安装）**）。安装程序不能提示应用仍在运行，不能失败，新安装版本必须连接同一个会话，而非重新启动。确认 `userData/pty-host/` 中按版本分别存在目录，旧 host 退出后，对应旧目录会消失。
  4. 在接管的会话中输入，确认按键能到达 agent。
- 检查 Claude 和 Codex 启动横幅中的像素 Logo 是否有发丝状接缝，再换一种显示缩放重复检查，100% 和 150% 会产生不同的字符单元宽度。图形完整性依赖两点：WebGL 渲染器，以及宽度为偶数设备像素的字符网格。没有 WebGL2 上下文时会静默回退；xterm 将 U+259B（Logo 的头部）绘制为两个在单元宽度中点相接的矩形，奇数宽度会让接缝跨越像素并露出背景。出现裂缝表示其中一项未生效。

#### macOS x64 与 arm64（必须分别验证）

在真实 Intel Mac 上使用 `mac-x64.zip` 完整执行一次清单，并在真实 Apple Silicon Mac 上使用 `mac-arm64.zip` 再完整执行一次。仅通过 Rosetta 运行不能覆盖两种架构。

- 解压、清除隔离属性、应用临时签名，将应用移至 `/Applications`，并从 Finder 启动，不从“终端”启动。
- 添加路径中包含空格和非 ASCII 字符的项目，验证路径大小写保持正确，且不会被改写为 Windows 路径分隔符。
- 通过普通入口和 **(new worktree)** 入口分别创建 Shell、Claude 和 Codex 会话。确认普通会话使用项目目录，worktree 会话使用分配的 worktree 和分支。
- 输入命令或提示词，关闭并重新打开 CodeFly，恢复每个已停止会话，再删除普通会话和干净的 worktree 会话。确认仍会保护有未提交变更的 worktree，阻止删除。
- 验证标题生成进程失败后，仍会生成可用的本地回退标题。
- 检查 Claude 和 Codex 启动横幅中的像素 Logo 是否有发丝状接缝；接缝对应的两种原因见 Windows 清单。
- 验证 **Open in Visual Studio Code（在 Visual Studio Code 中打开）**、**Open project folder（打开项目文件夹）**（Finder）和 **Open Git repository（打开 Git 仓库）**，同时确认当前会话不变。
- 切换 **Launch at startup（开机自启动）**，重新打开设置确认系统实际值；测试机器允许时注销并重新登录，再将该设置关闭。
- 检查可用更新，确认 macOS 只提供 Releases 页面，绝不能下载或执行 Windows 安装程序。
- 将窗口置顶，确认它保持在其他应用窗口之上；重启 CodeFly 后确认仍然置顶，再取消置顶。
- 验证 **Cmd+V** 能向 Claude 和 Codex 粘贴，**Shift+Enter** 换行而不提交，`Cmd+T` 创建普通 Shell 会话。
- 在英语与简体中文之间切换，确认重启后保留选择。

## 开源协议

本项目使用 [MIT 许可证](LICENSE)（SPDX：`MIT`）。允许自由使用、复制、修改和分发，包括商用与闭源使用；软件副本或实质性部分须保留版权声明及许可证文本，不要求公开源代码。完整条款见 [LICENSE](LICENSE)。第三方依赖仍适用各自原有的许可证条款。
