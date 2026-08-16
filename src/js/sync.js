// # Sync between paired devices.
// Notes sync directly to paired devices on the local network (the Rust `sync` module
// holds the protocol). This side covers the Sync section in the settings, the pairing
// confirmations, and the "Last Sync" label in the sidebar.

import { appConfirm, showToast } from "./dialogs.js";
import { flushNoteSave, getEditorContent, openNextNote, setEditorContent } from "./editor.js";
import { renderSidebarNotes } from "./sidebar-notes.js";
import { state } from "./state.js";
import { invoke, listen } from "./tauri.js";

// ## Format a millisecond timestamp for the sidebar label.
function formatSyncTime(ms) {
  const date = new Date(ms);
  const pad = (number) => String(number).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// ## Reflect the last successful sync in the sidebar label.
function updateLastSyncLabel() {
  const lastSync = state.syncStatus ? state.syncStatus.lastSync : 0;
  document.getElementById("last-sync-date").textContent = lastSync
    ? `Last Sync ${formatSyncTime(lastSync)}`
    : "No Sync";
}

// ## Build a row for the paired and found device lists.
function buildDeviceRow(name, note, button) {
  const row = document.createElement("div");
  row.className = "sync-device-row";

  const label = document.createElement("span");
  label.textContent = name;
  row.appendChild(label);

  if (note) {
    const info = document.createElement("span");
    info.className = "device-note";
    info.textContent = note;
    row.appendChild(info);
  }
  if (button) row.appendChild(button);

  return row;
}

// ## Render the paired devices with their unpair buttons.
function renderPairedDevices() {
  const container = document.getElementById("sync-paired-devices");
  container.innerHTML = "";

  if (!state.syncStatus || state.syncStatus.peers.length === 0) {
    container.textContent = "No devices paired yet.";

    return;
  }

  state.syncStatus.peers.forEach((peer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Unpair";

    button.addEventListener("click", async () => {
      const message = `Unpair "${peer.name}"? The devices will stop syncing with each other.`;
      if (!(await appConfirm(message, "Unpair"))) return;

      try {
        await invoke("sync_unpair", { id: peer.id });
      } catch (error) {
        showToast(error);
      }
      refreshSyncStatus();
    });

    container.appendChild(buildDeviceRow(peer.name, "", button));
  });
}

// ## Pull the sync status from the backend into the settings and the sidebar.
async function refreshSyncStatus() {
  state.syncStatus = await invoke("sync_get_status");

  document.getElementById("toggle-sync").checked = state.syncStatus.enabled;
  document.getElementById("sync-device-name-input").value = state.syncStatus.deviceName;

  // Show this device's own address, to type into "pair by address" on the other one.
  document.getElementById("sync-device-address").textContent = state.syncStatus.address
    ? `This device's address is: ${state.syncStatus.address}`
    : "";

  renderPairedDevices();
  updateLastSyncLabel();
}

// ## Offer to switch sync on when discovery or pairing needs it.
async function ensureSyncEnabled(question) {
  if (state.syncStatus && state.syncStatus.enabled) return true;

  if (!(await appConfirm(question, "Enable Sync"))) return false;

  try {
    await invoke("sync_set_enabled", { enabled: true });
  } catch (error) {
    showToast(error);

    return false;
  }

  await refreshSyncStatus();

  return true;
}

// ## Search the network and list the devices found, with pair buttons.
async function findSyncDevices() {
  if (!(await ensureSyncEnabled("Finding devices needs sync to be on. Enable it?"))) {
    return;
  }

  const container = document.getElementById("sync-found-devices");
  container.textContent = "Searching...";

  let devices;
  try {
    devices = await invoke("sync_discover");
  } catch (error) {
    container.textContent = "";
    showToast(error);

    return;
  }

  container.innerHTML = "";
  if (devices.length === 0) {
    container.textContent =
      "No devices found. Make sure Minoo is open and sync is enabled on the other device.";

    return;
  }

  devices.forEach((device) => {
    let button = null;

    if (!device.paired) {
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "Pair";
      button.addEventListener("click", () => pairWithDevice(device.addr));
    }

    container.appendChild(
      buildDeviceRow(device.name, device.paired ? "Paired" : device.addr, button),
    );
  });
}

// ## Pair with a device.
// Both sides show the same code and both users confirm it, which gives the pair a
// private key nobody else on the network shares.
async function pairWithDevice(addr) {
  if (!addr) {
    showToast("Enter the other device's address first.");

    return;
  }
  if (!(await ensureSyncEnabled("Pairing needs sync to be on. Enable it?"))) return;

  try {
    const { name, code } = await invoke("sync_pair_begin", { addr });
    const message = `Pair with "${name}"? Accept only if it shows the code ${code} too.`;
    const confirm = await appConfirm(message, "Pair");

    await invoke("sync_pair_finish", { confirm });

    if (confirm) refreshSyncStatus();
  } catch (error) {
    showToast(error);
  }
}

// ## Sync with every paired device that answers on the network.
export async function syncNow() {
  // The other side reads the note files from disk, so pending edits go first.
  await flushNoteSave();

  try {
    showToast(await invoke("sync_now"));
  } catch (error) {
    showToast(error);
  }

  refreshSyncStatus();
}

// ## Quietly sync shortly after a note or sidebar change.
// That way paired devices follow along as you work. Peers being away is normal, so
// failures stay silent.
let autoSyncTimer = null;

export function scheduleAutoSync() {
  if (!state.syncStatus || !state.syncStatus.enabled || state.syncStatus.peers.length === 0) {
    return;
  }

  clearTimeout(autoSyncTimer);

  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null;

    await flushNoteSave();

    try {
      await invoke("sync_now");
    } catch (error) {
      // No paired device is around right now, the next change or retry will sync.
    }
  }, 3000);
}

