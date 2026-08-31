# Settings Dialog Interaction Fix Design

## Problem

The Settings dialog opens from the custom title bar, but mouse clicks cannot close it or select the Dark and Light controls in Electron. The existing jsdom test passes because jsdom does not implement Electron's draggable-region behavior.

The dialog is currently rendered beneath `.title-bar`, which declares `-webkit-app-region: drag`. Only the settings trigger is excluded with `no-drag`, so Electron treats the dialog descendants as part of the draggable region and consumes their pointer input.

## Requirements

- The close button, backdrop click, and Escape key must each close Settings.
- Dark and Light must switch the theme immediately.
- The selected theme must continue to persist across restarts.
- The dialog's current appearance and the existing theme data flow must remain unchanged.

## Design

`SettingsDialog` will render its backdrop and panel through a React portal attached to `document.body`. Its `open` and `onClose` API remains unchanged, and `TitleBar` continues to own the open state.

The portal places the modal outside the title bar's draggable DOM subtree. This fixes the interaction at the structural boundary instead of relying on a `no-drag` CSS override that could regress when title-bar styles or nesting change.

Theme selection continues through `useAppStore.setTheme`. That existing path updates store state, stamps `html[data-theme]`, writes `localStorage`, notifies the main process, and updates live terminals. No main-process, preload, IPC, or persistence changes are needed.

## Interaction Flow

1. The settings trigger sets the title bar's local `settingsOpen` state to `true`.
2. `SettingsDialog` portals the modal into `document.body`.
3. Selecting Dark or Light calls the existing store action and leaves the dialog open.
4. The close button, backdrop, or Escape invokes `onClose` and unmounts the portal content.

## Testing

- Renderer tests will cover Dark and Light selection plus all three close paths.
- A Playwright Electron test will open Settings, click a theme control, verify the active theme, and exercise mouse-based closing. This protects the Electron-specific draggable-region boundary that jsdom cannot simulate.
- The focused renderer test, full unit suite, typecheck, build, and Electron E2E suite will run before completion.

## Non-Goals

- Redesigning the Settings dialog.
- Changing theme colors, storage format, or startup behavior.
- Refactoring other dialogs or title-bar state ownership.
