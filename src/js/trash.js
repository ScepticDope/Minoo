// # The trash.
// Deleting moves entries into the Trash folder at the bottom of the sidebar, so they
// stay visible and recoverable. Only deleting from the trash is permanent. Every
// action takes an array of entries, so the multi-selection works in one go.

import { appConfirm, showToast } from "./dialogs.js";
import { sidebarNotes } from "./dom.js";
import {
  discardPendingSave,
  flushNoteSave,
  openNextNote,
  pathContainsCurrentNote,
} from "./editor.js";
import { applyEntryMove, entryName, updateFolderCount } from "./sidebar-notes.js";
import { clearSelection } from "./selection.js";
import { state } from "./state.js";
import { scheduleAutoSync } from "./sync.js";
import { invoke } from "./tauri.js";

// ## Move notes and folders into the trash.
export async function moveToTrash(targets) {
  // Entries already in the trash stay where they are.
  targets = targets.filter((target) => !target.dataset.path.startsWith(".trash"));

  const wasCurrent = targets.some((target) => pathContainsCurrentNote(target.dataset.path));

  // The note file moves along, so make sure pending edits are in it first.
  if (wasCurrent) await flushNoteSave();

  const trashFolder = sidebarNotes.querySelector(":scope > .folder.trash");
  const trashChildren = trashFolder.querySelector(":scope > .children");

  let moved = false;

  for (const target of targets) {
    const path = target.dataset.path;

    let newPath;
    try {
      newPath = await invoke("move_entry", { path, newParent: ".trash" });
    } catch (error) {
      showToast(error);

      continue;
    }

    const parentFolder = target.parentElement.closest(".folder");
    trashChildren.appendChild(target);
    applyEntryMove(target, path, newPath);

    if (parentFolder) updateFolderCount(parentFolder);

    moved = true;
  }

  updateFolderCount(trashFolder);
  clearSelection();

  if (wasCurrent) openNextNote();
  if (moved) scheduleAutoSync();
}

// ## Move entries out of the trash, back to the root of the sidebar.
export async function restoreEntries(targets) {
  targets = targets.filter((target) => target.dataset.path.startsWith(".trash/"));

  let restored = false;

  for (const target of targets) {
    const path = target.dataset.path;

    let newPath;
    try {
      newPath = await invoke("move_entry", { path, newParent: "" });
    } catch (error) {
      showToast(error);

      continue;
    }

    const parentFolder = target.parentElement.closest(".folder");
    sidebarNotes.appendChild(target);
    applyEntryMove(target, path, newPath);

    if (parentFolder) updateFolderCount(parentFolder);

    restored = true;
  }

  clearSelection();

  if (restored) scheduleAutoSync();
}

// ## Permanently delete entries from the trash.
export async function deletePermanently(targets) {
  targets = targets.filter((target) => target.dataset.path.startsWith(".trash/"));
  if (!targets.length) return;

  const single = targets.length === 1 ? targets[0] : null;
  const message = !single
    ? `Permanently delete these ${targets.length} entries? This cannot be undone.`
    : single.classList.contains("folder")
      ? `Permanently delete the folder "${entryName(single)}" and everything in it? This cannot be undone.`
      : `Permanently delete the note "${entryName(single)}"? This cannot be undone.`;

  if (!(await appConfirm(message, "Delete"))) return;

  const wasCurrent = targets.some((target) => pathContainsCurrentNote(target.dataset.path));

  // Drop the pending autosave, the file is going away.
  if (wasCurrent) discardPendingSave();

  let deleted = false;

  for (const target of targets) {
    try {
      await invoke("delete_permanently", { path: target.dataset.path });
    } catch (error) {
      showToast(error);

      continue;
    }

    const parentFolder = target.parentElement.closest(".folder");
    target.remove();

    if (parentFolder) updateFolderCount(parentFolder);

    deleted = true;
  }

  clearSelection();
  if (wasCurrent) openNextNote();
  if (deleted) scheduleAutoSync();
}

// ## Permanently delete everything in the trash.
export async function emptyTrash() {
  const message = "Permanently delete everything in the trash? This cannot be undone.";

  if (!(await appConfirm(message, "Empty Trash"))) return;

  const wasCurrent = !!state.currentNotePath && state.currentNotePath.startsWith(".trash");

  if (wasCurrent) discardPendingSave();

  try {
    await invoke("empty_trash");
  } catch (error) {
    showToast(error);

    return;
  }

  const trashFolder = sidebarNotes.querySelector(":scope > .folder.trash");
  trashFolder.querySelector(":scope > .children").innerHTML = "";
  updateFolderCount(trashFolder);

  if (wasCurrent) openNextNote();

  scheduleAutoSync();
}
