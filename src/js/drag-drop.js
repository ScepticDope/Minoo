// # Drag and drop for sidebar entries (notes and folders).

import { showToast } from "./dialogs.js";
import { isIOS, sidebar, sidebarNotes } from "./dom.js";
import {
  applyEntryMove,
  renderSidebarNotes,
  sortSidebarTree,
  updateFolderCount,
} from "./sidebar-notes.js";
import { clearSelection, selectionTargets } from "./selection.js";
import { scheduleAutoSync } from "./sync.js";
import { invoke } from "./tauri.js";

export function setupDragAndDrop() {
  const placeholder = document.createElement("div");
  placeholder.className = "drag-placeholder";

  // The grabbed entry, and every entry moving along with it. Grabbing an entry of the
  // multi-selection (see selection.js) drags the whole selection, any other grab drags
  // just that entry.
  let draggedElement = null;
  let draggedEntries = [];

  // Open folders collapse for the duration of the drag and reopen when it ends, their
  // persisted state (see saveFolderCollapseStatus) never changes.
  let reopenFolders = [];
  let dragGhost = null;

  // When the last drag event fired, used to spot sessions that died without a dragend.
  let lastDragEvent = 0;

  // The native drag snapshot always sits under the grab point (WebKit clamps
  // setDragImage offsets), so it gets replaced by a transparent pixel and a
  // ghost clone element that follows the pointer instead.
  const blankCanvas = document.createElement("canvas");
  blankCanvas.width = 1;
  blankCanvas.height = 1;

  const blankDragImage = new Image();
  blankDragImage.src = blankCanvas.toDataURL();

  // ## Keep the ghost clone just off the bottom right of the pointer.
  function positionDragGhost(x, y) {
    dragGhost.style.left = `${x + 14}px`;
    dragGhost.style.top = `${y + 14}px`;
  }

  // ## Scroll the sidebar while the pointer drags along its top or bottom edge.
  // Dragging to an entry off screen needs the list to come along. A drag only fires
  // dragover while the pointer moves, so the events set the direction and a timer does
  // the scrolling, which keeps it going while the pointer rests in the edge zone.
  const edgeZone = 80;
  const edgeStep = 8;
  let edgeDirection = 0;
  let edgeTimer = null;

  function stopEdgeScroll() {
    clearInterval(edgeTimer);
    edgeTimer = null;
    edgeDirection = 0;
  }

  function updateEdgeScroll(event) {
    // iOS already has native scroll when dragging an element functionality.
    if (isIOS) return;

    const box = sidebar.getBoundingClientRect();
    const overSidebar =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;

    if (!overSidebar) return stopEdgeScroll();

    edgeDirection = 0;
    if (event.clientY - box.top < edgeZone) edgeDirection = -1;
    if (box.bottom - event.clientY < edgeZone) edgeDirection = 1;

    if (!edgeDirection) return stopEdgeScroll();

    // The running timer picks up a new direction on its own, restarting it on every
    // event would keep clearing it before it ever fires.
    if (!edgeTimer) {
      edgeTimer = setInterval(() => {
        sidebar.scrollTop += edgeDirection * edgeStep;
      }, 16);
    }
  }

  sidebarNotes.addEventListener("dragstart", (event) => {
    const target = event.target.closest(".item, .folder");
    if (!target || target.classList.contains("trash")) return;

    // A session that died without its dragend, see cleanupStaleDrag below, can leave
    // the previous ghost and faded entries behind, so both get swept further down.
    const staleGhost = dragGhost;

    // Grabbing outside the selection clears it, like in a file explorer.
    if (!target.classList.contains("selected")) clearSelection();

    draggedElement = target;
    draggedEntries = selectionTargets(target);
    lastDragEvent = Date.now();

    const staleElements = [...sidebarNotes.querySelectorAll(".dragging")].filter(
      (el) => !draggedEntries.includes(el),
    );

    draggedEntries.forEach((entry) => entry.classList.add("dragging"));
    placeholder.classList.add("visible");
    event.dataTransfer.effectAllowed = "move";

    // Without any data in the transfer, WebKit ignores effectAllowed and
    // treats the drag as a copy, showing the plus badge on the cursor.
    event.dataTransfer.setData("text/plain", "");
    event.dataTransfer.setDragImage(blankDragImage, 0, 0);

    // For a folder, clone just the label so only the one row visually drags. A
    // multi-selection shows how many more entries move along as a badge.
    const ghostSource = target.classList.contains("folder")
      ? target.querySelector(":scope > .label")
      : target;

    dragGhost = ghostSource.cloneNode(true);
    dragGhost.className = "drag-ghost";
    dragGhost.style.width = `${ghostSource.getBoundingClientRect().width}px`;

    if (draggedEntries.length > 1) dragGhost.dataset.count = draggedEntries.length - 1;

    positionDragGhost(event.clientX, event.clientY);

    // Appending on the next tick keeps dragstart itself free of DOM changes,
    // which can cancel the native drag in WebKit (see the folder collapse below).
    setTimeout(() => {
      if (staleGhost) staleGhost.remove();

      staleElements.forEach((el) => el.classList.remove("dragging"));

      if (dragGhost) document.body.appendChild(dragGhost);
    }, 0);

    // Collapsing on the next tick (instead of during dragstart) keeps the
    // drag handoff itself untouched by the layout change, which otherwise
    // stalls dragover/drop.
    reopenFolders = draggedEntries.filter((el) => el.classList.contains("open"));

    if (reopenFolders.length) {
      setTimeout(() => reopenFolders.forEach((folder) => folder.classList.remove("open")), 0);
    }
  });

  // The nav's dragover below only covers the list itself, so tracking at the
  // document level keeps the ghost following the pointer everywhere.
  document.addEventListener("dragover", (event) => {
    if (!dragGhost) return;

    lastDragEvent = Date.now();

    positionDragGhost(event.clientX, event.clientY);
    updateEdgeScroll(event);
  });

  // WebKit (Tauri's macOS/iOS webview) only registers a drop zone if dragenter
  // is also prevented, since relying on dragover alone leaves drop silently inert.
  sidebarNotes.addEventListener("dragenter", (event) => {
    if (!draggedElement) return;

    event.preventDefault();

    // Declaring the move here as well stops the plus (copy) badge from
    // flashing while the pointer enters a new element.
    event.dataTransfer.dropEffect = "move";
  });

  // ## Clear all drag state, shared by the normal dragend and the stale fallback.
  function cleanupDrag() {
    stopEdgeScroll();

    sidebarNotes
      .querySelectorAll(".dragging, .drop-target")
      .forEach((el) => el.classList.remove("dragging", "drop-target"));

    placeholder.classList.remove("visible");
    placeholder.remove();

    if (dragGhost) dragGhost.remove();
    dragGhost = null;

    draggedElement = null;
    draggedEntries = [];

    // Give the folders collapsed on dragstart their open state back.
    reopenFolders.forEach((folder) => folder.classList.add("open"));
    reopenFolders = [];
  }

  sidebarNotes.addEventListener("dragend", cleanupDrag);

  // ## Sweep up after a drag session that died without its dragend.
  // On iOS the long press lifts the entry and fires dragstart before any movement, but
  // letting go right then abandons the session without a dragend, which would leave the
  // ghost stuck on screen forever. A live session keeps firing the dragover above, so a
  // touch while the ghost exists without recent drag activity means the session is dead.
  // The delayed recheck catches a release that arrives before the activity has aged.
  const staleDragDelay = 600;

  function cleanupStaleDrag() {
    if (!dragGhost) return;

    if (Date.now() - lastDragEvent > staleDragDelay) {
      cleanupDrag();
      return;
    }

    const ghost = dragGhost;
    setTimeout(() => {
      if (dragGhost === ghost && Date.now() - lastDragEvent > staleDragDelay) {
        cleanupDrag();
      }
    }, staleDragDelay);
  }

  document.addEventListener("touchstart", cleanupStaleDrag, { passive: true });
  document.addEventListener("touchend", cleanupStaleDrag, { passive: true });

  sidebarNotes.addEventListener("dragover", (event) => {
    if (!draggedElement) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    sidebarNotes
      .querySelectorAll(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));

    const hoveredFolder = event.target.closest(".folder");

    // Don't allow dropping a folder into itself or one of its own descendants.
    // The event still declares the move above, because leaving a dragover
    // unhandled makes WebKit fall back to the copy (plus) badge. Parking the
    // placeholder outside the tree turns a release here into a no-op instead,
    // since the drop handler bails when the placeholder has no parent.
    if (
      hoveredFolder &&
      draggedEntries.some((el) => el === hoveredFolder || el.contains(hoveredFolder))
    ) {
      placeholder.remove();
      return;
    }

    if (hoveredFolder) hoveredFolder.classList.add("drop-target");

    const container = hoveredFolder
      ? hoveredFolder.querySelector(":scope > .children")
      : sidebarNotes;

    const siblings = [
      ...container.querySelectorAll(":scope > .item, :scope > .folder"),
    ].filter((el) => !draggedEntries.includes(el));

    const nextSibling = siblings.find((sibling) => {
      const box = sibling.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });

    container.insertBefore(placeholder, nextSibling || null);
  });

  sidebarNotes.addEventListener("drop", async (event) => {
    if (!draggedEntries.length || !placeholder.parentElement) return;
    event.preventDefault();

    const targetFolder = placeholder.parentElement.closest(".folder");

    // dragend clears the drag state before the invokes below resolve.
    const dropped = [...draggedEntries];
    const sourceFolders = dropped.map((el) => el.parentElement.closest(".folder"));

    dropped.forEach((el) => placeholder.parentElement.insertBefore(el, placeholder));

    new Set([...sourceFolders, targetFolder]).forEach((folder) => {
      if (folder) updateFolderCount(folder);
    });

    sortSidebarTree();

    const newParent = targetFolder ? targetFolder.dataset.path : "";
    let moved = false;
    let failed = false;

    for (const entry of dropped) {
      const oldPath = entry.dataset.path;
      const oldParent = oldPath.includes("/")
        ? oldPath.slice(0, oldPath.lastIndexOf("/"))
        : "";
      if (newParent === oldParent) continue;

      try {
        const newPath = await invoke("move_entry", { path: oldPath, newParent });
        applyEntryMove(entry, oldPath, newPath);
        moved = true;
      } catch (error) {
        showToast(error);
        failed = true;
      }
    }

    if (moved) scheduleAutoSync();

    // Re-sync the sidebar with what is actually on disk.
    if (failed) renderSidebarNotes();
  });
}
