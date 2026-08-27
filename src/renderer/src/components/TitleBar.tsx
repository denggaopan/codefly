/**
 * Top window chrome: just the CodeFly brand. Session navigation lives in the sidebar's
 * session rows, and session creation on each project row's "New session" (+) action.
 * (Revised 2026-08-27: the open-session tabs and the global plus button were removed.)
 */
export default function TitleBar() {
  return (
    <header className="title-bar">
      <div className="title-bar-brand">CodeFly</div>
    </header>
  )
}
