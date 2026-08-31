export const IPC = {
  snapshotGet: 'snapshot:get',
  projectAdd: 'project:add',
  projectReorder: 'project:reorder',
  projectOpenVSCode: 'project:open-vscode',
  projectOpenFolder: 'project:open-folder',
  sessionCreate: 'session:create',
  sessionRestore: 'session:restore',
  sessionDelete: 'session:delete',
  sessionFirstInput: 'session:first-input',
  themeSet: 'theme:set',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  stateChanged: 'state:changed',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const
