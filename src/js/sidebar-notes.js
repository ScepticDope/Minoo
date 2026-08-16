// # The sidebar's note tree.
// The tree mirrors the notes folder on disk, folders are real directories and notes are
// Markdown files, addressed by their path relative to the notes folder (kept in each
// element's `data-path`).

import { showToast } from "./dialogs.js";
import { sidebarNotes, sidebar } from "./dom.js";
import { openNote, scheduleNoteSave } from "./editor.js";
import {
  clearSelection,
  selectRange,
  setSelectionAnchor,
  toggleSelection,
} from "./selection.js";
import { getSetting, updateSetting } from "./settings.js";
import { state } from "./state.js";
import { scheduleAutoSync } from "./sync.js";
import { invoke } from "./tauri.js";

// # Rendering.

// ## Render the note tree from the backend into the sidebar.
// Each folder's collapse status comes along from the backend, which keeps it in a
// hidden file inside the folder itself (see saveFolderCollapseStatus), so it survives
// restarts and syncs across devices. Only the sidebar's scroll position lives here.
export async function renderSidebarNotes() {
  const entries = await invoke("list_notes");
  const sidebarScrollTop = sidebar.scrollTop;

  clearSelection();
  sidebarNotes.innerHTML = "";
  buildSidebarLevel(entries, sidebarNotes);

  sidebarNotes.querySelectorAll(".folder").forEach((folder) => updateFolderCount(folder));
  sidebar.scrollTop = sidebarScrollTop;

  // Restore the highlight of the open note.
  if (state.currentNotePath) {
    const item = sidebarNotes.querySelector(
      `.item[data-path="${CSS.escape(state.currentNotePath)}"]`,
    );

    if (item) item.classList.add("active", "current");
  }
}

// ## Build one level of sidebar entries into a container element.
export function buildSidebarLevel(entries, container) {
  entries.forEach((entry) => {
    if (entry.kind === "folder" || entry.kind === "trash") {
      const folder = document.createElement("div");
      folder.className = "folder";
      folder.dataset.path = entry.path;

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = entry.name;

      // Trash cannot be dragged around, its children can.
      if (entry.kind === "trash") {
        folder.classList.add("trash");

        const icon = document.createElement("span");
        icon.className = "trash-icon";
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M3 6h18"/>' +
          '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
          '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
          "</svg>";
        label.prepend(icon);
      } else {
        folder.setAttribute("draggable", "true");
      }

      if (!entry.collapsed) folder.classList.add("open");

      const children = document.createElement("div");
      children.className = "children";
      folder.appendChild(label);
      folder.appendChild(children);
      buildSidebarLevel(entry.children, children);

      container.appendChild(folder);
    } else {
      const item = document.createElement("div");
      item.className = "item";
      item.textContent = entry.name;

      item.title = entry.name;
      item.dataset.path = entry.path;
      item.setAttribute("draggable", "true");

      container.appendChild(item);
    }
  });
}

// ## Get the display name of a note or folder element.
export function entryName(entry) {
  if (entry.classList.contains("trash")) return "Trash";

  return entry.classList.contains("folder")
    ? entry.querySelector(":scope > .label").textContent
    : entry.textContent;
}

// ## Persist a folder's collapse status into its folder's hidden .collapseStatus file.
// Backend errors stay silent, the toggle itself already worked on screen. The trash
// keeps its status too, but stays local, so it never schedules a sync.
function saveFolderCollapseStatus(folder) {
  invoke("set_folder_collapse_status", {
    path: folder.dataset.path,
    collapsed: !folder.classList.contains("open"),
  }).catch(() => {});

  if (folder.dataset.path !== ".trash") scheduleAutoSync();
}

// ## Update a folder's note count badge.
// Normal folders count their direct notes. The trash counts everything in it, notes
// nested in trashed folders included, so its badge tells how much emptying deletes.
export function updateFolderCount(folder) {
  const label = folder.querySelector(":scope > .label");
  const children = folder.querySelector(":scope > .children");
  const isTrash = folder.classList.contains("trash");
  const items = children.querySelectorAll(isTrash ? ".item" : ":scope > .item").length;
  const count = items > 99 ? "99+" : items.toString();
  label.setAttribute("data-count", count);

  // A change inside a trashed folder also changes the trash's own total.
  const trashRoot = folder.parentElement.closest(".folder.trash");
  if (trashRoot) updateFolderCount(trashRoot);
}

