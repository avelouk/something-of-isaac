/**
 * "Report a problem" modal — one textarea, POSTs to the worker's /feedback,
 * which forwards to Telegram. No worker URL configured = the modal still opens
 * but sending fails gracefully.
 */

import { FEEDBACK_MAX_CHARS } from "./limits.ts";
import { openModal } from "./ui/modal.ts";
import { workerBase } from "./workerBase.ts";

export function showFeedbackModal(
  workerBaseUrl: string | undefined,
  puzzleNumber: number,
  /** Prepended to the message so endless-mode reports carry their context. */
  messagePrefix = "",
): void {
  const { modal, dismiss } = openModal();

  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "REPORT A PROBLEM";
  modal.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "modal-sub";
  sub.textContent = "Bad hints, bugs, or anything else. It goes straight to the dev.";
  modal.appendChild(sub);

  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  // Reserve room for the prefix — the worker rejects prefix+message over the cap.
  textarea.maxLength = FEEDBACK_MAX_CHARS - messagePrefix.length;
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
    const ok = await sendFeedback(workerBaseUrl, messagePrefix + message, puzzleNumber);
    if (ok) {
      send.textContent = "SENT ✓ THANKS";
      // Only auto-close if this modal is still the one on screen — the user
      // may have opened another modal (help/stats) before the timer fires.
      setTimeout(() => {
        if (modal.isConnected) dismiss();
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
  textarea.focus();
}

async function sendFeedback(
  workerBaseUrl: string | undefined,
  message: string,
  puzzle: number,
): Promise<boolean> {
  const base = workerBase(workerBaseUrl);
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
