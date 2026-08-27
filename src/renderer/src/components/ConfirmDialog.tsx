import { useEffect, useRef } from 'react'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Generic accessible confirmation modal, reserved for destructive actions per the design
 * spec (routine errors use inline notices instead). Renders nothing when `open` is false.
 *
 * Focus safety for destructive confirmations: Cancel (not Confirm) gets initial focus, so a
 * stray Enter right after opening never fires the destructive action. Escape cancels, and a
 * minimal two-element focus trap keeps Tab/Shift+Tab cycling between Cancel and Confirm
 * rather than escaping to the page behind the backdrop.
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }

      if (event.key !== 'Tab') return
      const first = cancelRef.current
      const last = confirmRef.current
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="confirm-dialog-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? 'confirm-dialog-description' : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog-title">
          {title}
        </h2>
        {description && (
          <p id="confirm-dialog-description" className="confirm-dialog-description">
            {description}
          </p>
        )}
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="confirm-dialog-cancel" onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={destructive ? 'confirm-dialog-confirm confirm-dialog-confirm--destructive' : 'confirm-dialog-confirm'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
