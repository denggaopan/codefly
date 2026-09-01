import type { Translations } from './en-types'

/**
 * Simplified Chinese dictionary. Typed as `Translations`, so adding a key to en.ts breaks
 * the build here until it is translated — the dictionaries can never silently drift apart.
 * Product names (CodeFly, Claude, Codex, PowerShell, VS Code) and CLI flags stay verbatim.
 */
export const zhCN: Translations = {
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.delete': '删除',

  'titleBar.settings': '设置',

  'sidebar.searchSessions': '搜索会话',
  'sidebar.dismissNotice': '关闭提示',
  'sidebar.projectOptions': '{project} 的项目选项',
  'sidebar.newSession': '新建会话',
  'sidebar.openInVSCode': '在 VS Code 中打开项目',
  'sidebar.openProjectFolder': '打开项目文件夹',
  'sidebar.addProject': '添加项目',
  'sidebar.ordinarySession': '普通会话',
  'sidebar.deleteSessionTitle': '删除会话',
  'sidebar.deleteSessionAria': '删除 {title}',
  'sidebar.deleteSessionPrompt': '确定删除“{title}”吗？此操作无法撤销。',

  'launcher.createSession': '创建会话',
  'launcher.newSession': '新建会话',
  'launcher.close': '关闭启动器',
  'launcher.worktreeVariant': '{kind}（新建 worktree）',
  'launcher.allKindsDisabled': '所有会话类型都已在设置中关闭。',

  'sessionKind.powershell': 'PowerShell',
  'sessionKind.cmd': '命令提示符',
  'sessionKind.claude': 'Claude',
  'sessionKind.codex': 'Codex',

  'status.running': '运行中',
  'status.done': '已完成',
  'status.stopped': '点击恢复',
  'status.creating': '启动中…',
  'status.missing': '路径不存在',
  'status.error': '错误',

  'terminal.emptyState': '选择或新建一个会话，在这里查看它的终端。',
  'terminal.restartSession': '重启会话',
  'terminal.bypassWarning': '已启用权限与沙箱绕过',
  'terminal.bypassTooltip':
    '该 agent 以固定的绕过旗标运行（--dangerously-skip-permissions / --dangerously-bypass-approvals-and-sandbox）：它会直接修改文件、执行命令，不再逐次征求确认。',

  'notice.genericError': '出错了。',
  'notice.dirtyWorktree': 'Worktree 中有 {count} 个文件已改动。请先提交或丢弃这些改动，再删除会话。',

  'settings.title': '设置',
  'settings.close': '关闭设置',
  'settings.launchAtLogin': '开机自动启动',
  'settings.launchAtLoginFailed': '无法修改开机启动设置：{reason}',
  'settings.sessionKinds': '会话类型',
  'settings.sessionKindsHint':
    '关闭的会话类型不会出现在“新建会话”菜单中。开启“新建 worktree”后，该类型会额外提供一个选项，让会话运行在独立的 Git worktree 与同名分支中。',
  'settings.columnEnabled': '启用',
  'settings.columnWorktree': '新建 worktree',
  'settings.enableKind': '启用 {kind}',
  'settings.worktreeForKind': '为 {kind} 新建 worktree',
  'settings.appearance': '外观',
  'settings.themeDark': '深色',
  'settings.themeLight': '浅色',
  'settings.language': '语言',
  'settings.version': '版本',
  'settings.versionUnknown': '未知',
  'settings.checkForUpdates': '检查更新',
  'settings.checking': '正在检查更新…',
  'settings.upToDate': 'CodeFly 已是最新版本。',
  'settings.updateAvailable': '新版本 {version} 可用。',
  'settings.updateNoReleases': '尚未发布任何版本。',
  'settings.updateFailed': '检查更新失败：{reason}',
  'settings.about': '关于 CodeFly',
  'settings.linkRepository': '项目地址',
  'settings.linkChangelog': '更新日志',
  'settings.linkDownload': '下载地址',
  'settings.openExternalHint': '将在浏览器中打开'
}
