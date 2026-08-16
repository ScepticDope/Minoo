// # The picker logic for the command palette and the search overlays.

import { closeOtherOverlays, isMobile } from "./dom.js";
import { editorView, focusEditor, highlightEditorMatch, openNote } from "./editor.js";
import { createNewFolder, createNewNote } from "./sidebar-notes.js";
import {
  openNotesLocation,
  openSettingsLocation,
  toggleSettings,
  updateSetting,
} from "./settings.js";
import { toggleSidebar } from "./sidebar.js";
import { state } from "./state.js";
import { syncNow } from "./sync.js";
import { invoke } from "./tauri.js";
import { moveToTrash } from "./trash.js";
import { centerWindow, tileWindow, toggleFullscreen } from "./window.js";

// ## Shared list navigation for the pickers.
function setupPickerKeys(input, results) {
  input.addEventListener("keydown", (event) => {
    const rows = [...results.querySelectorAll(".item")];
    if (!rows.length) return;

    const selectedIndex = rows.findIndex((row) => row.classList.contains("selected"));

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (selectedIndex + step + rows.length) % rows.length;

      rows.forEach((row) => row.classList.remove("selected"));
      rows[nextIndex].classList.add("selected");
      rows[nextIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();

      (rows[selectedIndex] || rows[0]).click();
    }
  });
}

// ## Close a picker when clicking next to its window.
function setupPickerDismiss(picker) {
  picker.addEventListener("click", (event) => {
    if (event.target === picker) {
      picker.classList.remove("active");

      focusEditor();
    }
  });
}

// ## The command palette.
function paletteCommands() {
  const commands = [
    { name: "New Note", run: createNewNote },
    { name: "New Folder", run: createNewFolder },
    { name: "Toggle Sidebar", run: toggleSidebar },
    { name: "Search Note", run: () => toggleSearch() },
    { name: "Search All Notes", run: () => toggleSearch(true) },
    { name: "Sync Now", run: syncNow },
    { name: "Settings", run: toggleSettings },
    { name: "Config File Location", run: openSettingsLocation },
    { name: "Notes Folder Location", run: openNotesLocation },
  ];

  // Mobile has one fullscreen window, so none of these would do anything there.
  if (!isMobile) {
    commands.push(
      { name: "Toggle Fullscreen", run: toggleFullscreen },
      { name: "Center Window", run: centerWindow },
      { name: "Tile Window Left", run: () => tileWindow() },
      { name: "Tile Window Right", run: () => tileWindow(true) },
    );
  }

  if (state.currentNotePath && !state.currentNotePath.startsWith(".trash")) {
    const currentItem = document.querySelector(
      `#sidebar-notes .item[data-path="${CSS.escape(state.currentNotePath)}"]`,
    );

    if (currentItem) {
      commands.push({ name: "Delete Current Note", run: () => moveToTrash([currentItem]) });
    }
  }

  document.querySelectorAll("#theme-select option").forEach((option) => {
    commands.push({
      name: `Theme: ${option.textContent}`,
      run: () => updateSetting("theme", option.value),
    });
  });

  document.querySelectorAll("#sidebar-notes .item").forEach((item) => {
    if (item.dataset.path.startsWith(".trash")) return;

    commands.push({
      name: `Open: ${item.textContent}`,
      run: () => openNote(item.dataset.path),
    });
  });

  return commands;
}

// ## Render the palette commands matching a query.
function renderCommandResults(query) {
  const results = document.getElementById("command-palette-results");
  results.innerHTML = "";

  const matching = paletteCommands().filter((command) =>
    command.name.toLowerCase().includes(query.toLowerCase()),
  );

  matching.forEach((command, index) => {
    const row = document.createElement("div");

    row.className = index === 0 ? "item selected" : "item";
    row.textContent = command.name;
    row.addEventListener("click", () => {
      toggleCommandPalette();
      command.run();
    });

    results.appendChild(row);
  });
}

