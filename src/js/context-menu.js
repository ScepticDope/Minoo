// # Context menu.
// It replaces the webview's own context menu everywhere, and shows only the sections that fit
// what was right-clicked. Note and folder actions in the sidebar, edit actions on the editor
// and text inputs, and the app-wide options anywhere outside a dialog.

import { showToast } from "./dialogs.js";
import { isAndroid } from "./dom.js";
import {
  editorView,
  insertEditorText,
  redoEditor,
  selectAllEditor,
  undoEditor,
} from "./editor.js";
import { createNewFolder, createNewNote, startRename } from "./sidebar-notes.js";
import { selectionTargets } from "./selection.js";
import { deletePermanently, emptyTrash, moveToTrash, restoreEntries } from "./trash.js";

// The right-clicked sidebar entry and edit target, remembered between opening the
// menu and clicking one of its actions.
let contextMenuTarget = null;
let contextMenuEditTarget = null;

// ## Show only the sections and options fitting the click target.
// Returns whether any options are left to show.
export function updateContextMenuSections(event) {
  const inDialog = !!event.target.closest(".modal, .picker, #confirm");
  const input = event.target.closest("input, textarea");
  const inEditor = !!event.target.closest("#editor");
  const inSidebar = !inDialog && !!event.target.closest("#sidebar");

  // The editor's editable element is CodeMirror's, not the #editor container.
  contextMenuEditTarget = input || (inEditor ? editorView.contentDOM : null);

  const entry = inSidebar
    ? event.target.closest("#sidebar-notes .item, #sidebar-notes .folder > .label")
    : null;
  contextMenuTarget = entry ? entry.closest(".item, .folder") : null;

  const isTrashFolder = !!contextMenuTarget && contextMenuTarget.classList.contains("trash");
  const inTrash =
    !!contextMenuTarget &&
    !isTrashFolder &&
    contextMenuTarget.dataset.path.startsWith(".trash/");

  const visibility = {
    "context-menu-rename": !!contextMenuTarget && !isTrashFolder,
    "context-menu-delete": !!contextMenuTarget && !isTrashFolder && !inTrash,
    "context-menu-restore": inTrash,
    "context-menu-delete-permanently": inTrash,
    "context-menu-empty-trash": isTrashFolder,
    "context-menu-sidebar": inSidebar,
    "context-menu-editor": !!contextMenuEditTarget,
    "context-menu-general": !inDialog,
  };

  Object.entries(visibility).forEach(([id, visible]) => {
    document.getElementById(id).style.display = visible ? "" : "none";
  });

  // The edit section's trailing separator only makes sense with options below it.
  document.querySelector("#context-menu-editor hr:last-of-type").style.display = inDialog
    ? "none"
    : "";

  return inSidebar || !!contextMenuEditTarget || !inDialog;
}

// ## Place the menu at the click point.
export function positionContextMenu(customContextMenu, event) {
  const edgeOffset = 5;

  // Show it first, so its size is measurable.
  customContextMenu.style.display = "block";

  const menuWidth = customContextMenu.offsetWidth;
  const menuHeight = customContextMenu.offsetHeight;
  const titlebarHeight = document.getElementById("titlebar").offsetHeight;

  let x = event.pageX;
  let y = event.pageY;

  // Open to the left of / above the pointer when the menu would overflow.
  if (x + menuWidth > window.innerWidth - edgeOffset) x -= menuWidth;
  if (y + menuHeight > window.innerHeight - edgeOffset) y -= menuHeight;

  // Keep the menu inside the viewport and below the titlebar.
  x = Math.max(edgeOffset, Math.min(x, window.innerWidth - menuWidth - edgeOffset));
  y = Math.max(titlebarHeight + 2, Math.min(y, window.innerHeight - menuHeight - edgeOffset));

  customContextMenu.style.left = `${x}px`;
  customContextMenu.style.top = `${y}px`;
}

