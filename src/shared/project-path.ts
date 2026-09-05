export const normalizeProjectPath = (value: string, platform: string): string => {
  if (platform !== 'win32') return value.replace(/\/+$/u, '') || '/'
  const withWindowsSeparators = value.replace(/\//g, '\\')
  return (withWindowsSeparators.replace(/\\+$/u, '') || withWindowsSeparators).toLocaleLowerCase('en-US')
}
