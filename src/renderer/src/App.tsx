import { useEffect } from 'react'

import ProjectSidebar from './components/ProjectSidebar'
import TerminalWorkspace from './components/TerminalWorkspace'
import TitleBar from './components/TitleBar'
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
    </div>
  )
}
