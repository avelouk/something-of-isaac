/**
 * Shared scaffold for everything rendered into #modal-root: backdrop with
 * click-to-close, panel, optional ✕ button, Escape-to-close, and listener
 * cleanup on dismiss. Callers append their content to `modal` and call
 * `dismiss()` to close programmatically.
 */

export type ModalHandle = {
  modal: HTMLDivElement;
  dismiss: () => void;
};

/** The currently open modal's dismiss, so opening a new one cleans the old up fully. */
let dismissCurrent: (() => void) | null = null;

export function openModal(
  opts: {
    /** Panel class; default "modal". */
    className?: string;
    /** Render the ✕ button; default true. */
    closeButton?: boolean;
    /** Extra cleanup (timers etc.) run once on dismiss, before the DOM is cleared. */
    onClose?: () => void;
  } = {},
): ModalHandle {
  const root = document.getElementById("modal-root");
  if (!root) throw new Error("missing #modal-root");
  dismissCurrent?.();

  let closed = false;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    if (dismissCurrent === dismiss) dismissCurrent = null;
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
    root.replaceChildren();
  };
  dismissCurrent = dismiss;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  document.addEventListener("keydown", onKey);

  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.addEventListener("click", dismiss);

  const modal = document.createElement("div");
  modal.className = opts.className ?? "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  if (opts.closeButton !== false) {
    const close = document.createElement("button");
    close.className = "modal-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", dismiss);
    modal.appendChild(close);
  }

  bg.appendChild(modal);
  root.appendChild(bg);
  return { modal, dismiss };
}
