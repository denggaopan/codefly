# Settings Dialog Interaction Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore all Settings dialog close controls and Dark/Light selection in the real Electron window while preserving the current theme behavior and appearance.

**Architecture:** Keep `TitleBar` as the owner of the dialog's open state, but have `SettingsDialog` portal its modal DOM into `document.body` so it is outside `.title-bar`'s Electron drag region. Guard the structural boundary in jsdom and the actual pointer behavior in a Playwright-driven Electron test.

**Tech Stack:** React 19, TypeScript, React DOM portals, Testing Library, Vitest, Playwright Electron.

---

## File Structure

- Modify `src/renderer/src/App.test.tsx`: assert that Settings is outside the draggable title bar and cover backdrop/Escape closing in renderer tests.
- Modify `e2e/codefly.spec.ts`: exercise theme selection and all three close paths in a real Electron window.
- Modify `src/renderer/src/components/SettingsDialog.tsx`: portal the existing modal markup to `document.body` without changing its public API or theme data flow.

### Task 1: Add Renderer and Electron Regression Coverage

**Files:**
- Modify: `src/renderer/src/App.test.tsx:486`
- Modify: `e2e/codefly.spec.ts:107`
- Test: `src/renderer/src/App.test.tsx`
- Test: `e2e/codefly.spec.ts`

- [ ] **Step 1: Make the renderer test expose the draggable-region nesting bug**

Add the structural assertion immediately after the existing dialog assertion in `opens Settings from the title bar and switches between light and dark themes`:

```tsx
const dialog = await screen.findByRole('dialog', { name: 'Settings' })
expect(dialog).toBeInTheDocument()
expect(dialog.closest('.title-bar')).toBeNull()
```

This fails before the fix because `SettingsDialog` currently renders as a descendant of `.title-bar`.

- [ ] **Step 2: Add renderer coverage for backdrop and Escape closing**

Add this test after the existing theme-switching test. The existing test already covers the close button.

```tsx
it('closes Settings from the backdrop and Escape', async () => {
  const user = userEvent.setup()
  render(<App />)

  const trigger = screen.getByRole('button', { name: 'Settings' })
  await user.click(trigger)

  const backdrop = document.querySelector('.settings-dialog-backdrop')
  expect(backdrop).not.toBeNull()
  await user.click(backdrop!)
  expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()

  await user.click(trigger)
  await screen.findByRole('dialog', { name: 'Settings' })
  await user.keyboard('{Escape}')

  expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run the focused renderer test and verify RED**

Run:

```powershell
npx vitest run src/renderer/src/App.test.tsx -t "opens Settings from the title bar and switches between light and dark themes"
```

Expected: FAIL because `dialog.closest('.title-bar')` returns the title-bar element instead of `null`. The failure must come from the new structural assertion, not setup or TypeScript errors.

- [ ] **Step 4: Add the real Electron interaction regression**

Insert this test before `adds the fixture project and creates a Claude session as the first worktree` so it does not depend on project/session state. Restore dark theme at the end because the E2E file is a shared serial journey.

```ts
test('keeps Settings interactive outside the draggable title bar', async () => {
  const trigger = window.getByRole('button', { name: 'Settings' })
  const dialog = window.getByRole('dialog', { name: 'Settings' })

  await trigger.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Light' }).click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(dialog.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')

  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await expect(dialog).toBeVisible()
  await window.locator('.settings-dialog-backdrop').click({ position: { x: 8, y: 8 } })
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await expect(dialog).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await trigger.click()
  await dialog.getByRole('button', { name: 'Dark' }).click()
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark')
  await window.keyboard.press('Escape')
})
```

- [ ] **Step 5: Build and run the focused Electron test to verify RED**

Run:

```powershell
npm run build
npx playwright test -g "keeps Settings interactive outside the draggable title bar"
```

Expected: Preferably FAIL when Playwright attempts a mouse action inside the dialog or the light-theme assertion remains dark. Some Playwright Electron environments may synthesize input without reproducing native Windows drag-region interception; if it passes, record that limitation and treat the renderer's failing structural assertion as the authoritative RED evidence.

### Task 2: Portal Settings Outside the Drag Region

**Files:**
- Modify: `src/renderer/src/components/SettingsDialog.tsx:1`
- Test: `src/renderer/src/App.test.tsx`
- Test: `e2e/codefly.spec.ts`

- [ ] **Step 1: Import the React portal API**

Add this import beside the React hook import:

```tsx
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
```

- [ ] **Step 2: Portal the existing modal markup to `document.body`**

Keep the current `if (!open) return null` guard, callbacks, roles, labels, and button markup. Replace the direct JSX return with this portal wrapper:

```tsx
return createPortal(
  <div className="settings-dialog-backdrop" onClick={onClose}>
    <div
      className="settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="settings-dialog-header">
        <h2 id="settings-dialog-title" className="settings-dialog-title">
          Settings
        </h2>
        <button type="button" className="settings-dialog-close" aria-label="Close settings" onClick={onClose} autoFocus>
          ✕
        </button>
      </div>
      <div className="settings-dialog-section">
        <span className="settings-dialog-label" id="settings-appearance-label">
          Appearance
        </span>
        <div className="settings-theme-toggle" role="group" aria-labelledby="settings-appearance-label">
          <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
            Dark
          </button>
          <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
            Light
          </button>
        </div>
      </div>
    </div>
  </div>,
  document.body
)
```

Do not add `no-drag` CSS because the portal removes the draggable ancestor structurally.

- [ ] **Step 3: Run the focused renderer tests to verify GREEN**

Run:

```powershell
npx vitest run src/renderer/src/App.test.tsx -t "Settings"
```

Expected: PASS for the title-bar rendering, theme switching, portal boundary, both new close paths, and persisted-theme tests.

- [ ] **Step 4: Build and run the focused Electron regression to verify GREEN**

Run:

```powershell
npm run build
npx playwright test -g "keeps Settings interactive outside the draggable title bar"
```

Expected: PASS; Light becomes active, the close button and backdrop receive clicks, Escape closes the dialog, and Dark is restored.

- [ ] **Step 5: Commit the tested fix**

Run:

```powershell
git add src/renderer/src/App.test.tsx e2e/codefly.spec.ts src/renderer/src/components/SettingsDialog.tsx
git commit -m "fix: restore settings dialog interactions"
```

### Task 3: Run Full Verification

**Files:**
- Verify: `src/**/*.test.ts(x)`
- Verify: `e2e/codefly.spec.ts`

- [ ] **Step 1: Run the complete unit suite**

Run:

```powershell
npm test -- --run
```

Expected: all test files pass with zero failures.

- [ ] **Step 2: Run TypeScript checks**

Run:

```powershell
npm run typecheck
```

Expected: both node and web TypeScript projects exit successfully with no diagnostics.

- [ ] **Step 3: Run the complete Electron E2E suite**

Run:

```powershell
npm run test:e2e
```

Expected: the full serial Electron journey passes with zero failures, including the new Settings regression.

- [ ] **Step 4: Inspect the final repository state**

Run:

```powershell
git status --short --branch
git log --oneline -3
```

Expected: the implementation files are committed; only this implementation-plan document may remain uncommitted if it was not included in the documentation commit.