// ## Sort a container's entries by name, matching the backend order.
// Notes above folders at the root, folders first inside a folder.
export function sortSidebarLevel(container) {
  const notesFirst = container === sidebarNotes;
  const entries = [...container.querySelectorAll(":scope > .item, :scope > .folder")];

  entries.sort((a, b) => {
    // The trash always sits at the very bottom.
    if (a.classList.contains("trash")) return 1;
    if (b.classList.contains("trash")) return -1;

    const aIsFolder = a.classList.contains("folder");
    const bIsFolder = b.classList.contains("folder");
    if (aIsFolder !== bIsFolder) return (aIsFolder ? 1 : -1) * (notesFirst ? 1 : -1);

    const aName = entryName(a).toLowerCase();
    const bName = entryName(b).toLowerCase();
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });

  entries.forEach((entry) => container.appendChild(entry));
}

// ## Re-sort the whole tree, so a move lands where the next launch will list it.
export function sortSidebarTree() {
  sortSidebarLevel(sidebarNotes);
  sidebarNotes.querySelectorAll(".children").forEach(sortSidebarLevel);
}

// ## Render the tree and restore the last open note (or fall back to the first note).
export async function setupSidebarNotes() {
  await renderSidebarNotes();

  const lastNote = getSetting("last-note");
  const lastItem = lastNote
    ? sidebarNotes.querySelector(`.item[data-path="${CSS.escape(lastNote)}"]`)
    : null;

  const startItem =
    lastItem ||
    [...sidebarNotes.querySelectorAll(".item")].find(
      (item) => !item.dataset.path.startsWith(".trash"),
    );

  if (startItem) {
    await openNote(startItem.dataset.path);
  }
}

// # Creating entries.

// ## Find the container and parent path new entries should be created in.
// That is the active folder (or the folder holding the active note), or the root
// otherwise.
function getActiveContainer() {
  const activeElement = sidebarNotes.querySelector(".active");
  let activeFolder = activeElement ? activeElement.closest(".folder") : null;

  // Nothing new is created inside the trash, fall back to the root instead.
  if (activeFolder && activeFolder.dataset.path.startsWith(".trash")) {
    activeFolder = null;
  }

  return {
    activeFolder,
    container: activeFolder ? activeFolder.querySelector(":scope > .children") : sidebarNotes,
    parentPath: activeFolder ? activeFolder.dataset.path : "",
  };
}

// ## Pick the first "Prefix N" name not already taken in a container.
function pickUniqueName(container, selector, prefix) {
  const takenNames = new Set(
    [...container.querySelectorAll(selector)].map((el) => el.textContent),
  );

  let number = 1;
  while (takenNames.has(`${prefix} ${number}`)) number++;

  return `${prefix} ${number}`;
}

// ## Create a new note and open it.
export async function createNewNote() {
  const { activeFolder, container, parentPath } = getActiveContainer();
  const name = pickUniqueName(container, ":scope > .item", "Note");
  const path = parentPath ? `${parentPath}/${name}.md` : `${name}.md`;

  try {
    await invoke("create_note", { path });
  } catch (error) {
    showToast(error);

    return;
  }

  buildSidebarLevel([{ kind: "note", name, path, children: [] }], container);
  sortSidebarLevel(container);

  if (activeFolder) {
    activeFolder.classList.add("open");
    updateFolderCount(activeFolder);
    saveFolderCollapseStatus(activeFolder);
  }

  openNote(path);
  scheduleAutoSync();
}

// ## Create a new folder.
export async function createNewFolder() {
  const { activeFolder, container, parentPath } = getActiveContainer();
  const name = pickUniqueName(container, ":scope > .folder > .label", "Folder");
  const path = parentPath ? `${parentPath}/${name}` : name;

  try {
    await invoke("create_folder", { path });
  } catch (error) {
    showToast(error);

    return;
  }

  buildSidebarLevel([{ kind: "folder", name, path, children: [] }], container);
  updateFolderCount(container.lastElementChild);
  sortSidebarLevel(container);

  if (activeFolder) {
    activeFolder.classList.add("open");
    saveFolderCollapseStatus(activeFolder);
  }

  scheduleAutoSync();
}

// ## Create a note for the editor's content when typing without any note open.
// That happens e.g. after the last note was deleted.
let creatingNote = false;

export async function ensureCurrentNote() {
  if (state.currentNotePath || creatingNote) return;

  creatingNote = true;

  const name = pickUniqueName(sidebarNotes, ":scope > .item", "Note");
  const path = `${name}.md`;

  try {
    await invoke("create_note", { path });
  } catch (error) {
    creatingNote = false;
    showToast(error);

    return;
  }

  buildSidebarLevel([{ kind: "note", name, path, children: [] }], sidebarNotes);
  sortSidebarLevel(sidebarNotes);

  state.currentNotePath = path;
  creatingNote = false;

  // Highlight it and remember it without touching the editor's content.
  sidebarNotes
    .querySelectorAll(".active, .current")
    .forEach((el) => el.classList.remove("active", "current"));
  sidebarNotes
    .querySelector(`.item[data-path="${CSS.escape(path)}"]`)
    .classList.add("active", "current");
  updateSetting("last-note", path);

  scheduleNoteSave();
}

