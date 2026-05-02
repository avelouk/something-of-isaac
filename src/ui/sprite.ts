/**
 * Render an item's sprite for the win/loss reveal screen.
 * Sprites are hot-linked from isaacguru.com via items[].img.
 */

export function renderSprite(container: HTMLElement, src: string, alt: string) {
  container.replaceChildren();
  if (!src) return;
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.className = "item-sprite";
  img.loading = "eager";
  container.appendChild(img);
}
