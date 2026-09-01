/**
 * The English dictionary is the SOURCE OF TRUTH for the renderer's translation keys: its
 * shape defines `TranslationKey`, every other locale is type-checked against it, and any
 * key a locale is missing falls back to the string here. Placeholders use `{name}` and are
 * substituted by `translate()`; keep them identical across locales.
 */
export const en = {
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',

  'titleBar.settings': 'Settings',

  'sidebar.searchSessions': 'Search sessions',
  'sidebar.dismissNotice': 'Dismiss notice',
  'sidebar.projectOptions': 'Project options for {project}',
  'sidebar.newSession': 'New session',
  'sidebar.openInVSCode': 'Open project in VS Code',
  'sidebar.openProjectFolder': 'Open project folder',
  'sidebar.addProject': 'Add Project',
  'sidebar.ordinarySession': 'Ordinary session',
  'sidebar.deleteSessionTitle': 'Delete session',
  'sidebar.deleteSessionAria': 'Delete {title}',
  'sidebar.deleteSessionPrompt': 'Delete "{title}"? This cannot be undone.',

  'launcher.createSession': 'Create session',
  'launcher.newSession': 'New session',
  'launcher.close': 'Close launcher',
  'launcher.worktreeVariant': '{kind} (new worktree)',
  'launcher.allKindsDisabled': 'Every session kind is turned off in Settings.',

  'sessionKind.powershell': 'PowerShell',
  'sessionKind.cmd': 'Command Prompt',
  'sessionKind.claude': 'Claude',
  'sessionKind.codex': 'Codex',

  'status.running': 'Running',
  'status.done': 'Done',
  'status.stopped': 'Click to restore',
  'status.creating': 'Starting…',
  'status.missing': 'Path missing',
  'status.error': 'Error',

  'terminal.emptyState': 'Select or start a session to see its terminal here.',
  'terminal.restartSession': 'Restart session',
  'terminal.bypassWarning': 'Permissions and sandbox bypass enabled',
  'terminal.bypassTooltip':
    'This agent runs with its fixed bypass flag (--dangerously-skip-permissions / --dangerously-bypass-approvals-and-sandbox): it edits files and runs commands without asking for confirmation.',

  'notice.genericError': 'Something went wrong.',
  'notice.dirtyWorktree': 'Worktree has {count} changed files. Commit or discard them before deleting.',

  'settings.title': 'Settings',
  'settings.close': 'Close settings',
  'settings.launchAtLogin': 'Launch at startup',
  'settings.launchAtLoginFailed': 'Could not change the startup setting: {reason}',
  'settings.sessionKinds': 'Session kinds',
  'settings.sessionKindsHint':
    'A kind that is turned off disappears from the New session menu. New worktree adds a second entry for that kind which runs the session in its own Git worktree and branch.',
  'settings.columnEnabled': 'Enabled',
  'settings.columnWorktree': 'New worktree',
  'settings.enableKind': 'Enable {kind}',
  'settings.worktreeForKind': 'New worktree for {kind}',
  'settings.appearance': 'Appearance',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.language': 'Language',
  'settings.version': 'Version',
  'settings.versionUnknown': 'Unknown',
  'settings.checkForUpdates': 'Check for updates',
  'settings.checking': 'Checking for updates…',
  'settings.upToDate': 'CodeFly is up to date.',
  'settings.updateAvailable': 'Version {version} is available.',
  'settings.updateNoReleases': 'No release has been published yet.',
  'settings.updateFailed': 'Could not check for updates: {reason}',
  'settings.about': 'About CodeFly',
  'settings.linkRepository': 'Project repository',
  'settings.linkChangelog': 'Changelog',
  'settings.linkDownload': 'Downloads',
  'settings.openExternalHint': 'Opens in your browser'
} as const
