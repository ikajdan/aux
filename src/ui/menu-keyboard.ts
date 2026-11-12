// SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

export function handleMenuKeydown(
  event: KeyboardEvent, items: HTMLElement[], active: Element | null, close: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "Tab") {
    // Restore the origin before the browser advances focus; do not trap Tab in the menu.
    close();
    return;
  }
  if (!items.length) return;
  const index = items.indexOf(active as HTMLElement);
  let next: number;
  if (event.key === "ArrowDown") next = (index + 1) % items.length;
  else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  items[next].focus({ preventScroll: true });
}
