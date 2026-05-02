/**
 * ARIA combobox autocomplete. Matches against multiple item fields so
 * users can search by name, pickup quote, primary tag, item pool, or
 * description content.
 *
 * Match priority (highest -> lowest):
 *   - exact name match
 *   - name prefix
 *   - name substring
 *   - pickup-quote substring
 *   - tag/pool substring
 *   - description substring
 *
 * Results are rendered as a grid of *sprite-only* tiles — no name, no
 * reason text. Clicking a sprite *selects* it (sets pendingItem); the
 * commit happens when the player clicks GUESS.
 */

import type { Item } from "../hints.ts";

export type Searchable = Item & { pickupQuote: string; norm: string };

const MAX_RESULTS = 8;

function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function indexItems(items: Item[], quotes: Record<number, string>): Searchable[] {
  return items.map((it) => {
    const pickupQuote = quotes[it.id] ?? "";
    return {
      ...it,
      pickupQuote,
      norm: fold(
        [it.name, pickupQuote, it.primaryTag, it.pools.join(" "), it.description].join(" "),
      ),
    };
  });
}

type Match = { item: Searchable; score: number };

export function search(items: Searchable[], queryRaw: string): Match[] {
  const q = fold(queryRaw);
  if (q.length < 1) return [];

  const out: Match[] = [];
  for (const it of items) {
    const name = fold(it.name);
    const pickup = fold(it.pickupQuote);
    const tag = fold(it.primaryTag);
    const pools = fold(it.pools.join(" "));
    const desc = fold(it.description);

    let score = 0;

    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 90 - (name.length - q.length) * 0.1;
    else if (name.includes(q)) score = 70;
    else if (pickup.includes(q)) score = 55;
    else if (tag.includes(q)) score = 45;
    else if (pools.includes(q)) score = 40;
    else if (desc.includes(q)) score = 25;

    if (score > 0) out.push({ item: it, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_RESULTS);
}

export type AutocompleteOptions = {
  input: HTMLInputElement;
  listbox: HTMLUListElement;
  items: Searchable[];
  /** Fires when the player picks a sprite (or the picked sprite is dropped from results). */
  onSelect: (item: Searchable | null) => void;
};

export function attachAutocomplete(opts: AutocompleteOptions) {
  const { input, listbox, items, onSelect } = opts;
  let active = -1; // keyboard-highlighted index
  let pickedId: number | null = null; // sprite the user clicked
  let current: Match[] = [];

  function render() {
    listbox.innerHTML = "";
    if (current.length === 0) {
      listbox.hidden = true;
      input.setAttribute("aria-expanded", "false");
      return;
    }
    current.forEach((m, i) => {
      const li = document.createElement("li");
      li.id = `guess-opt-${i}`;
      li.className = "ac-tile" + (m.item.id === pickedId ? " picked" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      li.setAttribute("aria-label", m.item.name); // for screen readers only
      li.dataset.itemId = String(m.item.id);

      if (m.item.img) {
        const img = document.createElement("img");
        img.src = m.item.img;
        img.alt = "";
        img.loading = "lazy";
        img.className = "ac-sprite";
        li.appendChild(img);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "ac-fallback";
        fallback.textContent = "?";
        li.appendChild(fallback);
      }

      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep input focus, suppress blur-clear
        pick(i);
      });
      listbox.appendChild(li);
    });
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) input.setAttribute("aria-activedescendant", `guess-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function update() {
    const prev = pickedId;
    current = search(items, input.value);
    // If the previously picked item is no longer in results, clear the
    // selection so the GUESS button reflects reality.
    if (prev != null && !current.some((m) => m.item.id === prev)) {
      pickedId = null;
      onSelect(null);
    }
    // No keyboard preselection — the first tile is just a tile.
    active = -1;
    render();
  }

  function pick(i: number) {
    if (i < 0 || i >= current.length) return;
    const m = current[i];
    pickedId = m.item.id;
    onSelect(m.item);
    render(); // re-render to move the .picked highlight
  }

  input.addEventListener("input", update);

  input.addEventListener("keydown", (e) => {
    if (current.length === 0) return; // dropdown hidden — let other handlers fire
    if (e.key === "ArrowDown") {
      active = Math.min(current.length - 1, active + 1);
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      active = Math.max(0, active - 1);
      render();
      e.preventDefault();
    } else if (e.key === "Enter") {
      // Enter on the input while the listbox is open *picks* — does not
      // commit. The player still has to press GUESS.
      if (active >= 0) {
        pick(active);
        e.preventDefault();
      }
    } else if (e.key === "Escape") {
      current = [];
      render();
    }
  });

  input.addEventListener("blur", () => {
    // Delay so mousedown on a tile fires first.
    setTimeout(() => {
      current = [];
      render();
    }, 120);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) update();
  });
}
