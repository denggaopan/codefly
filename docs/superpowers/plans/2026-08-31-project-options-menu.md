# Project Options Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three project-row action buttons with one accessible options menu using the supplied vertical-dots SVG, without changing the existing action behavior.

**Architecture:** Keep the feature local to `ProjectSidebar`: a project ID controls the single open menu, refs coordinate focus between the trigger, menu, and existing `SessionLauncher`, and document/keyboard handlers implement dismissal. Reuse the existing store actions and capability state; add no new shared state or generic menu abstraction.

**Tech Stack:** React 19, TypeScript, Zustand, Testing Library, Vitest, CSS, Playwright/Electron

---

## File Map

- Create `src/renderer/src/assets/options.svg`: bundled vertical-dots icon copied byte-for-byte from the user-provided source.
- Modify `src/renderer/src/components/ProjectSidebar.tsx`: controlled menu state, action markup, dismissal, keyboard navigation, and focus restoration.
- Modify `src/renderer/src/components/ProjectSidebar.test.tsx`: component contract, action behavior, disabled state, keyboard behavior, dismissal, and focus regression coverage.
- Modify `src/renderer/src/styles.css`: compact themed menu and minimum-width-safe positioning.
- Modify `e2e/codefly.spec.ts`: drive all three actions through the menu and verify theme and viewport behavior.
- Modify `README.md`: describe the options-menu location of the existing VS Code and Explorer actions.

### Task 1: Add the options-menu shell and preserve all three actions

**Files:**
- Create: `src/renderer/src/assets/options.svg`
- Modify: `src/renderer/src/components/ProjectSidebar.tsx`
- Test: `src/renderer/src/components/ProjectSidebar.test.tsx`

- [ ] **Step 1: Add a component-test helper and replace the direct-action assertions with a failing menu contract**

Add this helper after `beforeEach`:

```tsx
const projectOptionsName = (projectName: string): string => `Project options for ${projectName}`

const openProjectOptions = async (
  user: ReturnType<typeof userEvent.setup>,
  projectName = project1.name
): Promise<HTMLElement> => {
  await user.click(screen.getByRole('button', { name: projectOptionsName(projectName) }))
  return screen.getByRole('menu', { name: projectOptionsName(projectName) })
}
```

Replace the old action-order and session-icon tests with:

```tsx
it('collapses the three project actions into one labelled options menu', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument()

  const menu = await openProjectOptions(user)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
    'New session',
    'Open project in VS Code',
    'Open project folder'
  ])

  await user.click(trigger)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

it('renders the supplied options SVG as a decorative trigger icon', () => {
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
  const icon = trigger.querySelector('img.icon-options') as HTMLImageElement | null
  expect(icon).not.toBeNull()
  expect(icon).toHaveAttribute('src')
  expect(icon).toHaveAttribute('alt', '')
})
```

Update the VS Code and folder action tests so each opens the menu before selecting the action:

```tsx
it('does not toggle the project row or restore a session when opening VS Code', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
  render(<ProjectSidebar />)

  const menu = await openProjectOptions(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Open project in VS Code' }))

  expect(api.openProjectInVSCode).toHaveBeenCalledWith('project-1')
  expect(api.restoreSession).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeProjectId).toBeNull()
  expect(screen.getByText(stoppedSession.title)).toBeInTheDocument()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('does not toggle the project row or restore a session when opening the folder', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [stoppedSession] })
  render(<ProjectSidebar />)

  const menu = await openProjectOptions(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Open project folder' }))

  expect(api.openProjectFolder).toHaveBeenCalledWith('project-1')
  expect(api.restoreSession).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeProjectId).toBeNull()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
```

Replace the unavailable-VS-Code and bundled-icon tests with these async menu-aware versions:

