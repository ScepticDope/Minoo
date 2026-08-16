// # The main window and its custom titlebar.

import { isMobile } from "./dom.js";
import { flushNoteSave, focusEditor, redoEditor, undoEditor } from "./editor.js";
import { shortcutActions } from "./shortcuts.js";
import { syncNow } from "./sync.js";
import {
  currentMonitor,
  getCurrentWindow,
  invoke,
  listen,
  PhysicalPosition,
  PhysicalSize,
} from "./tauri.js";

// ## Show the window, then put the caret in the editor.
// The window starts hidden to avoid a white flash, see the `show_window` command.
// The window state plugin has already put it back where it was by now, a first launch
// gets the centered window from tauri.conf.json instead.
export function setupMainWindow() {
  // Mobile has no window to place, and no `show_window` command.
  if (!isMobile) {
    invoke("show_window");

    // Pick up a restored fullscreen window, see `fullscreen` below.
    getCurrentWindow()
      .isFullscreen()
      .then((restored) => {
        fullscreen = restored;

        markFullscreen();
      });
  }

  focusEditor();
}

// ## Toggle the window between fullscreen and normal.
// Shared by the shortcut, the command palette, the menu item, and the macOS-style
// green dot. The window's own fullscreen report is unreliable on macOS, so the state
// lives here; every fullscreen path goes through this toggle, which keeps it in step.
// Startup is the exception, since nothing is in transition there and the plugin has to
// be asked what it restored.
let fullscreen = false;

export function toggleFullscreen() {
  // Mobile is always fullscreen.
  if (isMobile) return;

  fullscreen = !fullscreen;
  getCurrentWindow().setFullscreen(fullscreen);

  markFullscreen();
}

// ## Carry the fullscreen state over to the titlebar.
// The macOS-style green dot shows the way out of fullscreen while it is in it, exactly
// like the real one, which takes a hook for the CSS.
function markFullscreen() {
  document.getElementById("titlebar").classList.toggle("fullscreen", fullscreen);
}

// ## Let go of a fullscreen or maximized window, so a new placement can stick.
// macOS animates its way out of fullscreen and only lands on its old frame afterwards,
// so a placement set during that ride would be undone. Hence the wait, no event marks
// the landing, see `minimizeWindow` below for the same problem.
async function releaseWindow() {
  const currentWindow = getCurrentWindow();

  if (fullscreen) {
    toggleFullscreen();

    await new Promise((resolve) => setTimeout(resolve, 600));
  } else if (await currentWindow.isMaximized()) {
    await currentWindow.toggleMaximize();
  }
}

// ## Center the window on its screen.
export async function centerWindow() {
  // Mobile has no window to place.
  if (isMobile) return;

  await releaseWindow();

  getCurrentWindow().center();
}

// ## Move and resize the window to the left or right half of its screen.
// The monitor's work area is used rather than its full size, since that one leaves out
// the menu bar and the dock. Everything here is in physical pixels, which is what the
// monitor reports and what the window setters take.
// The size goes first: a macOS resize holds on to the window's bottom left corner and
// moves its top edge, so a position set before it would not survive the resize.
export async function tileWindow(toRight) {
  if (isMobile) return;

  const monitor = await currentMonitor();
  if (!monitor) return;

  await releaseWindow();

  const { position, size } = monitor.workArea;
  const width = Math.round(size.width / 2);

  const currentWindow = getCurrentWindow();

  await currentWindow.setSize(new PhysicalSize(width, size.height));

  await currentWindow.setPosition(
    new PhysicalPosition(toRight ? position.x + size.width - width : position.x, position.y),
  );
}

// ## Minimize the window, leaving fullscreen first when needed.
// macOS ignores a minimize while fullscreen and during the whole exit transition,
// and no event marks when the window has landed. So after leaving fullscreen the
// minimize is retried until the window reports it actually stuck.
async function minimizeWindow() {
  const currentWindow = getCurrentWindow();

  if (!fullscreen) {
    currentWindow.minimize();

    return;
  }

  toggleFullscreen();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));

    currentWindow.minimize();

    if (await currentWindow.isMinimized()) return;
  }
}