// ## Reload the sidebar and the open note after a sync changed files on disk.
async function handleNotesChanged() {
  await renderSidebarNotes();

  if (!state.currentNotePath) return;

  // A pending edit is written out first. If that clashed with the sync, the next
  // sync round sorts it out (the last edit wins).
  await flushNoteSave();

  try {
    const content = await invoke("load_note", { path: state.currentNotePath });

    if (content !== getEditorContent()) setEditorContent(content);
  } catch (error) {
    // The open note was trashed or renamed on the other device.
    openNextNote();
  }
}

// ## Wire up the sync settings, events, and sidebar label.
export async function setupSync() {
  document.getElementById("toggle-sync").addEventListener("change", async function () {
    try {
      await invoke("sync_set_enabled", { enabled: this.checked });
    } catch (error) {
      showToast(error);
    }

    // Refresh the working copy, so scheduleAutoSync sees the new enabled state.
    refreshSyncStatus();
  });

  document
    .getElementById("sync-device-name-input")
    .addEventListener("blur", async function () {
      try {
        await invoke("sync_set_device_name", { name: this.value });
      } catch (error) {
        showToast(error);
      }

      refreshSyncStatus();
    });

  document.getElementById("sync-now").addEventListener("click", syncNow);
  document.getElementById("sync-find-devices").addEventListener("click", findSyncDevices);
  document.getElementById("sync-pair-by-address").addEventListener("click", () => {
    pairWithDevice(document.getElementById("sync-pair-address").value.trim());
  });

  // Another device asks to pair, show the code and let the user decide.
  listen("syncPairRequest", async (event) => {
    const { name, code } = event.payload;
    const message = `"${name}" wants to pair for syncing. Accept only if it shows the code ${code} too.`;
    const accept = await appConfirm(message, "Pair");

    try {
      await invoke("sync_pair_respond", { accept });
    } catch (error) {
      showToast(error);
    }
  });

  listen("syncPairComplete", (event) => {
    showToast(`Paired with "${event.payload.name}".`);
    refreshSyncStatus();
  });

  listen("syncStatus", (event) => {
    if (state.syncStatus) state.syncStatus.lastSync = event.payload.lastSync;
    updateLastSyncLabel();
  });

  listen("notesChanged", handleNotesChanged);

  await refreshSyncStatus();
}