```tsx
it('disables the VS Code menu item when unavailable and exposes the reason as a tooltip', async () => {
  const user = userEvent.setup()
  seedStore(
    { version: 1, projects: [project1], sessions: [] },
    {
      claude: { available: true, detail: '' },
      codex: { available: true, detail: '' },
      vscode: { available: false, detail: 'Install VS Code or the code command.' }
    }
  )
  render(<ProjectSidebar />)

  await openProjectOptions(user)
  const item = screen.getByRole('menuitem', { name: 'Open project in VS Code' })
  expect(item).toBeDisabled()
  expect(item).toHaveAttribute('title', 'Install VS Code or the code command.')
  await user.click(item)
  expect(api.openProjectInVSCode).not.toHaveBeenCalled()
  expect(screen.getByRole('menu')).toBeInTheDocument()
})

it('also associates the visible disabled-VS-Code reason with its menu item', async () => {
  const user = userEvent.setup()
  seedStore(
    { version: 1, projects: [project1], sessions: [] },
    {
      claude: { available: true, detail: '' },
      codex: { available: true, detail: '' },
      vscode: { available: false, detail: 'Install VS Code or the code command.' }
    }
  )
  render(<ProjectSidebar />)

  await openProjectOptions(user)
  const item = screen.getByRole('menuitem', { name: 'Open project in VS Code' })
  const hint = screen.getByText('Install VS Code or the code command.')
  expect(hint).toBeVisible()
  expect(item).toHaveAttribute('aria-describedby', hint.id)
})

it('renders the bundled VS Code SVG inside its menu item', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  await openProjectOptions(user)
  const item = screen.getByRole('menuitem', { name: 'Open project in VS Code' })
  const icon = item.querySelector('img.icon-vscode') as HTMLImageElement | null
  expect(icon).not.toBeNull()
  expect(icon).toHaveAttribute('src')
  expect(icon).toHaveAttribute('alt', '')
})

it('does not start project dragging from the options trigger or menu', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)
  const transfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' }

  fireEvent.dragStart(screen.getByRole('button', { name: projectOptionsName(project1.name) }), {
    dataTransfer: transfer
  })
  const menu = await openProjectOptions(user)
  fireEvent.dragStart(menu, { dataTransfer: transfer })

  expect(transfer.setData).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the focused test and confirm the new contract fails**

Run:

```powershell
npm test -- src/renderer/src/components/ProjectSidebar.test.tsx
```

Expected: FAIL because no button named `Project options for demo-project` exists.

- [ ] **Step 3: Copy the exact supplied icon into the renderer assets**

Run:

```powershell
Copy-Item -LiteralPath 'C:\Users\panndeng\Downloads\options.svg' -Destination 'src\renderer\src\assets\options.svg'
```

Verify:

```powershell
Get-FileHash -Algorithm SHA256 'C:\Users\panndeng\Downloads\options.svg','src\renderer\src\assets\options.svg'
```

Expected: both rows have the same SHA256 hash.

- [ ] **Step 4: Implement the controlled menu shell and reuse the existing actions**

Add the asset import beside the current icon imports:

```tsx
import optionsIconUrl from '../assets/options.svg'
import sessionIconUrl from '../assets/session.svg'
import vscodeIconUrl from '../assets/vscode.svg'
```

Add local state and a trigger ref beside `pendingDelete`:

```tsx
const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)
const [openOptionsProjectId, setOpenOptionsProjectId] = useState<string | null>(null)
const optionsTriggerRef = useRef<HTMLButtonElement | null>(null)
```

Replace the current three-button `.project-actions` block with this trigger and sibling menu. Keeping the menu as a sibling prevents the existing 24-by-24 action-button selector from affecting text menu items.

```tsx
<div className="project-actions" data-project-actions onDragStart={stopRowDrag}>
  <button
    type="button"
    className="project-options-trigger"
    aria-label={`Project options for ${project.name}`}
    aria-haspopup="menu"
    aria-expanded={openOptionsProjectId === project.id}
    onClick={(event) => {
      event.stopPropagation()
      optionsTriggerRef.current = event.currentTarget
      setOpenOptionsProjectId((current) => (current === project.id ? null : project.id))
    }}
  >
    <img src={optionsIconUrl} alt="" width={16} height={16} className="icon icon-options" />
  </button>
