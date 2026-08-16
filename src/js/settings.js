// # The settings modal and reading, applying and saving settings.toml.

import { closeOtherOverlays, editor, isMac, sidebar } from "./dom.js";
import { appConfirm, showToast } from "./dialogs.js";
import { focusEditor, remeasureEditor, setEditorLineNumbers } from "./editor.js";
import { shortcutActions, updateShortcutHints } from "./shortcuts.js";
import { state } from "./state.js";
import { getVersion, invoke } from "./tauri.js";

// ## The sidebar's default width, in pixels.
// Matches the default in settings.rs, so a fresh install, a settings.toml without a
// width, and a double click on the resize handle all land on the same sidebar.
export const defaultSidebarWidth = 250;

// ## The screen width, in CSS pixels, that counts as roomy enough for a sidebar.
// The widest phones stay under 500, while the smallest iPad is 744 across in portrait.
const screenMinWidth = 700;

// ## Open the sidebar on a roomy screen, for a settings.toml that was just created.
export function openSidebarOnRoomyScreen() {
  if (window.screen.width < screenMinWidth) return;

  updateSetting("sidebar-startup", true);
  sidebar.classList.remove("hidden");
}

// ## Read one key from the settings section.
export function getSetting(key) {
  return state.settings["settings"][key];
}

// ## Write one key to the settings section and persist it, skipping no-op writes.
export function updateSetting(key, value) {
  if (state.settings["settings"][key] === value) return;

  state.settings["settings"][key] = value;
  saveSettings();
}

// ## Persist the working copy and re-apply it to the interface.
export async function saveSettings() {
  await invoke("save_settings", { newSettings: state.settings });

  applySettings();
}

// ## Toggle the settings modal.
export function toggleSettings() {
  const isOpen = document.getElementById("settings").classList.toggle("active");

  if (isOpen) {
    closeOtherOverlays("settings");

    // Focus the scrollable content, so the arrow keys scroll it right away.
    document.querySelector("#settings .content-area").focus();

    // Let go of the editor's selection too, since the focus alone does not do it. The
    // app is user-select: none everywhere but the note text, and a click on such a spot
    // leaves the editable selection standing, which keeps catching the typing.
    window.getSelection()?.removeAllRanges();
  } else {
    focusEditor();
  }
}

// ## Match the native webview background color to the theme.
// The native color shows wherever the page does not paint, like the mobile overscroll
// areas, and would otherwise stay the startup color from tauri.conf.json.
function applyWindowBackground() {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-bg-primary")
    .trim();

  const parts = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!parts) return;

  invoke("set_background_color", {
    red: parseInt(parts[1], 16),
    green: parseInt(parts[2], 16),
    blue: parseInt(parts[3], 16),
  });
}

