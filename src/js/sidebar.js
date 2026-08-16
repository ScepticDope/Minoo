// # The sidebar. Showing, hiding and resizing it.

import { editor, sidebar } from "./dom.js";
import { editorView } from "./editor.js";
import { createNewFolder, createNewNote, setupSidebarClicks } from "./sidebar-notes.js";
import { defaultSidebarWidth, updateSetting } from "./settings.js";

// ## Toggle the sidebar, shared by the shortcuts, context menu, and command palette.
export function toggleSidebar() {
  sidebar.classList.toggle("hidden");
}

// ## Wire up the sidebar's buttons and the note tree clicks.
export function setupSidebar() {
  ["toggle-sidebar", "close-sidebar"].forEach((id) => {
    const button = document.getElementById(id);

    button.addEventListener("click", () => {
      toggleSidebar();
      button.blur();
    });
  });

  document.getElementById("new-note").addEventListener("click", createNewNote);
  document.getElementById("new-folder").addEventListener("click", createNewFolder);

  // Hide the sidebar when a cramped editor gets focus.
  editorView.contentDOM.addEventListener("focus", () => {
    // Timeout needed to not clash with another toggleSidebar() call, racing the classlist too soon otherwise.
    setTimeout(() => {
      if (
        editor.getBoundingClientRect().width < 250 &&
        !sidebar.classList.contains("hidden")
      ) {
        toggleSidebar();
      }
    }, 0);
  });

  setupSidebarClicks();
}

// ## Put the sidebar back at its default width.
// The variable is set here too, so the sidebar snaps back without waiting for the
// settings to be written.
function resetSidebarWidth() {
  document.documentElement.style.setProperty("--sidebar-width", `${defaultSidebarWidth}px`);

  updateSetting("sidebar-width", `${defaultSidebarWidth}px`);
}

// ## Resize the sidebar by dragging its right edge, double click to reset the width.
// Pointer events cover both the mouse on desktop and touch on Android and iOS.
export function setupSidebarResize() {
  const resizeHandle = document.getElementById("sidebar-resize");
  let resizing = false;

  // How long after a tap a second one still counts as a double tap.
  const doubleTapDelay = 400;
  let lastTapTime = 0;

  // The drag needs no preventDefault here. Text selection is already off app-wide and
  // the handle carries touch-action: none, while cancelling pointerdown would take the
  // double click below down with it.
  resizeHandle.addEventListener("pointerdown", (event) => {
    resizing = true;
    resizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar");

    // A touch has no dependable dblclick, so a second tap in time resets the width from
    // here. The resize this tap just started is called off, since a finger never lands
    // twice on the same pixel and its drift would drag the sidebar right back off the
    // default width.
    if (event.pointerType !== "mouse") {
      const isDoubleTap = Date.now() - lastTapTime < doubleTapDelay;
      lastTapTime = Date.now();

      if (isDoubleTap) {
        resizing = false;
        document.body.classList.remove("resizing-sidebar");

        resetSidebarWidth();
      }
    }
  });

  resizeHandle.addEventListener("pointermove", (event) => {
    if (!resizing) return;

    // The sidebar has 20px padding on each side, the width setting is the inner width.
    // Its 16px scrollbar is carved out of that width, so the 172px minimum keeps
    // 156px of real content.
    const width = Math.min(Math.max(event.clientX - 40, 172), 500);
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  });

  resizeHandle.addEventListener("pointerup", () => {
    if (!resizing) return;

    resizing = false;
    document.body.classList.remove("resizing-sidebar");

    const width = getComputedStyle(document.documentElement)
      .getPropertyValue("--sidebar-width")
      .trim();

    updateSetting("sidebar-width", width);
  });

  // Double clicking the handle resets the width, on the platforms that have a mouse.
  // Touch is served by the double tap above, and a device with both never gets two
  // resets from one gesture, since only one of the two paths sees any given pointer.
  resizeHandle.addEventListener("dblclick", resetSidebarWidth);
}