</div>
{openOptionsProjectId === project.id && (
  <div
    className="project-options-menu"
    role="menu"
    aria-label={`Project options for ${project.name}`}
    onClick={(event) => event.stopPropagation()}
    onDragStart={stopRowDrag}
  >
    <button
      type="button"
      className="project-options-menu-item"
      role="menuitem"
      onClick={() => {
        launcherTriggerRef.current = optionsTriggerRef.current
        setOpenOptionsProjectId(null)
        setActiveProject(project.id)
        openLauncher()
      }}
    >
      <img src={sessionIconUrl} alt="" width={16} height={16} className="icon icon-session" />
      <span>New session</span>
    </button>
    <button
      type="button"
      className="project-options-menu-item"
      role="menuitem"
      title={capabilities.vscode.available ? undefined : capabilities.vscode.detail}
      aria-describedby={capabilities.vscode.available ? undefined : vscodeHintId(project.id)}
      disabled={!capabilities.vscode.available}
      onClick={() => {
        setOpenOptionsProjectId(null)
        void openProjectInVSCode(project.id)
      }}
    >
      <img src={vscodeIconUrl} alt="" width={16} height={16} className="icon icon-vscode" />
      <span>Open project in VS Code</span>
    </button>
    <button
      type="button"
      className="project-options-menu-item"
      role="menuitem"
      onClick={() => {
        setOpenOptionsProjectId(null)
        void openProjectFolder(project.id)
      }}
    >
      <FolderGlyph />
      <span>Open project folder</span>
    </button>
  </div>
)}
```

Update the nearby comments so they describe the new structure exactly:

```tsx
// Focus restoration for the launcher: the project options trigger that opened it gets
// keyboard/screen-reader focus back when the launcher closes.

// Project drag-reordering: the whole project row is the drag handle (the options trigger,
// menu, and launcher are excluded via stopRowDrag).

// The selectable project label and options trigger are sibling buttons; the menu and
// launcher are sibling popovers, so no interactive control is nested inside another.
```

- [ ] **Step 5: Run the focused test and typecheck**

Run:

```powershell
npm test -- src/renderer/src/components/ProjectSidebar.test.tsx
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the menu shell**

```powershell
git add src/renderer/src/assets/options.svg src/renderer/src/components/ProjectSidebar.tsx src/renderer/src/components/ProjectSidebar.test.tsx
git commit -m "feat: collapse project actions into options menu"
```

### Task 2: Add dismissal, keyboard navigation, and focus restoration

**Files:**
- Modify: `src/renderer/src/components/ProjectSidebar.tsx`
- Test: `src/renderer/src/components/ProjectSidebar.test.tsx`

- [ ] **Step 1: Add failing tests for focus, keyboard navigation, dismissal, and launcher restoration**

Add `act` to the Testing Library import:

```tsx
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
```

Add these tests:

