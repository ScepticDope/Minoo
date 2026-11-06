// # The picker, one overlay for the command palette and both searches.
// Switching between them only changes the rows below the input, the input itself keeps
// its place and the focus. Mobile webviews scroll every newly focused element into view,
// and focusing the editor schedules a scroll of the page as well, so handing the focus
// around on a switch can push the input off the top of the screen.

import { closeOtherOverlays, isLinux, isMobile } from "./dom.js";
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

const picker = document.getElementById("picker");
const input = document.getElementById("picker-input");
const results = document.getElementById("picker-results");

// ## The picker's modes and what the input asks for in each.
const placeholders = {
  commands: "Type a command...",
  note: "Search this note...",
  all: "Search all notes...",
};

// ## The picker's state.
let mode = "commands";
let searchTimer = null;
let searchRequest = 0;

// ## Shared list navigation for the picker.
function setupPickerKeys() {
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

// ## The command palette.
function paletteCommands() {
  const commands = [
    { name: "New Note", run: createNewNote },
    { name: "New Folder", run: createNewFolder },
    { name: "Toggle Sidebar", run: toggleSidebar },
    { name: "Search Note", mode: "note" },
    { name: "Search All Notes", mode: "all" },
    { name: "Sync Now", run: syncNow },
    { name: "Settings", run: toggleSettings },
    { name: "Config File Location", run: openSettingsLocation },
    { name: "Notes Folder Location", run: openNotesLocation },
  ];

  // Mobile has one fullscreen window, so none of these would do anything there.
  if (!isMobile) {
    commands.push({ name: "Toggle Fullscreen", run: toggleFullscreen });

    // Linux desktops place windows natively, Wayland does not let an app do it itself.
    if (!isLinux) {
      commands.push(
        { name: "Center Window", run: centerWindow },
        { name: "Tile Window Left", run: () => tileWindow() },
        { name: "Tile Window Right", run: () => tileWindow(true) },
      );
    }
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
  searchRequest++;

  results.innerHTML = "";

  const matching = paletteCommands().filter((command) =>
    command.name.toLowerCase().includes(query.toLowerCase()),
  );

  matching.forEach((command, index) => {
    const row = document.createElement("div");

    row.className = index === 0 ? "item selected" : "item";
    row.textContent = command.name;
    row.addEventListener("click", () => {
      if (command.mode) {
        togglePicker(command.mode);
      } else {
        closePicker();
        command.run();
      }
    });

    results.appendChild(row);
  });
}

// ## Search the currently open note.
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
  const request = ++searchRequest;
  const matches = !query
    ? []
    : mode === "all"
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
      closePicker();
      if (match.path !== state.currentNotePath) await openNote(match.path);
      if (match.line > 0) highlightEditorMatch(match.line, query);
    });
    results.appendChild(row);
  });
}

// ## Render the rows of the current mode for the typed query.
function renderResults() {
  clearTimeout(searchTimer);

  if (mode === "commands") renderCommandResults(input.value);
  else renderSearchResults(input.value);
}

// ## Close the picker and give the focus back to the editor.
function closePicker() {
  picker.classList.remove("active");

  focusEditor();
}

// ## Open the picker in a mode, or close it when it already shows that mode.
// Triggering an open picker with another mode switches it in place.
export function togglePicker(nextMode) {
  const isOpen = picker.classList.contains("active");

  if (isOpen && mode === nextMode) {
    closePicker();
    return;
  }

  // Switching between the searches keeps the typed query, so Cmd+F to Cmd+Shift+F widens
  // a search instead of losing it. A command filter makes no sense as a query, or the
  // other way around, so anything else starts empty.
  if (!isOpen || mode === "commands" || nextMode === "commands") input.value = "";

  mode = nextMode;
  input.placeholder = placeholders[mode];

  picker.classList.add("active");
  closeOtherOverlays("picker");

  renderResults();

  // All modes share this list, so each starts at its top.
  results.scrollTop = 0;

  // Focusing an input that has the focus already still makes iOS scroll to reveal it.
  if (document.activeElement !== input) input.focus();
}

// ## Setup the picker.
export function setupPicker() {
  // The commands filter right away, the searches wait for a pause in the typing.
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);

    if (mode === "commands") renderResults();
    else searchTimer = setTimeout(renderResults, 200);
  });

  setupPickerKeys();

  // A press on a row would blur the input before its click runs, taking the keyboard with
  // it on mobile, so the rows leave the focus where it is.
  results.addEventListener("mousedown", (event) => event.preventDefault());

  // Close the picker when clicking next to its window.
  picker.addEventListener("click", (event) => {
    if (event.target === picker) closePicker();
  });

  document
    .getElementById("toggle-command-palette")
    .addEventListener("click", () => togglePicker("commands"));
  document
    .getElementById("open-search")
    .addEventListener("click", () => togglePicker("note"));
  document
    .getElementById("open-search-all")
    .addEventListener("click", () => togglePicker("all"));
}
