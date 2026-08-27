import { useEffect } from 'react'

import AgentBypassStatus from './components/AgentBypassStatus'
import ProjectSidebar from './components/ProjectSidebar'
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
        {/* Task 12 replaces this placeholder with TerminalWorkspace, one xterm instance per session. */}
        <main className="app-main">
          <div className="terminal-slot" data-testid="terminal-slot">
            <p>Select or start a session to see its terminal here.</p>
          </div>
          <AgentBypassStatus />
        </main>
      </div>
    </div>
  )
}
