// # Keyboard shortcuts.
// Shortcut strings live in settings.toml under [shortcuts] and use the form
// "CmdOrCtrl+Shift+P", where "CmdOrCtrl" matches ⌘ on macOS/iOS and Ctrl elsewhere.
// "Alt" works the same way and matches ⌥ on macOS/iOS, and reads as "Option" there, so
// both spellings are accepted.
// A few keys are fixed on purpose. Esc closes overlays, and F2/Delete work on the
// selected sidebar entry.

import { sidebar } from "./dom.js";
import { focusEditor } from "./editor.js";
import { createNewFolder, createNewNote, startRename } from "./sidebar-notes.js";
import { toggleCommandPalette, toggleSearch } from "./picker.js";
import { selectionTargets } from "./selection.js";
import { toggleSettings } from "./settings.js";
import { toggleSidebar } from "./sidebar.js";
import { state } from "./state.js";
import { deletePermanently, emptyTrash, moveToTrash } from "./trash.js";
import { centerWindow, tileWindow, toggleFullscreen } from "./window.js";

// ## The actions the configurable shortcuts can trigger.
// The hints explain each action in the settings, where the defaults show up as the
// input placeholders. Those match the ones in settings.rs, so a user who cleared a
// field can see what to type to get back to stock.
export const shortcutActions = {
  sidebar: {
    name: "Toggle Sidebar",
    hint: "Show or hide the sidebar with your notes.",
    default: "CmdOrCtrl+B",
    run: () => toggleSidebar(),
  },
  settings: {
    name: "Toggle Settings",
    hint: "Open or close this settings window.",
    default: "CmdOrCtrl+,",
    run: () => toggleSettings(),
  },
  "command-palette": {
    name: "Toggle Command Palette",
    hint: "A quick launcher that can run every action by name.",
    default: "CmdOrCtrl+Shift+P",
    run: () => toggleCommandPalette(),
  },
  search: {
    name: "Search Note",
    hint: "Search the text of the open note.",
    default: "CmdOrCtrl+F",
    run: () => toggleSearch(),
  },
  "search-all": {
    name: "Search All Notes",
    hint: "Search through the names and text of all notes.",
    default: "CmdOrCtrl+Shift+F",
    run: () => toggleSearch(true),
  },
  "new-note": {
    name: "New Note",
    hint: "Create a new note.",
    default: "CmdOrCtrl+N",
    run: () => createNewNote(),
  },
  "new-folder": {
    name: "New Folder",
    hint: "Create a new folder to hold notes.",
    default: "CmdOrCtrl+Shift+N",
    run: () => createNewFolder(),
  },
  fullscreen: {
    name: "Toggle Fullscreen",
    hint: "Grow the window to fill the screen, and back.",
    default: "F11",
    run: () => toggleFullscreen(),
  },
  "center-window": {
    name: "Center Window",
    hint: "Put the window back in the middle of its screen.",
    default: "Alt+CmdOrCtrl+C",
    run: () => centerWindow(),
  },
  "tile-left": {
    name: "Tile Window Left",
    hint: "Fill the left half of the screen with the window.",
    default: "Alt+CmdOrCtrl+Left",
    run: () => tileWindow(),
  },
  "tile-right": {
    name: "Tile Window Right",
    hint: "Fill the right half of the screen with the window.",
    default: "Alt+CmdOrCtrl+Right",
    run: () => tileWindow(true),
  },
};

// ## Compare a keydown to a shortcut's key, by name or by the physical key.
// A keydown reports "ArrowLeft" where a shortcut string may just say "Left", which is
// what the macOS menu accelerators accept too. The physical key is there for Alt, which
// on macOS turns a letter into its accented version, so ⌥C arrives as "ç".
function sameKey(event, shortcutKey) {
  const key = shortcutKey.toLowerCase().replace(/^arrow/, "");

  return (
    event.key.toLowerCase().replace(/^arrow/, "") === key ||
    event.code.toLowerCase() === `key${key}`
  );
}

// ## Check a keydown event against a shortcut string like "CmdOrCtrl+Shift+P".
function matchesShortcut(event, shortcut) {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return false;

  const wantsCmdOrCtrl = parts.some((p) => /^(cmdorctrl|cmd|ctrl|control|meta)$/i.test(p));
  const wantsShift = parts.some((p) => /^shift$/i.test(p));
  const wantsAlt = parts.some((p) => /^(alt|option)$/i.test(p));

  return (
    (event.ctrlKey || event.metaKey) === wantsCmdOrCtrl &&
    event.shiftKey === wantsShift &&
    event.altKey === wantsAlt &&
    sameKey(event, key)
  );
}

// ## Refresh the configured shortcuts in the context menu hints.
// The modifiers get their symbols here, with the Mac one first like in the shortcut
// settings, so "CmdOrCtrl" reads as "⌘/Ctrl" and "Alt", which is "Option" on a Mac
// keyboard, as "⌥/Alt". An empty shortcut drops the hint, the way the macOS menu bar
// leaves out the accelerator.
export function updateShortcutHints() {
  document.querySelectorAll("[data-shortcut]").forEach((span) => {
    span.textContent = (state.settings["shortcuts"][span.dataset.shortcut] || "")
      .replace("CmdOrCtrl", "⌘/Ctrl")
      .replace(/alt|option/i, "⌥/Alt");
  });
}

// ## Central dispatcher for all shortcuts, fixed and configurable.
export function setupShortcuts() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (document.getElementById("confirm").classList.contains("active")) {
        document.getElementById("confirm-cancel").click();
        return;
      }

      document.getElementById("settings").classList.remove("active");
      document
        .querySelectorAll(".picker.active")
        .forEach((el) => el.classList.remove("active"));

      // Hand focus back to the editor, so stray keystrokes (like Delete) land in
      // the note and not on the sidebar selection.
      focusEditor();

      return;
    }

    if (handleSidebarKey(event)) return;

    for (const [action, definition] of Object.entries(shortcutActions)) {
      const shortcut = state.settings["shortcuts"][action];

      if (shortcut && matchesShortcut(event, shortcut)) {
        event.preventDefault();
        definition.run();

        return;
      }
    }
  });
}

// ## The fixed keys on the sidebar selection, matching the context menu.
// F2 renames the selected entry, Delete moves it to the trash (or empties the trash
// when it is selected). They only run outside text editing, with nothing covering the
// sidebar. Returns whether the key was handled.
function handleSidebarKey(event) {
  const isDelete = event.key === "Delete" || event.key === "Backspace";
  if (event.key !== "F2" && !isDelete) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;

  if (event.target.closest("input, textarea, [contenteditable]")) return false;
  if (document.querySelector(".modal.active, .picker.active, #confirm.active")) {
    return false;
  }
  if (sidebar.classList.contains("hidden")) return false;

  const target = document.querySelector("#sidebar-notes .active");
  if (!target) return false;

  const isTrashFolder = target.classList.contains("trash");

  // The trash itself keeps its name.
  if (event.key === "F2") {
    if (isTrashFolder) return false;

    event.preventDefault();

    startRename(
      target.classList.contains("folder") ? target.querySelector(":scope > .label") : target,
    );

    return true;
  }

  // Deleting an entry inside the multi-selection deletes the whole selection.
  event.preventDefault();
  if (isTrashFolder) {
    emptyTrash();
  } else if (target.dataset.path.startsWith(".trash/")) {
    deletePermanently(selectionTargets(target));
  } else {
    moveToTrash(selectionTargets(target));
  }

  return true;
}