```tsx
it('focuses the first enabled menu item and supports wrapping keyboard navigation', async () => {
  const user = userEvent.setup()
  seedStore(
    { version: 1, projects: [project1], sessions: [] },
    {
      claude: { available: true, detail: '' },
      codex: { available: true, detail: '' },
      vscode: { available: false, detail: 'Install VS Code or the code command.' }
    }
  )
  render(<ProjectSidebar />)

  const menu = await openProjectOptions(user)
  const newSession = within(menu).getByRole('menuitem', { name: 'New session' })
  const folder = within(menu).getByRole('menuitem', { name: 'Open project folder' })
  expect(newSession).toHaveFocus()

  await user.keyboard('{ArrowDown}')
  expect(folder).toHaveFocus()
  await user.keyboard('{ArrowDown}')
  expect(newSession).toHaveFocus()
  await user.keyboard('{End}')
  expect(folder).toHaveFocus()
  await user.keyboard('{Home}')
  expect(newSession).toHaveFocus()
  await user.keyboard('{ArrowUp}')
  expect(folder).toHaveFocus()
})

it('closes on Escape and restores focus to the options trigger', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
  await openProjectOptions(user)
  await user.keyboard('{Escape}')

  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('closes on outside click and Tab without stealing the destination focus', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  await openProjectOptions(user)
  const search = screen.getByRole('searchbox', { name: 'Search sessions' })
  await user.click(search)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(search).toHaveFocus()

  await openProjectOptions(user)
  await user.tab()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('keeps only one project menu open and clears stale state when a project disappears', async () => {
  const user = userEvent.setup()
  const project2: ProjectRecord = {
    id: 'project-2',
    name: 'second-project',
    path: 'C:\\work\\second',
    createdAt: '2026-08-21T00:00:00.000Z'
  }
  const state = { version: 1 as const, projects: [project1, project2], sessions: [] }
  seedStore(state)
  render(<ProjectSidebar />)

  await openProjectOptions(user, project1.name)
  await openProjectOptions(user, project2.name)
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  expect(screen.getByRole('menu', { name: projectOptionsName(project2.name) })).toBeInTheDocument()

  act(() => useAppStore.setState({ appState: { ...state, projects: [project1] } }))
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  act(() => useAppStore.setState({ appState: state }))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('returns focus to the options trigger after a folder action and after closing the launcher', async () => {
  const user = userEvent.setup()
  seedStore({ version: 1, projects: [project1], sessions: [] })
  render(<ProjectSidebar />)

  const trigger = screen.getByRole('button', { name: projectOptionsName(project1.name) })
  let menu = await openProjectOptions(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'Open project folder' }))
  expect(trigger).toHaveFocus()

  menu = await openProjectOptions(user)
  await user.click(within(menu).getByRole('menuitem', { name: 'New session' }))
  expect(screen.getByLabelText('Create session')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Close launcher' }))
  await waitFor(() => expect(trigger).toHaveFocus())
})
```

- [ ] **Step 2: Run the focused test and confirm the accessibility cases fail**

Run:

```powershell
npm test -- src/renderer/src/components/ProjectSidebar.test.tsx
```

Expected: FAIL because opening does not focus a menu item and Escape/outside/keyboard handlers are absent.

- [ ] **Step 3: Implement menu lifecycle helpers and document dismissal**

Add a menu ref beside `optionsTriggerRef`:

```tsx
const optionsTriggerRef = useRef<HTMLButtonElement | null>(null)
const optionsMenuRef = useRef<HTMLDivElement | null>(null)
```

Add these helpers and effects before the drag handlers:

```tsx
const closeProjectOptions = (restoreFocus = false): void => {
  if (restoreFocus) optionsTriggerRef.current?.focus()
  setOpenOptionsProjectId(null)
}

useEffect(() => {
  if (!openOptionsProjectId) return

  optionsMenuRef.current
    ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    ?.focus()

  const handlePointerDown = (event: PointerEvent): void => {
    const target = event.target
    if (!(target instanceof Node)) return
    if (optionsMenuRef.current?.contains(target) || optionsTriggerRef.current?.contains(target)) return
    setOpenOptionsProjectId(null)
  }

  document.addEventListener('pointerdown', handlePointerDown)
  return () => document.removeEventListener('pointerdown', handlePointerDown)
}, [openOptionsProjectId])

useEffect(() => {
  if (openOptionsProjectId && !appState.projects.some((project) => project.id === openOptionsProjectId)) {
    setOpenOptionsProjectId(null)
  }
}, [appState.projects, openOptionsProjectId])

const handleOptionsMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeProjectOptions(true)
    return
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
  )
  if (items.length === 0) return

  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
  let nextIndex: number | null = null
  if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length
  if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = items.length - 1
  if (nextIndex === null) return

  event.preventDefault()
  items[nextIndex]?.focus()
}

const handleOptionsMenuBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
  const nextTarget = event.relatedTarget
  if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
    setOpenOptionsProjectId(null)
  }
}
```