// # Renaming and moving.

// ## Apply a finished move to an element.
// Updates its stored paths, and its shown name too, since moves auto-rename when the
// name was already taken at the destination.
export function applyEntryMove(target, oldPath, newPath) {
  updateEntryPaths(target, oldPath, newPath);

  const newName = newPath.split("/").pop();
  if (target.classList.contains("folder")) {
    target.querySelector(":scope > .label").textContent = newName;
  } else {
    target.textContent = target.title = newName.replace(/\.md$/i, "");
  }

  sortSidebarTree();
}

// ## Rewrite the stored paths of a renamed or moved entry.
// For folders that includes everything inside, and the open note bookkeeping moves
// along too.
function updateEntryPaths(target, oldPath, newPath) {
  target.dataset.path = newPath;

  target.querySelectorAll("[data-path]").forEach((el) => {
    el.dataset.path = newPath + el.dataset.path.slice(oldPath.length);
  });

  if (pathIsOrContains(oldPath, state.currentNotePath)) {
    state.currentNotePath = newPath + state.currentNotePath.slice(oldPath.length);
    updateSetting("last-note", state.currentNotePath);
  }
}

// ## Check whether `path` equals `candidate` or is one of its parents.
function pathIsOrContains(path, candidate) {
  return !!candidate && (candidate === path || candidate.startsWith(`${path}/`));
}

// ## Swap an entry's name for an input until committed (Enter/blur) or cancelled (Esc).
export function startRename(element) {
  const target = element.classList.contains("label") ? element.parentElement : element;
  const oldPath = target.dataset.path;
  const oldName = element.textContent;

  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = oldName;

  element.textContent = "";
  element.appendChild(input);
  input.focus();

  // Add a timeout to not conflict with editor caret resets.
  setTimeout(() => {
    input.select();
  }, 100);

  let finished = false;

  const finish = async (commit) => {
    if (finished) return;
    finished = true;

    const newName = input.value.trim();
    input.remove();
    element.textContent = oldName;

    if (!commit || newName === "" || newName === oldName) return;

    try {
      const newPath = await invoke("rename_entry", { path: oldPath, newName });

      // Take the shown name from the result, the backend may have cleaned it up.
      const finalName = newPath.split("/").pop();

      element.textContent = target.classList.contains("folder")
        ? finalName
        : finalName.replace(/\.md$/i, "");

      if (element.title) element.title = element.textContent;

      updateEntryPaths(target, oldPath, newPath);
      sortSidebarLevel(target.parentElement);
      scheduleAutoSync();
    } catch (error) {
      showToast(error);
    }
  };

  input.addEventListener("keydown", (event) => {
    // Keep the editor and global shortcuts out of the rename input.
    event.stopPropagation();

    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });

  input.addEventListener("blur", () => finish(true));
}

// ## Rename notes and folders with a double click (or tap) on them.
export function setupRenaming() {
  sidebarNotes.addEventListener("dblclick", (event) => {
    const label = event.target.closest(".folder > .label");
    const item = !label ? event.target.closest(".item") : null;
    const element = label || item;

    if (!element || element.querySelector(".rename-input")) return;

    // The trash itself keeps its name.
    if (label && label.parentElement.classList.contains("trash")) return;

    startRename(element);
  });
}

// # Sidebar interaction.

// ## Open items, and select and open/close folders.
// Clicks with Shift or Cmd/Ctrl held only change the multi-selection (see
// selection.js), a plain click clears it and works as before.
export function setupSidebarClicks() {
  sidebarNotes.addEventListener("click", (event) => {
    if (event.target.closest(".dragging") || event.target.closest(".rename-input")) return;

    const label = event.target.closest(".folder > .label");
    const item = !label ? event.target.closest(".item") : null;

    if (!label && !item) return;

    const entry = label ? label.parentElement : item;

    if (event.metaKey || event.ctrlKey) return toggleSelection(entry);
    if (event.shiftKey) return selectRange(entry);

    clearSelection();
    setSelectionAnchor(entry);

    sidebarNotes.querySelectorAll(".active").forEach((el) => el.classList.remove("active"));
    entry.classList.add("active");

    if (label) {
      entry.classList.toggle("open");
      saveFolderCollapseStatus(entry);
    } else {
      openNote(entry.dataset.path);
    }
  });
}
