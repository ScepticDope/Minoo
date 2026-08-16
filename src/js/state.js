// # Shared mutable state.
// One object, so every module sees the same values without import cycles on data.

export const state = {
  // The parsed settings.toml, as loaded by the backend (settings, shortcuts).
  settings: null,

  // The relative path of the note open in the editor, or null when none is.
  currentNotePath: null,

  // The last sync status pulled from the backend (enabled, peers, lastSync, ...).
  syncStatus: null,
};
