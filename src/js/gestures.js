// # Touch gestures.
// Touch equivalents for mouse-only interactions on Android and iOS. Swipes for the
// sidebar and command palette, holds and three-finger touches for the context menu.

import { positionContextMenu, updateContextMenuSections } from "./context-menu.js";
import { sidebarNotes, sidebar } from "./dom.js";
import { editorView } from "./editor.js";
import { toggleCommandPalette } from "./picker.js";
import { toggleSidebar } from "./sidebar.js";

export function setupTouchGestures() {
  const customContextMenu = document.getElementById("context-menu");

  // How far a swipe must travel, and how close to a screen edge it must start.
  const swipeDistance = 60;
  const edgeSize = 30;

  // How long a hold must stay put to open the menu, and how far it may drift. The
  // menu only opens once the finger lifts. DOM changes mid-gesture would cancel the
  // webview's native long-press drag (see setupDragAndDrop). That drag kicks in after
  // roughly half a second, so the delay stays well below it to leave room to release.
  const holdDelay = 300;
  const holdSlop = 10;

  let swipeStart = null;
  let holdStart = null; // { x, y, time, target } while a touch could become a hold.
  let menuOpenedMidTouch = false;

  // ## Open the context menu as if the target was right-clicked there.
  function openContextMenuFromTouch(target, pageX, pageY) {
    const touchPoint = { target, pageX, pageY };

    if (updateContextMenuSections(touchPoint)) {
      positionContextMenu(customContextMenu, touchPoint);
      swipeStart = null;
      return true;
    }

    return false;
  }

  document.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches[0];

      // A three-finger touch on the editor opens the context menu right away.
      // preventDefault blocks the webview's own three-finger gestures.
      if (event.touches.length === 3 && event.target.closest("#editor")) {
        event.preventDefault();
        holdStart = null;
        menuOpenedMidTouch = openContextMenuFromTouch(
          editorView.contentDOM,
          touch.pageX,
          touch.pageY,
        );
        return;
      }

      // Swipes and holds are single-finger gestures, a second finger cancels them.
      if (event.touches.length !== 1) {
        swipeStart = null;
        holdStart = null;
        return;
      }

      // A rename in progress owns the sidebar's touches. Its input sits inside the
      // entry, so dragging the text selection would otherwise read as a swipe or a hold.
      const renaming = !!sidebarNotes.querySelector(".rename-input");

      // Swipes only run on the main workspace, not in the overlays.
      swipeStart =
        event.target.closest(".modal, .picker, #confirm, #context-menu") ||
        (renaming && event.target.closest("#sidebar"))
          ? null
          : { x: touch.clientX, y: touch.clientY, target: event.target };

      // A touch on a sidebar entry may become a hold-to-open.
      holdStart =
        !renaming &&
        event.target.closest("#sidebar-notes .item, #sidebar-notes .folder > .label")
          ? { x: touch.clientX, y: touch.clientY, time: Date.now(), target: event.target }
          : null;
    },
    { passive: false },
  );

  // Moving off the entry means scrolling (or dragging), not holding.
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!holdStart) return;

      const touch = event.touches[0];
      if (
        Math.abs(touch.clientX - holdStart.x) > holdSlop ||
        Math.abs(touch.clientY - holdStart.y) > holdSlop
      ) {
        holdStart = null;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchend",
    (event) => {
      // Swallow the click that follows the touch, so it neither closes the menu
      // the touch just opened nor activates what is under the finger.
      if (menuOpenedMidTouch) {
        event.preventDefault();
        if (event.touches.length === 0) menuOpenedMidTouch = false;
        return;
      }

      // Releasing a hold that stayed put long enough opens the context menu.
      if (holdStart && event.touches.length === 0) {
        const hold = holdStart;
        holdStart = null;

        if (Date.now() - hold.time >= holdDelay) {
          const touch = event.changedTouches[0];
          if (openContextMenuFromTouch(hold.target, touch.pageX, touch.pageY)) {
            event.preventDefault();
            return;
          }
        }
      }

      if (!swipeStart || event.touches.length > 0) return;

      const touch = event.changedTouches[0];
      const start = swipeStart;
      swipeStart = null;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;

      // Only clearly horizontal movements count as swipes, so scrolling stays scrolling.
      if (Math.abs(deltaX) < swipeDistance || Math.abs(deltaX) < Math.abs(deltaY) * 2) {
        return;
      }

      const sidebarHidden = sidebar.classList.contains("hidden");

      if (deltaX < 0 && start.x > window.innerWidth - edgeSize) {
        // Swiping in from the right edge opens the command palette.
        if (!document.getElementById("command-palette").classList.contains("active")) {
          toggleCommandPalette();
        }
      } else if (deltaX < 0 && !sidebarHidden && start.target.closest("#sidebar")) {
        // Swiping the sidebar to the left hides it.
        toggleSidebar();
      } else if (deltaX > 0 && sidebarHidden && start.x < edgeSize) {
        // Swiping in from the left edge brings the sidebar back.
        toggleSidebar();

        // This blur is needed for the cramped editor focus bug.
        editorView.contentDOM.blur();
      }
    },
    { passive: false },
  );

  // The webview fires touchcancel when its native long-press drag takes over,
  // handing the entry from the hold gesture to the drag.
  document.addEventListener("touchcancel", () => {
    swipeStart = null;
    holdStart = null;
    menuOpenedMidTouch = false;
  });

  // Fallback for drags that start without a touchcancel. The style is only written
  // when the menu is actually open. DOM changes during dragstart cancel the native
  // drag in WebKit, see setupDragAndDrop.
  sidebarNotes.addEventListener("dragstart", () => {
    holdStart = null;
    if (customContextMenu.style.display === "block") {
      customContextMenu.style.display = "none";
    }
  });
}