// ## Reflect the settings in the interface and the modal's controls.
export function applySettings(init = false) {
  const settings = state.settings["settings"];

  // Line numbers.
  document.getElementById("toggle-line-numbers").checked = settings["line-numbers"];
  setEditorLineNumbers(settings["line-numbers"]);

  // Where the caret goes when a note opens, and whether the editor takes the focus.
  document.getElementById("open-note-focus-select").value = settings["open-note-focus"];

  // Editor font and line height. A bare number works as a font size too.
  const fontSize = String(settings["font-size"] ?? "").trim();
  document.getElementById("font-size-input").value = settings["font-size"];
  editor.style.fontSize = /^\d+(\.\d+)?$/.test(fontSize) ? `${fontSize}px` : fontSize;

  // The font family input also previews the note font it sets.
  const fontFamilyInput = document.getElementById("font-family-input");
  fontFamilyInput.value = settings["font-family"];
  fontFamilyInput.style.fontFamily = settings["font-family"];
  editor.style.fontFamily = settings["font-family"];

  document.getElementById("line-height-input").value = settings["line-height"];
  editor.style.lineHeight = settings["line-height"];

  // Line width caps the editor's content and centers it, through the CSS variable
  // the editor's padding is computed from. A bare number counts as pixels, and an
  // empty value means the full editor width.
  const lineWidth = String(settings["line-width"] ?? "").trim();
  document.getElementById("line-width-input").value = settings["line-width"];
  editor.style.setProperty(
    "--editor-line-width",
    /^\d+(\.\d+)?$/.test(lineWidth) ? `${lineWidth}px` : lineWidth || "100%",
  );

  // Word spacing needs a unit, so a bare number counts as pixels.
  const wordSpacing = String(settings["word-spacing"] ?? "").trim();
  document.getElementById("word-spacing-input").value = settings["word-spacing"];
  editor.style.wordSpacing = /^-?\d+(\.\d+)?$/.test(wordSpacing)
    ? `${wordSpacing}px`
    : wordSpacing;

  remeasureEditor();

  // The interface font overrides both built-in font stacks, so every part of the app
  // follows it. The editor's own font setting still wins in the editor.
  const uiFont = String(settings["ui-font-family"] ?? "").trim();
  document.getElementById("ui-font-family-input").value = settings["ui-font-family"];
  ["--font-mono", "--font-sans"].forEach((name) =>
    uiFont
      ? document.documentElement.style.setProperty(name, uiFont)
      : document.documentElement.style.removeProperty(name),
  );

  // Sidebar at startup.
  document.getElementById("toggle-sidebar-startup").checked = settings["sidebar-startup"];
  if (init) {
    sidebar.classList.toggle("hidden", !settings["sidebar-startup"]);
  }

  // Sidebar width, never below the minimum the resize handle also enforces, so a
  // hand-edited settings.toml cannot go under it either. The 16px scrollbar is
  // carved out of the width, so the 172px minimum keeps 156px of real content.
  const sidebarWidth = parseInt(settings["sidebar-width"], 10);
  document.documentElement.style.setProperty(
    "--sidebar-width",
    sidebarWidth ? `${Math.max(sidebarWidth, 172)}px` : `${defaultSidebarWidth}px`,
  );

  // ## Window controls styling.
  const windowControls = settings["window-controls"];
  document.getElementById("window-controls-select").value = windowControls;
  document
    .getElementById("titlebar")
    .classList.toggle(
      "macos",
      windowControls === "macos" || (windowControls === "auto" && isMac),
    );

  document.getElementById("theme-select").value = settings["theme"];
  document.documentElement.setAttribute("data-theme", settings["theme"]);
  applyWindowBackground();

  // Shortcut hints in the context menu.
  updateShortcutHints();
}

// ## Spell a stored shortcut the way the settings inputs take it.
// "CmdOrCtrl" is shown as "Cmd/Ctrl" and "Alt" as "Option/Alt", so the OR reads as a /
// with the Mac name first. Chose for this setup cause ⌘ and ⌥ are a pain to type.
function readableShortcut(shortcut) {
  return shortcut.replace("CmdOrCtrl", "Cmd/Ctrl").replace(/alt|option/i, "Option/Alt");
}

// ## Build the editable shortcut inputs in the settings modal.
function buildShortcutSettings() {
  const container = document.getElementById("shortcuts-settings");
  container.innerHTML = "";

  Object.entries(shortcutActions).forEach(([action, definition]) => {
    const field = document.createElement("div");

    const heading = document.createElement("h3");
    heading.textContent = definition.name;

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = definition.hint;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `e.g. ${readableShortcut(definition.default)}`;
    input.value = readableShortcut(state.settings["shortcuts"][action] || "");

    input.addEventListener("blur", () => {
      state.settings["shortcuts"][action] = input.value
        .trim()
        .replace(/cmd\/ctrl|ctrl\/cmd/gi, "CmdOrCtrl")
        .replace(/option\/alt|alt\/option|option|⌥/gi, "Alt");
      saveSettings();
    });

    // Keep the shortcut dispatcher from firing while typing in here.
    input.addEventListener("keydown", (event) => event.stopPropagation());

    field.append(heading, hint, input);
    container.appendChild(field);
  });
}

