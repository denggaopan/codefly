import { useEffect, type CSSProperties } from 'react'

import ProjectSidebar from './components/ProjectSidebar'
import SidebarResizer from './components/SidebarResizer'
import TerminalWorkspace from './components/TerminalWorkspace'
import TitleBar from './components/TitleBar'
import UpdateDialog from './components/UpdateDialog'
import { useAppStore } from './store/use-app-store'

export default function App() {
  const sidebarWidth = useAppStore((state) => state.sidebarWidth)

  useEffect(() => {
    const dispose = useAppStore.getState().initialize()
    return dispose
  }, [])

  // The persisted width feeds the layout through the same CSS token the stylesheet has always
  // used, so .app-body's grid and the sidebar stay defined in one place (styles.css) and the
  // stylesheet's clamp() still guards the workspace when the window is later made narrower.
  const bodyStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body" style={bodyStyle}>
        <ProjectSidebar />
        <SidebarResizer />
        <main className="app-main">
          <TerminalWorkspace />
        </main>
      </div>
      {/* Portals to document.body, and stays idle (renders nothing) unless an update is
          actually pending — see the app store's `updater` state. */}
      <UpdateDialog />
    </div>
  )
}
