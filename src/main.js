// # Minoo's frontend entry point.
// This file loads the settings and wires everything up in the correct dependency order.

import { setupContextMenu } from "./js/context-menu.js";
import { isAndroid, isMobile } from "./js/dom.js";
import { setupDragAndDrop } from "./js/drag-drop.js";
import { setupTouchGestures } from "./js/gestures.js";
import { setupEditor } from "./js/editor.js";
import { setupSidebarNotes, setupRenaming } from "./js/sidebar-notes.js";
import { setupPickers } from "./js/picker.js";
import { setupSelection } from "./js/selection.js";
import { openSidebarOnRoomyScreen, setupSettings } from "./js/settings.js";
import { setupShortcuts } from "./js/shortcuts.js";
import { setupSidebar, setupSidebarResize } from "./js/sidebar.js";
import { state } from "./js/state.js";
import { setupSync } from "./js/sync.js";
import { invoke } from "./js/tauri.js";
import { setupCustomTitlebar, setupMainWindow, setupMenuActions } from "./js/window.js";

async function initialise() {
  // The stylesheet starts on the mobile layout, so mobile never flashes a titlebar it
  // does not have, this class turns the titlebar and its offsets on for desktop.
  document.documentElement.classList.add(isMobile ? "mobile" : "desktop");

  if (isAndroid) {
    document.documentElement.classList.add("android");

    /* Android draws the app under notches and OS nav buttons, this is part of the fix to fit the app on screen. */
    const viewport = document.querySelector('meta[name="viewport"]');
    viewport.content += ", viewport-fit=cover";
  }

  setupMainWindow();
  setupCustomTitlebar();
  setupContextMenu();

  const freshInstall = await invoke("init_settings_file");
  state.settings = await invoke("load_settings");

  setupSettings();
  setupShortcuts();
  setupMenuActions();

  await setupSidebarNotes();
  setupSidebar();
  setupSidebarResize();
  setupTouchGestures();
  setupRenaming();
  setupSelection();
  setupDragAndDrop();

  setupPickers();
  await setupSync();

  setupEditor();

  // A fresh settings.toml leaves the sidebar closed, since Rust cannot measure the
  // screen. The running app can, so it opens the sidebar here on a roomy one.
  if (freshInstall) openSidebarOnRoomyScreen();
}

// "Engage." - Captain Jean-Luc Picard, Star Trek: The Next Generation (1987)
window.addEventListener("DOMContentLoaded", initialise);