Update the menu element and all three items:

```tsx
<div
  ref={optionsMenuRef}
  className="project-options-menu"
  role="menu"
  aria-label={`Project options for ${project.name}`}
  onClick={(event) => event.stopPropagation()}
  onDragStart={stopRowDrag}
  onKeyDown={handleOptionsMenuKeyDown}
  onBlur={handleOptionsMenuBlur}
>
```

Add `tabIndex={-1}` to every `role="menuitem"` button. Replace the VS Code and folder `setOpenOptionsProjectId(null)` calls with `closeProjectOptions(true)`. Keep the New session path using `setOpenOptionsProjectId(null)` so focus remains available to `SessionLauncher`; `launcherTriggerRef.current = optionsTriggerRef.current` restores focus to the options button when that launcher closes.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```powershell
npm test -- src/renderer/src/components/ProjectSidebar.test.tsx
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 5: Commit keyboard and focus behavior**

```powershell
git add src/renderer/src/components/ProjectSidebar.tsx src/renderer/src/components/ProjectSidebar.test.tsx
git commit -m "feat: make project options menu keyboard accessible"
```

### Task 3: Style the menu and update the real Electron journey

**Files:**
- Modify: `src/renderer/src/styles.css`
- Modify: `e2e/codefly.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: Update the E2E helpers and flows before adding menu CSS**

Add these helpers after `sessionRowByKind`:

```ts
const projectOptionsTrigger = () => window.getByRole('button', { name: /^Project options for / })

const openProjectOptions = async () => {
  await projectOptionsTrigger().click()
  return window.getByRole('menu', { name: /^Project options for / })
}

const openNewSessionLauncher = async () => {
  const menu = await openProjectOptions()
  await menu.getByRole('menuitem', { name: 'New session' }).click()
  return window.locator('.session-launcher')
}
```

In every session-creation flow, replace:

```ts
await window.getByRole('button', { name: 'New session' }).click()
```

with:

```ts
await openNewSessionLauncher()
```

In the minimum-window test, replace the three direct-action visibility assertions and launcher opening with:

```ts
await expect(projectOptionsTrigger()).toBeVisible()
await expect(window.getByRole('button', { name: 'New session' })).toHaveCount(0)
await expect(window.locator('.terminal-pane:visible .terminal-instance-host')).toBeVisible()
await expect(visibleBypassWarnings()).toHaveText([BYPASS_WARNING_TEXT])

let menu = await openProjectOptions()
await expect(menu.getByRole('menuitem')).toHaveCount(3)
await expect(menu).toHaveCSS('position', 'absolute')
const darkBackground = await menu.evaluate((element) => getComputedStyle(element).backgroundColor)
const [menuBounds, viewport] = await Promise.all([
  menu.boundingBox(),
  window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
])
expect(menuBounds).not.toBeNull()
expect(menuBounds!.x).toBeGreaterThanOrEqual(0)
expect(menuBounds!.y).toBeGreaterThanOrEqual(0)
expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(viewport.width)
expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewport.height)

await window.keyboard.press('Escape')
await expect(menu).toHaveCount(0)
await expect(projectOptionsTrigger()).toBeFocused()

const settingsTrigger = window.getByRole('button', { name: 'Settings' })
await settingsTrigger.click()
await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Light' }).click()
await window.getByRole('button', { name: 'Close settings' }).click()
menu = await openProjectOptions()
const lightBackground = await menu.evaluate((element) => getComputedStyle(element).backgroundColor)
expect(lightBackground).not.toBe(darkBackground)
await window.keyboard.press('Escape')
await settingsTrigger.click()
await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Dark' }).click()
await window.getByRole('button', { name: 'Close settings' }).click()

const launcher = await openNewSessionLauncher()
```

Keep the existing launcher bounds assertions following the final line.

