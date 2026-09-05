// Shared by the form and main process so the destination preview matches the clone.
export function cloneDirectoryName(repositoryUrl: string): string | undefined {
  const value = repositoryUrl.trim()
  if (!value || /[\s\u0000-\u001f\u007f]/u.test(value)) return undefined
  let path: string
  if (/^(https?|ssh|git):\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if (!url.hostname || url.search || url.hash) return undefined
      path = url.pathname
    } catch {
      return undefined
    }
  } else {
    const scp = /^(?:[\w.-]+@)?[\w][\w.-]*:(?!:|\/\/)(.+)$/u.exec(value)
    if (!scp || /^[a-z]:/iu.test(value)) return undefined
    path = scp[1]!
  }
  let name: string
  try {
    name = decodeURIComponent(path.replace(/\/+$/u, '').split('/').at(-1) ?? '').replace(/\.git$/iu, '')
  } catch {
    return undefined
  }
  if (!name || name.startsWith('-') || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(name) || /[. ]$/u.test(name)) return undefined
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)) return undefined
  return name
}