// ## Paste from the clipboard into the element the context menu was opened on.
async function pasteFromClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (error) {
    showToast("Could not read the clipboard.");
    return;
  }

  if (contextMenuEditTarget === editorView.contentDOM) {
    insertEditorText(text);
  } else {
    document.execCommand("insertText", false, text);
  }
}

// ## Run an edit action, on the editor through CodeMirror or on a text input natively.
// CodeMirror keeps its own undo history and selection.
function editorOr(editorAction, inputAction) {
  return () =>
    contextMenuEditTarget === editorView.contentDOM
      ? editorAction()
      : inputAction(contextMenuEditTarget);
}

// ## Wire up the context menu.
export function setupContextMenu() {
  const customContextMenu = document.getElementById("context-menu");

  // ## Android keeps its own selection actions.
  if (isAndroid) {
    [
      "context-menu-cut",
      "context-menu-copy",
      "context-menu-paste",
      "context-menu-select-all",
    ].forEach((id) => (document.getElementById(id).style.display = "none"));

    document.querySelector("#context-menu-editor hr").style.display = "none";
  }

  document.addEventListener("contextmenu", (event) => {
    // Android fires this halfway through a long press, so the menu opens mid gesture.
    // On text that press is Android's own selection gesture, and preventing the event
    // swallows the copy and paste bar it puts over the selection, so the event is left
    // alone there and a three-finger touch opens the menu (see setupTouchGestures).
    // On a sidebar entry the same press starts a drag, and the menu would open on top
    // of the entry being dragged, so the hold gesture opens it on release instead.
    if (isAndroid) {
      if (event.target.closest("#editor, input, textarea")) {
        return;
      }

      if (event.target.closest("#sidebar-notes .item, #sidebar-notes .label")) {
        event.preventDefault();
        return;
      }
    }

    event.preventDefault();

    if (updateContextMenuSections(event)) {
      positionContextMenu(customContextMenu, event);
    } else {
      customContextMenu.style.display = "none";
    }
  });

  // Hide the custom menu when clicking elsewhere, on keypress, and blur.
  ["click", "keydown", "blur"].forEach((e) =>
    window.addEventListener(e, () => (customContextMenu.style.display = "none")),
  );

  // Keep focus and selection where menu was opened, so edit actions still apply to it.
  customContextMenu.addEventListener("mousedown", (event) => event.preventDefault());

  // The actions on the right-clicked note or folder. A right-click inside the
  // multi-selection applies the trash actions to the whole selection.
  const sidebarActions = {
    "context-menu-rename": (target) =>
      startRename(
        target.classList.contains("folder")
          ? target.querySelector(":scope > .label")
          : target,
      ),
    "context-menu-delete": (target) => moveToTrash(selectionTargets(target)),
    "context-menu-restore": (target) => restoreEntries(selectionTargets(target)),
    "context-menu-delete-permanently": (target) =>
      deletePermanently(selectionTargets(target)),
    "context-menu-empty-trash": emptyTrash,
  };

  Object.entries(sidebarActions).forEach(([id, action]) => {
    document.getElementById(id).addEventListener("click", () => {
      if (contextMenuTarget) action(contextMenuTarget);
    });
  });

  // Creating entries works from anywhere in the sidebar.
  document.getElementById("context-menu-new-note").addEventListener("click", createNewNote);
  document
    .getElementById("context-menu-new-folder")
    .addEventListener("click", createNewFolder);

  // The edit actions on the editor or a text input.
  const editActions = {
    "context-menu-undo": editorOr(undoEditor, () => document.execCommand("undo")),
    "context-menu-redo": editorOr(redoEditor, () => document.execCommand("redo")),
    "context-menu-cut": () => document.execCommand("cut"),
    "context-menu-copy": () => document.execCommand("copy"),
    "context-menu-paste": pasteFromClipboard,
    "context-menu-select-all": editorOr(selectAllEditor, (input) => input.select()),
  };

  Object.entries(editActions).forEach(([id, action]) => {
    document.getElementById(id).addEventListener("click", () => {
      if (!contextMenuEditTarget) return;
      contextMenuEditTarget.focus();
      action();
    });
  });
}
