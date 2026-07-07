const bannersEl = document.getElementById("banners");
const dateEl = document.getElementById("date");
const itemSearchEl = document.getElementById("item-search");
const itemSelectEl = document.getElementById("item-select");
const fallbackNoteEl = document.getElementById("fallback-note");
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

function hintValues() {
  return [...hintsWrapEl.querySelectorAll("textarea")].map((ta) => ta.value);
}

/** The fallback text last poured into the textareas, so we never clobber manual edits. */
let lastPrefill = [];
let prefillToken = 0;

function hideFallbackNote() {
  fallbackNoteEl.hidden = true;
  lastPrefill = [];
  prefillToken += 1; // cancel any in-flight prefill
}

/**
 * Fill the hint fields with what the game will actually show for this item
 * (customHints → generated ladder → auto metadata) and flag it loudly.
 * Skipped if the user already typed something that isn't a previous prefill.
 */
async function prefillFallback(itemId) {
  const untouched = () => hintValues().every((v, i) => v.trim() === "" || v === lastPrefill[i]);
  if (!untouched()) return;
  const token = ++prefillToken;
  let out;
  try {
    const r = await fetch(`/api/fallback-hints?itemId=${itemId}`);
    if (!r.ok) return;
    out = await r.json();
  } catch {
    return;
  }
  if (token !== prefillToken) return; // date/item changed while fetching
  if (!untouched()) return; // user typed while fetching
  renderHints(meta.hintCount, out.hints);
  lastPrefill = out.hints;
  fallbackNoteEl.textContent =
    `⚠ No custom hints saved for this date — the fields below show the ${out.source} ` +
    `players currently see. Edit them and press Save to publish custom hints.`;
  fallbackNoteEl.hidden = false;
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
    hideFallbackNote();
    renderHints(meta.hintCount, []);
    fillSelectOptions(itemSearchEl.value, null);
    return;
  }

  const name = items.find((it) => it.id === entry.itemId)?.name ?? "";
  itemSearchEl.value = name;
  fillSelectOptions(name, entry.itemId);

  renderHints(meta.hintCount, entry.hints ?? []);
  hideFallbackNote();
  const hasHints = entry.hints?.some((h) => h.trim().length > 0);
  statusEl.textContent = locked
    ? "Read-only — this UTC date is in the past."
    : hasHints
      ? "Loaded item and hints from the worker."
      : "No custom hints yet — prefilled with the fallback players see.";
  if (!hasHints) void prefillFallback(entry.itemId);
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
      "Worker not configured — set WORKER_URL and ADMIN_TOKEN in .env.local. The schedule lives in the worker, so editing is disabled until then.",
    );
  } else {
    banner("ok", "Editing the schedule in the worker (SCHEDULE_KV) — the single source of truth.");
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
    // Untouched fields (empty or a previous prefill) follow the newly picked item.
    if (it) void prefillFallback(id);
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
      statusEl.textContent = "Saved to the worker. Live within ~60s (cache TTL).";
      hideFallbackNote(); // the saved hints are the custom hints now
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
