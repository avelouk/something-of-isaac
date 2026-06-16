const bannersEl = document.getElementById("banners");
const dateEl = document.getElementById("date");
const itemSearchEl = document.getElementById("item-search");
const itemSelectEl = document.getElementById("item-select");
const hintsWrapEl = document.getElementById("hints-wrap");
const saveEl = document.getElementById("save");
const statusEl = document.getElementById("status");

/** @type {{ todayUtc: string; hintCount: number; publishEnabled: boolean } | null} */
let meta = null;
/** @type {{ version: number; salt: string; entries: { date: string; n: number; itemId: number; hash: string; hints?: string[] }[] } | null} */
let schedule = null;
/** @type {{ id: number; name: string }[]} */
let items = [];

function banner(className, text) {
  const d = document.createElement("div");
  d.className = `banner ${className}`;
  d.textContent = text;
  bannersEl.appendChild(d);
}

function isLocked(dateStr) {
  return meta && dateStr && dateStr < meta.todayUtc;
}

function renderHints(count, values) {
  hintsWrapEl.replaceChildren();
  const label = document.createElement("label");
  label.textContent = `Hints (${count} lines, hardest → easiest)`;
  hintsWrapEl.appendChild(label);
  const locked = isLocked(dateEl.value);
  for (let i = 0; i < count; i++) {
    const ta = document.createElement("textarea");
    ta.placeholder = `Hint ${i + 1}`;
    ta.value = values[i] ?? "";
    ta.disabled = locked;
    hintsWrapEl.appendChild(ta);
  }
}

function fillSelectOptions(filterQuery, preferredItemId) {
  const ql = filterQuery.trim().toLowerCase();
  let subset = ql
    ? items.filter((it) => it.name.toLowerCase().includes(ql)).slice(0, 100)
    : items.slice(0, 100);
  if (preferredItemId != null) {
    const cur = items.find((it) => it.id === preferredItemId);
    if (cur && !subset.some((x) => x.id === cur.id)) {
      subset = [cur, ...subset].slice(0, 100);
    }
  }
  itemSelectEl.replaceChildren();
  for (const it of subset) {
    const opt = document.createElement("option");
    opt.value = String(it.id);
    opt.textContent = `${it.name} (#${it.id})`;
    itemSelectEl.appendChild(opt);
  }
  if (preferredItemId != null) {
    itemSelectEl.value = String(preferredItemId);
  }
}

function fillFromSchedule() {
  const dateStr = dateEl.value;
  if (!schedule || !dateStr || !meta) return;
  const entry = schedule.entries.find((e) => e.date === dateStr);
  const locked = isLocked(dateStr);

  itemSearchEl.disabled = locked;
  itemSelectEl.disabled = locked;
  saveEl.disabled = locked;

  if (!entry) {
    statusEl.textContent = "No row for this date (outside generated range).";
    renderHints(meta.hintCount, []);
    fillSelectOptions(itemSearchEl.value, null);
    return;
  }

  const name = items.find((it) => it.id === entry.itemId)?.name ?? "";
  itemSearchEl.value = name;
  fillSelectOptions(name, entry.itemId);

  renderHints(meta.hintCount, entry.hints ?? []);
  const hasHints = entry.hints?.some((h) => h.trim().length > 0);
  statusEl.textContent = locked
    ? "Read-only — this UTC date is in the past."
    : hasHints
      ? meta.publishEnabled
        ? "Loaded item and hints from worker."
        : "Loaded from local schedule.json."
      : "No hints yet — fallback ladders apply until you save.";
}

async function init() {
  const [m, sch, it] = await Promise.all([
    fetch("/api/meta").then((r) => r.json()),
    fetch("/api/schedule").then((r) => r.json()),
    fetch("/api/items").then((r) => r.json()),
  ]);
  meta = m;
  schedule = sch;
  items = [...it].sort((a, b) => a.name.localeCompare(b.name));

  bannersEl.replaceChildren();
  banner("ok", `UTC today: ${meta.todayUtc} — dates before this are read-only and cannot be saved.`);
  if (!meta.publishEnabled) {
    banner(
      "warn",
      "Worker not configured — set WORKER_URL and ADMIN_TOKEN in .env.local. You will only see your local schedule.json, not your collaborator's edits.",
    );
  } else {
    banner("ok", "Schedule and hints load from the worker — you see the same data as your collaborator.");
  }

  dateEl.value = meta.todayUtc;

  fillSelectOptions("", null);
  renderHints(meta.hintCount, []);

  itemSearchEl.addEventListener("input", () => {
    const dateStr = dateEl.value;
    const entry = schedule?.entries.find((e) => e.date === dateStr);
    fillSelectOptions(itemSearchEl.value, entry?.itemId ?? null);
  });

  itemSelectEl.addEventListener("change", () => {
    const id = Number(itemSelectEl.value);
    const it = items.find((x) => x.id === id);
    if (it) itemSearchEl.value = it.name;
  });

  dateEl.addEventListener("change", fillFromSchedule);

  fillFromSchedule();

  saveEl.addEventListener("click", async () => {
    statusEl.textContent = "";
    const dateStr = dateEl.value;
    if (!dateStr) return;

    if (isLocked(dateStr)) {
      statusEl.textContent = "Cannot save — this date is locked.";
      return;
    }

    const hints = [...hintsWrapEl.querySelectorAll("textarea")].map((ta) => ta.value);
    const sid = Number(itemSelectEl.value);
    if (!Number.isFinite(sid)) {
      statusEl.textContent = "Pick an item.";
      return;
    }

    saveEl.disabled = true;
    try {
      const r = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, itemId: sid, hints }),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error || r.statusText);
      if (out.publish === "ok") {
        statusEl.textContent = "Saved locally and published to worker.";
      } else if (out.publish === "failed") {
        statusEl.textContent = `Saved locally. Publish FAILED: ${out.publishError ?? "unknown error"}`;
      } else {
        statusEl.textContent = "Saved locally only (worker not configured in .env.local).";
      }
      schedule = await fetch("/api/schedule").then((x) => x.json());
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      saveEl.disabled = isLocked(dateEl.value);
    }
  });
}

init().catch((e) => {
  statusEl.textContent = e instanceof Error ? e.message : String(e);
});
