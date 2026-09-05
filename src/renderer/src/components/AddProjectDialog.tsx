import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cloneDirectoryName } from '../../../shared/git-clone'
import { normalizeProjectPath } from '../../../shared/project-path'
import closeIconUrl from '../assets/close.svg'
import { useTranslation } from '../i18n/use-translation'
import { useAppStore } from '../store/use-app-store'

type Mode = 'folder' | 'recent' | 'clone'

export default function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const appState = useAppStore((state) => state.appState)
  const platform = useAppStore((state) => state.platform)
  const addProject = useAppStore((state) => state.addProject)
  const [mode, setMode] = useState<Mode>('folder')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [targetDirectory, setTargetDirectory] = useState('')
  const [busy, setBusy] = useState<Mode | 'directory' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    panel.current?.querySelector<HTMLButtonElement>('[data-mode]')?.focus()
    return () => {
      if (root) root.inert = wasInert
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])

  useEffect(() => {
    if (busy) panel.current?.focus()
  }, [busy])

  const recentProjects = (appState.recentProjects ?? []).filter((recent) => !appState.projects.some((project) =>
    project.id === recent.id || normalizeProjectPath(project.path, platform) === normalizeProjectPath(recent.path, platform)))
  const directoryName = cloneDirectoryName(repositoryUrl)
  const destination = targetDirectory && directoryName
    ? `${targetDirectory.replace(/[\\/]+$/u, '')}${platform === 'win32' ? '\\' : '/'}${directoryName}`
    : null

  const run = async (operation: () => Promise<boolean>, activity: typeof busy): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(activity)
    setError(null)
    try {
      if (await operation()) onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('notice.genericError'))
    } finally {
      pending.current = false
      setBusy(null)
    }
  }

  const close = (): void => {
    if (!pending.current) onClose()
  }

  return createPortal(
    <div className="settings-dialog-backdrop" onClick={close}>
      <div
        ref={panel}
        className="settings-dialog add-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
          if (event.key !== 'Tab') return
          const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])
          const first = focusable[0]
          const last = focusable.at(-1)
          if (!first || !last) {
            event.preventDefault()
            panel.current?.focus()
          } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="settings-dialog-header">
          <h2 id="add-project-title" className="settings-dialog-title">{t('sidebar.addProject')}</h2>
          <button type="button" className="settings-dialog-close" aria-label={t('addProject.close')} disabled={busy !== null} onClick={close}>
            <img src={closeIconUrl} alt="" width={14} height={14} className="icon-mono" />
          </button>
        </div>
        <div className="add-project-modes" role="group" aria-label={t('addProject.source')}>
          {(['folder', 'recent', 'clone'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              data-mode={entry}
              aria-pressed={mode === entry}
              disabled={busy !== null}
              onClick={() => { setMode(entry); setError(null) }}
            >
              {t(`addProject.${entry}`)}
            </button>
          ))}
        </div>

        {mode === 'folder' && (
          <div className="add-project-section">
            <p className="add-project-hint">{t('addProject.folderHint')}</p>
            <button type="button" className="add-project-primary" disabled={busy !== null} onClick={() => void run(() => addProject(), 'folder')}>
              {t('addProject.chooseFolder')}
            </button>
          </div>
        )}

        {mode === 'recent' && (
          <div className="add-project-section">
            <p className="add-project-hint">{t('addProject.recentHint')}</p>
            {recentProjects.length === 0 ? <p className="add-project-empty">{t('addProject.noRecent')}</p> : (
              <ul className="add-project-recent-list">
                {recentProjects.map((project) => (
                  <li key={project.id}>
                    <button type="button" disabled={busy !== null} onClick={() => void run(() => addProject({ recentProjectId: project.id }), 'recent')}>
                      <span>{project.name}</span>
                      <span className="add-project-path" title={project.path}>{project.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === 'clone' && (
          <form className="add-project-section" onSubmit={(event) => {
            event.preventDefault()
            if (directoryName && targetDirectory) void run(() => addProject({ repositoryUrl: repositoryUrl.trim(), targetDirectory }), 'clone')
          }}>
            <label className="add-project-field" htmlFor="clone-repository-url">
              {t('addProject.repositoryUrl')}
              <input
                id="clone-repository-url"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repository.git"
                disabled={busy !== null}
                required
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!repositoryUrl.trim() && !directoryName}
                aria-describedby="clone-url-hint"
              />
            </label>
            <p id="clone-url-hint" className="add-project-hint">
              {t(repositoryUrl.trim() && !directoryName ? 'addProject.invalidUrl' : 'addProject.urlHint')}
            </p>
            <label className="add-project-field" htmlFor="clone-target-directory">
              {t('addProject.targetDirectory')}
            </label>
            <div className="add-project-directory">
              <input id="clone-target-directory" value={targetDirectory} readOnly placeholder={t('addProject.directoryPlaceholder')} title={targetDirectory} />
              <button type="button" className="settings-update-button" disabled={busy !== null} onClick={() => void run(async () => {
                const selected = await window.codefly.selectCloneDirectory()
                if (selected) setTargetDirectory(selected)
                return false
              }, 'directory')}>
                {t('addProject.browse')}
              </button>
            </div>
            <p className="add-project-hint">{t('addProject.cloneHint')}</p>
            {destination && <p className="add-project-destination">{t('addProject.destination', { path: destination })}</p>}
            <button type="submit" className="add-project-primary" disabled={busy !== null || !directoryName || !targetDirectory}>
              {t('addProject.cloneAction')}
            </button>
          </form>
        )}

        {busy && <p role="status" className="add-project-progress">{t(busy === 'clone' ? 'addProject.cloning' : 'addProject.opening')}</p>}
        {error && <p role="alert" className="settings-dialog-error add-project-error">{t('addProject.failed', { reason: error })}</p>}
      </div>
    </div>,
    document.body
  )
}
