// # Multi-selection in the sidebar tree.
// Shift-click selects a range and Cmd/Ctrl-click toggles single entries, like a file
// explorer, so several notes and folders can be dragged or deleted in one go. Selected
// entries carry the `selected` class.

import { sidebarNotes } from "./dom.js";

// The entry the last plain click or toggle landed on, a shift-click selects the range
// between here and the clicked entry.
let anchor = null;

// ## List the entries visible on screen, in on-screen order.
// Entries hidden inside a collapsed folder are skipped, matching what a range selection
// visually runs over.
function visibleEntries() {
  return [...sidebarNotes.querySelectorAll(".item, .folder")].filter(
    (entry) => !entry.parentElement.closest(".folder:not(.open)"),
  );
}

// ## Get the selected entries, in on-screen order.
export function getSelectedEntries() {
  return [...sidebarNotes.querySelectorAll(".selected")];
}

// ## Clear the selection.
export function clearSelection() {
  getSelectedEntries().forEach((entry) => entry.classList.remove("selected"));
  anchor = null;
}

// ## Remember the entry a plain click landed on as the range anchor.
export function setSelectionAnchor(entry) {
  anchor = entry;
}

// ## Toggle one entry in and out of the selection (Cmd/Ctrl-click).
export function toggleSelection(entry) {
  // The trash itself stays out of every selection.
  if (entry.classList.contains("trash")) return;

  entry.classList.toggle("selected");
  anchor = entry;
}

// ## Replace the selection with the range between the anchor and an entry (shift-click).
export function selectRange(entry) {
  if (entry.classList.contains("trash")) return;

  const entries = visibleEntries();
  const to = entries.indexOf(entry);

  // Without a visible anchor the range is just the clicked entry itself.
  const anchorIndex = entries.indexOf(anchor);
  const from = anchorIndex === -1 ? to : anchorIndex;

  getSelectedEntries().forEach((el) => el.classList.remove("selected"));
  entries
    .slice(Math.min(from, to), Math.max(from, to) + 1)
    .filter((el) => !el.classList.contains("trash"))
    .forEach((el) => el.classList.add("selected"));
}

// ## Resolve which entries an action on `target` applies to.
// A target inside the selection means the whole selection, any other target just
// itself. Entries sitting inside a selected folder are dropped, moving or deleting
// that folder covers them already.
export function selectionTargets(target) {
  if (!target.classList.contains("selected")) return [target];

  const selected = getSelectedEntries();
  return selected.filter(
    (entry) => !selected.some((other) => other !== entry && other.contains(entry)),
  );
}

// ## Clear the selection with Escape.
export function setupSelection() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearSelection();
  });
}
