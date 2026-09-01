import { useEffect } from 'react'

import ProjectSidebar from './components/ProjectSidebar'
import TerminalWorkspace from './components/TerminalWorkspace'
import TitleBar from './components/TitleBar'
import UpdateDialog from './components/UpdateDialog'
import { useAppStore } from './store/use-app-store'

export default function App() {
  useEffect(() => {
    const dispose = useAppStore.getState().initialize()
    return dispose
  }, [])

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <ProjectSidebar />
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
