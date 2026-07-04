/**
 * "Report a problem" modal — one textarea, POSTs to the worker's /feedback,
 * which forwards to Telegram. No worker URL configured = the modal still opens
 * but sending fails gracefully.
 */

/** Keep in sync with MESSAGE_MAX_CHARS in worker/src/feedback.ts (server-side reject). */
const MESSAGE_MAX_CHARS = 1000;

export function showFeedbackModal(workerBaseUrl: string | undefined, puzzleNumber: number): void {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.replaceChildren();

  const dismiss = () => root.replaceChildren();

  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.addEventListener("click", dismiss);

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  const close = document.createElement("button");
  close.className = "modal-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", dismiss);
  modal.appendChild(close);

  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "REPORT A PROBLEM";
  modal.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "modal-sub";
  sub.textContent = "Wrong hint, bug, or anything else — it goes straight to the dev.";
  modal.appendChild(sub);

  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.maxLength = MESSAGE_MAX_CHARS;
  textarea.rows = 5;
  textarea.placeholder = "What went wrong?";
  modal.appendChild(textarea);

  const btns = document.createElement("div");
  btns.className = "modal-btns";

  const send = document.createElement("button");
  send.className = "btn btn-primary";
  send.textContent = "SEND";
  send.addEventListener("click", async () => {
    const message = textarea.value.trim();
    if (!message) return;
    send.disabled = true;
    send.textContent = "SENDING…";
    textarea.disabled = true;
    const ok = await sendFeedback(workerBaseUrl, message, puzzleNumber);
    if (ok) {
      send.textContent = "SENT ✓ THANKS";
      // Only auto-close if this modal is still the one on screen — the user
      // may have opened another modal (help/stats) before the timer fires.
      setTimeout(() => {
        if (bg.isConnected) dismiss();
      }, 1200);
    } else {
      send.textContent = "FAILED — TRY AGAIN";
      send.disabled = false;
      textarea.disabled = false;
    }
  });
  btns.appendChild(send);

  const cancel = document.createElement("button");
  cancel.className = "btn btn-secondary";
  cancel.textContent = "CANCEL";
  cancel.addEventListener("click", dismiss);
  btns.appendChild(cancel);

  modal.appendChild(btns);
  bg.appendChild(modal);
  root.appendChild(bg);
  textarea.focus();
}

async function sendFeedback(
  workerBaseUrl: string | undefined,
  message: string,
  puzzle: number,
): Promise<boolean> {
  const base = workerBaseUrl?.trim().replace(/\/+$/, "");
  if (!base) return false;
  try {
    const res = await fetch(`${base}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, puzzle }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
