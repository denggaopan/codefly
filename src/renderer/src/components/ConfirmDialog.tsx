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
          <button type="button" className="confirm-dialog-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'confirm-dialog-confirm confirm-dialog-confirm--destructive' : 'confirm-dialog-confirm'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