// ## Drag the titlebar out of fullscreen, and double click it to (un)maximize.
// The drag region cannot move a fullscreen window, so while fullscreen dragging it
// exits fullscreen instead. A plain double click always zooms the window bounds,
// like a native titlebar would, regardless of what the maximize button itself does.
function setupTitlebarDragAndDoubleClick(titlebar, currentWindow) {
  const isDragRegion = (event) =>
    event.button === 0 && event.target.hasAttribute("data-tauri-drag-region");

  titlebar.addEventListener("mousedown", (event) => {
    if (!fullscreen || !isDragRegion(event) || event.detail !== 1) return;

    // Only a real drag exits, a plain click (and its pixel of jitter) does nothing.
    const startX = event.screenX;
    const startY = event.screenY;

    const exitOnDrag = (move) => {
      if (Math.abs(move.screenX - startX) < 5 && Math.abs(move.screenY - startY) < 5) return;
      stopWatching();
      toggleFullscreen();
    };

    const stopWatching = () => {
      window.removeEventListener("mousemove", exitOnDrag);
      window.removeEventListener("mouseup", stopWatching);
    };

    window.addEventListener("mousemove", exitOnDrag);
    window.addEventListener("mouseup", stopWatching);
  });

  titlebar.addEventListener("dblclick", (event) => {
    if (!isDragRegion(event)) return;

    if (fullscreen) toggleFullscreen();
    else currentWindow.toggleMaximize();
  });
}

// ## The custom titlebar's window controls (the titlebar itself is hidden on mobile).
export function setupCustomTitlebar() {
  const currentWindow = getCurrentWindow();
  const titlebar = document.getElementById("titlebar");

  const actions = {
    minimize: minimizeWindow,
    // With the macOS-style controls the green dot goes fullscreen, like macOS does.
    // Either style leaves fullscreen on click, since toggleMaximize does nothing there.
    maximize: () =>
      fullscreen || titlebar.classList.contains("macos")
        ? toggleFullscreen()
        : currentWindow.toggleMaximize(),
    close: async () => {
      // Make sure a pending autosave isn't lost on the way out.
      await flushNoteSave();
      currentWindow.close();
    },
  };

  Object.entries(actions).forEach(([id, handler]) => {
    document.getElementById(`titlebar-${id}`)?.addEventListener("click", handler);
  });

  setupTitlebarDragAndDoubleClick(titlebar, currentWindow);
}

// ## Run an edit action where the focus is.
// The editor keeps its own undo history, so the webview's native undo cannot serve it.
// A focused text input still has nothing but the native one.
function runEditAction(editorAction, command) {
  if (document.activeElement?.closest("input, textarea")) {
    document.execCommand(command);
  } else {
    editorAction();
  }
}

// ## The macOS menu bar's custom items, arriving as events from the backend.
// Most ids match a shortcut action, so the menu and the shortcuts stay in step.
// The rest are the window items the undecorated window cannot serve natively.
export function setupMenuActions() {
  // The About panel's copyright year comes from here, since JS knows the local date
  // without any date math on the Rust side. About is for macOS only for now.
  // TODO - Maybe need to support an about for Linux later.
  if (!isMobile) invoke("menu_set_year", { year: new Date().getFullYear() });

  const menuOnlyActions = {
    minimize: minimizeWindow,
    zoom: () => getCurrentWindow().toggleMaximize(),
    "sync-now": () => syncNow(),
    undo: () => runEditAction(undoEditor, "undo"),
    redo: () => runEditAction(redoEditor, "redo"),
  };

  // ## Run the handler for the clicked menu item's id.
  listen("menuAction", ({ payload }) => {
    const action = menuOnlyActions[payload] ?? shortcutActions[payload]?.run;
    action?.();
  });
}
