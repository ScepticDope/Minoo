// # Exports main elements for consistency and client platform info.

export const editor = document.getElementById("editor");
export const sidebarNotes = document.getElementById("sidebar-notes");
export const sidebar = document.getElementById("sidebar");

// ## The client platform targets, for specific behaviour and fixes.
// New iPads claim to be a Macintosh to get desktop sites.
// TODO - When apple releases a laptop with touch screen update this.
export const isAndroid = /Android/.test(navigator.userAgent);
export const isIOS =
  /iPad|iPhone/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const isMobile = isAndroid || isIOS;
export const isMac = !isMobile && /Macintosh/.test(navigator.userAgent);

// ## Close the other dialogs, so only one overlay is ever open.
const overlayIds = ["command-palette", "search", "settings"];

export function closeOtherOverlays(exceptId) {
  overlayIds
    .filter((id) => id !== exceptId)
    .forEach((id) => document.getElementById(id).classList.remove("active"));
}