Replace the VS Code and Explorer clicks in their E2E regression test with:

```ts
let menu = await openProjectOptions()
await menu.getByRole('menuitem', { name: 'Open project in VS Code' }).click()
await expect(window.locator('.sidebar-notice')).toHaveCount(0)
await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)

menu = await openProjectOptions()
await menu.getByRole('menuitem', { name: 'Open project folder' }).click()
await expect(window.locator('.sidebar-notice')).toHaveCount(0)
await expect(window.locator('.session-row')).toHaveCount(sessionRowCount)
await expect(window.locator('.session-row-content[aria-current="true"] .session-kind-icon')).toHaveAttribute('data-kind', activeKindBefore!)
```

- [ ] **Step 2: Run the E2E journey and confirm the styling assertion fails**

Run:

```powershell
npm run test:e2e
```

Expected: FAIL at `toHaveCSS('position', 'absolute')` because `.project-options-menu` has no CSS yet.

- [ ] **Step 3: Add compact, theme-token-based menu styles**

Add these rules after `.project-actions button:disabled`:

```css
.project-options-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 8px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  width: 220px;
  max-width: calc(100% - 16px);
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.icon-options {
  opacity: 0.7;
  filter: invert(1);
}

:root[data-theme='light'] .icon-options {
  filter: none;
}

.project-options-trigger:hover .icon-options,
.project-options-trigger[aria-expanded='true'] .icon-options {
  opacity: 1;
}

.project-options-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text);
  font-size: 0.8rem;
  text-align: left;
}

.project-options-menu-item .icon {
  flex: 0 0 auto;
}

.project-options-menu-item:not(:disabled):hover,
.project-options-menu-item:not(:disabled):focus-visible {
  background: var(--color-panel-elevated);
}

.project-options-menu-item:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
  opacity: 0.5;
}
```

Update the `.project-row` positioning comment to mention both anchored popovers:

```css
/* Anchors the project options and session-launcher popovers below this row. */
```

- [ ] **Step 4: Update the README wording**

Replace the first paragraph under `## Visual Studio Code and File Explorer` with:

```markdown
A project's options menu contains its Visual Studio Code and folder actions. Both always
open the project's **original, user-selected directory** — never a session's worktree — and
never change which session is active or expand/collapse the row. Visual Studio Code is
discovered via the `code` command on `PATH`, then the standard per-user and machine-wide
install locations; if none is found, the menu item is disabled with an install hint. The
folder action opens the directory in Windows File Explorer via `shell.openPath` and has no
such dependency.
```

Also replace the optional prerequisite sentence with:

```markdown
- Optional: [Visual Studio Code](https://code.visualstudio.com/) (or its `code` command on
  `PATH`) to use “Open project in VS Code” from a project's options menu.
```

- [ ] **Step 5: Run component, type, build, and E2E verification**

Run:

```powershell
npm test -- src/renderer/src/components/ProjectSidebar.test.tsx
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all commands PASS; the E2E menu stays inside the 900-by-600 viewport and reports different token-derived backgrounds in dark and light themes.

- [ ] **Step 6: Commit styling, documentation, and E2E coverage**

```powershell
git add src/renderer/src/styles.css e2e/codefly.spec.ts README.md
git commit -m "test: cover project options menu journey"
```

### Task 4: Run final regression verification

**Files:**
- Verify only; no expected file changes.

- [ ] **Step 1: Run the entire unit and component suite**

Run:

```powershell
npm test
```

Expected: all Vitest files and tests PASS.

- [ ] **Step 2: Run the production build and full Electron E2E suite from a clean build**

Run:

```powershell
npm run test:e2e
```

Expected: the production build succeeds and all Playwright/Electron tests PASS.

- [ ] **Step 3: Confirm only intended commits and no uncommitted files remain**

Run:

```powershell
git status --short
git log -4 --oneline
```

Expected: `git status --short` prints nothing; the log shows the menu-shell, accessibility, and E2E/style commits after the plan commit.
