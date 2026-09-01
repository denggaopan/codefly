export type ExternalLinkTarget = 'repository' | 'changelog' | 'download'

// The renderer never sends a URL, only one of these keys: the main process resolves it
// against this table so shell.openExternal can only ever receive a URL that ships in the app.
export const EXTERNAL_LINKS: Readonly<Record<ExternalLinkTarget, string>> = {
  repository: 'https://github.com/denggaopan/codefly',
  changelog: 'https://github.com/denggaopan/codefly/releases',
  download: 'https://github.com/denggaopan/codefly/releases/latest'
}