// ## Toggle the command palette.
export function toggleCommandPalette() {
  const palette = document.getElementById("command-palette");
  const isOpen = palette.classList.toggle("active");

  if (isOpen) {
    closeOtherOverlays("command-palette");

    const input = document.getElementById("command-palette-input");
    input.value = "";
    renderCommandResults("");

    input.focus();
  } else {
    focusEditor();
  }
}

// ## Search the currently open note.
let searchTimer = null;
let searchRequest = 0;
let searchAllNotes = false;

function searchCurrentNote(query) {
  if (!state.currentNotePath) return [];

  const name = state.currentNotePath.split("/").pop().replace(/\.md$/i, "");
  const lowered = query.toLowerCase();
  const doc = editorView.state.doc;
  const matches = [];

  for (let line = 1; line <= doc.lines && matches.length < 100; line++) {
    const text = doc.line(line).text;

    if (text.toLowerCase().includes(lowered)) {
      matches.push({
        path: state.currentNotePath,
        name,
        line,
        preview: text.trim().slice(0, 120),
      });
    }
  }

  return matches;
}

// ## Render search matches for a query.
async function renderSearchResults(query) {
  const results = document.getElementById("search-results");
  const request = ++searchRequest;
  const matches = !query
    ? []
    : searchAllNotes
      ? await invoke("search_notes", { query })
      : searchCurrentNote(query);

  // A newer query finished (or started) in the meantime, keep its results instead.
  if (request !== searchRequest) return;

  results.innerHTML = "";

  matches.forEach((match, index) => {
    const row = document.createElement("div");
    row.className = index === 0 ? "item selected" : "item";

    const name = document.createElement("span");
    name.textContent = match.line > 0 ? `${match.name}:${match.line}` : match.name;

    const preview = document.createElement("span");
    preview.className = "result-preview";
    preview.textContent = match.preview;

    row.appendChild(name);
    row.appendChild(preview);
    row.addEventListener("click", async () => {
      toggleSearch(searchAllNotes);
      if (match.path !== state.currentNotePath) await openNote(match.path);
      if (match.line > 0) highlightEditorMatch(match.line, query);
    });
    results.appendChild(row);
  });
}

// ## Toggle the search overlay, in note scope or all-notes scope.
// Triggering an open overlay with the other scope switches it in place, keeping the
// typed query, so Cmd+F to Cmd+Shift+F widens a search instead of closing it.
export function toggleSearch(allNotes = false) {
  const search = document.getElementById("search");
  const input = document.getElementById("search-input");

  if (search.classList.contains("active") && searchAllNotes !== allNotes) {
    searchAllNotes = allNotes;
    input.placeholder = allNotes ? "Search all notes..." : "Search this note...";
    renderSearchResults(input.value);
    input.focus();
    return;
  }

  const isOpen = search.classList.toggle("active");

  if (isOpen) {
    closeOtherOverlays("search");

    searchAllNotes = allNotes;
    input.placeholder = allNotes ? "Search all notes..." : "Search this note...";
    input.value = "";
    document.getElementById("search-results").innerHTML = "";
    input.focus();
  } else {
    focusEditor();
  }
}

// ## Setup both pickers.
export function setupPickers() {
  const paletteInput = document.getElementById("command-palette-input");

  paletteInput.addEventListener("input", () => renderCommandResults(paletteInput.value));
  setupPickerKeys(paletteInput, document.getElementById("command-palette-results"));
  setupPickerDismiss(document.getElementById("command-palette"));

  document
    .getElementById("toggle-command-palette")
    .addEventListener("click", toggleCommandPalette);

  const searchInput = document.getElementById("search-input");

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSearchResults(searchInput.value), 200);
  });
  setupPickerKeys(searchInput, document.getElementById("search-results"));
  setupPickerDismiss(document.getElementById("search"));

  document.getElementById("open-search").addEventListener("click", () => toggleSearch());
  document
    .getElementById("open-search-all")
    .addEventListener("click", () => toggleSearch(true));
}