// ## Show the config file location.
// Falls back to showing the path on platforms without a file manager to reveal it in.
export async function openSettingsLocation() {
  try {
    await invoke("open_settings_location");
  } catch (settingsPath) {
    showToast(`Config file location: ${settingsPath}`);
  }
}

// ## Show the notes folder location.
// Falls back to showing the path on platforms without a file manager to reveal it in.
export async function openNotesLocation() {
  try {
    await invoke("open_notes_location");
  } catch (notesPath) {
    showToast(`Notes folder location: ${notesPath}`);
  }
}

// ## Bind one settings control to one settings key.
function bindSetting(id, eventName, key, readValue) {
  document.getElementById(id).addEventListener(eventName, function () {
    updateSetting(key, readValue(this));
  });
}

// ## Wire up the settings modal.
export function setupSettings() {
  applySettings(true);
  buildShortcutSettings();

  // The app version and tagline at the bottom of the settings.
  getVersion().then((version) => {
    document.getElementById("app-version").textContent =
      `Minoo V${version} - Organised, Focused, Private.`;
  });

  // The arrow keys scroll the settings, unless a control is using them.
  const contentArea = document.querySelector("#settings .content-area");
  document.getElementById("settings").addEventListener("keydown", (event) => {
    if (event.target.closest("input, select, textarea")) return;

    const step = {
      ArrowDown: 60,
      ArrowUp: -60,
      PageDown: contentArea.clientHeight,
      PageUp: -contentArea.clientHeight,
    }[event.key];
    if (!step) return;

    event.preventDefault();
    contentArea.scrollBy({ top: step, behavior: "smooth" });
  });

  // Focusing a text input selects its content, ready to type over. The select waits
  // a tick, so the click that gave the focus cannot collapse it to a caret again.
  document.getElementById("settings").addEventListener("focusin", (event) => {
    if (!event.target.matches("input[type='text']")) return;

    setTimeout(() => event.target.select(), 0);
  });

  // Open and close from the sidebar button, the context menu, the backdrop, and the
  // close button.
  ["toggle-settings", "settings-window-bg", "settings-window-close", "open-settings"].forEach(
    (id) => document.getElementById(id).addEventListener("click", toggleSettings),
  );

  bindSetting("toggle-line-numbers", "change", "line-numbers", (el) => el.checked);
  bindSetting("open-note-focus-select", "change", "open-note-focus", (el) => el.value);
  bindSetting("font-size-input", "blur", "font-size", (el) => el.value);
  bindSetting("font-family-input", "blur", "font-family", (el) => el.value);
  bindSetting("line-height-input", "blur", "line-height", (el) => el.value);
  bindSetting("word-spacing-input", "blur", "word-spacing", (el) => el.value);
  bindSetting("line-width-input", "blur", "line-width", (el) => el.value);
  bindSetting("ui-font-family-input", "blur", "ui-font-family", (el) => el.value);
  bindSetting("toggle-sidebar-startup", "change", "sidebar-startup", (el) => el.checked);
  bindSetting("window-controls-select", "change", "window-controls", (el) => el.value);
  bindSetting("theme-select", "change", "theme", (el) => el.value);

  document
    .getElementById("open-settings-location")
    .addEventListener("click", openSettingsLocation);
  document.getElementById("open-notes-location").addEventListener("click", openNotesLocation);

  // Reset settings to defaults and re-apply them without needing a restart.
  document.getElementById("reset-settings").addEventListener("click", async () => {
    const message = "Reset all settings to their defaults? This cannot be undone.";
    if (!(await appConfirm(message, "Reset"))) return;

    state.settings = await invoke("reset_settings");
    applySettings();
    buildShortcutSettings();
    openSidebarOnRoomyScreen();
  });
}
