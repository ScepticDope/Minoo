// # The sync engine, manifests, the sync plan, and the two session sides.
// Everything here is independent of Tauri, so a full session can run in the tests over
// a real local socket.
//
// Each sync compares both sides' file listings against the listing saved when they last
// finished syncing (the index), so it can tell a new file from a deletion. Deletions
// arrive as moves into the other device's trash. When both devices changed the same
// note, everything syncs from the device with the newest last-edit and the other
// device's version moves into its trash with "[conflicted]" in the name, so nothing is
// ever lost silently.

use super::crypto::{hmac_sha256, random_hex, sha256, sha256_hex, to_hex};
use crate::notes::{
    is_valid_entry_name, parse_collapse_status, serialize_collapse_status, COLLAPSE_STATUS_FILE,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

const SYNC_MAX_MESSAGE: u64 = 256 * 1024 * 1024;

// ## Send one JSON message per line over TCP.
pub fn send_msg(stream: &mut TcpStream, message: &Value) -> Result<(), String> {
    let mut line = message.to_string();
    line.push('\n');

    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("Failed to send: {}.", e))
}

// ## Read one JSON message per line over TCP.
pub fn read_msg<R: BufRead>(reader: &mut R) -> Result<Value, String> {
    let mut line = String::new();

    let bytes = reader
        .by_ref()
        .take(SYNC_MAX_MESSAGE)
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read from the connection: {}.", e))?;

    if bytes == 0 {
        return Err("The connection was closed.".to_string());
    }

    serde_json::from_str(&line).map_err(|e| format!("Received an invalid message: {}.", e))
}

// ## Pairing derivations.
// Both sides feed the same two secrets in, so both get the same verification code to
// compare on screen and the same private key to store.
pub fn pairing_code(secret_a: &str, secret_b: &str) -> String {
    let digest = sha256(format!("minoo-pair-code:{}:{}", secret_a, secret_b).as_bytes());

    let number = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);

    format!("{:06}", number % 1_000_000)
}

pub fn pairing_key(secret_a: &str, secret_b: &str) -> String {
    sha256_hex(format!("minoo-pair-key:{}:{}", secret_a, secret_b).as_bytes())
}

pub fn session_proof(key: &str, role: &str, nonce_client: &str, nonce_server: &str) -> String {
    let message = format!("{}:{}:{}", role, nonce_client, nonce_server);

    to_hex(&hmac_sha256(key.as_bytes(), message.as_bytes()))
}

// ## Manifests and indexes.
// A manifest lists the notes on disk right now. The index is the manifest saved when
// two devices last finished syncing, kept per peer, which is what makes deletions
// distinguishable from new files.
#[derive(Clone)]
pub struct FileMeta {
    pub mtime: u64,
    pub hash: String,
}

pub fn file_mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn build_manifest(notes_dir: &Path) -> Result<BTreeMap<String, FileMeta>, String> {
    let mut manifest = BTreeMap::new();

    if notes_dir.exists() {
        build_manifest_dir(notes_dir, "", &mut manifest)?;
    }

    Ok(manifest)
}

fn build_manifest_dir(
    dir: &Path,
    relative_dir: &str,
    manifest: &mut BTreeMap<String, FileMeta>,
) -> Result<(), String> {
    let dir_entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read notes directory: {}.", e))?;

    for entry in dir_entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Dot-entries stay local, which also keeps the trash out of the sync. The one
        // exception is the collapse status file, which carries each folder's collapse
        // status and its very existence (even when empty) across devices.
        if file_name.starts_with('.') && file_name != COLLAPSE_STATUS_FILE {
            continue;
        }

        let relative_path = if relative_dir.is_empty() {
            file_name.clone()
        } else {
            format!("{}/{}", relative_dir, file_name)
        };

        let path = entry.path();

        if path.is_dir() {
            build_manifest_dir(&path, &relative_path, manifest)?;
            continue;
        }
        if !file_name.to_lowercase().ends_with(".md") && file_name != COLLAPSE_STATUS_FILE {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };

        manifest.insert(
            relative_path,
            FileMeta {
                mtime: file_mtime_ms(&path),
                hash: sha256_hex(content.as_bytes()),
            },
        );
    }

    Ok(())
}

fn manifest_to_json(manifest: &BTreeMap<String, FileMeta>) -> Value {
    Value::Array(
        manifest
            .iter()
            .map(|(path, meta)| json!({"path": path, "mtime": meta.mtime, "hash": meta.hash}))
            .collect(),
    )
}

fn parse_manifest(value: &Value) -> BTreeMap<String, FileMeta> {
    let mut manifest = BTreeMap::new();

    for entry in value.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let Some(path) = entry["path"].as_str() else {
            continue;
        };
        let Some(hash) = entry["hash"].as_str() else {
            continue;
        };
        if !is_valid_sync_path(path) {
            continue;
        }

        manifest.insert(
            path.to_string(),
            FileMeta {
                mtime: entry["mtime"].as_u64().unwrap_or(0),
                hash: hash.to_string(),
            },
        );
    }

    manifest
}

pub fn load_sync_index(index_path: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(index_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_sync_index(index_path: &Path, index: &BTreeMap<String, String>) -> Result<(), String> {
    let content = serde_json::to_string(index)
        .map_err(|e| format!("Failed to serialize sync index: {}.", e))?;

    fs::write(index_path, content).map_err(|e| format!("Failed to write sync index: {}.", e))
}

// ## File helpers for applying a sync.
// Every relative path that came over the network goes through is_valid_sync_path, so
// nothing can escape the notes folder. Only notes and collapse status files ever sync.
fn is_valid_sync_path(path: &str) -> bool {
    let (parents, name) = match path.rsplit_once('/') {
        Some(split) => split,
        None => ("", path),
    };

    let name_valid = name == COLLAPSE_STATUS_FILE
        || (name.to_lowercase().ends_with(".md") && is_valid_entry_name(name));

    name_valid && (parents.is_empty() || parents.split('/').all(is_valid_entry_name))
}

pub fn write_synced_file(
    notes_dir: &Path,
    relative_path: &str,
    content: &str,
    mtime: u64,
) -> Result<(), String> {
    let path = notes_dir.join(relative_path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create folder: {}.", e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write note: {}.", e))?;

    // Keep the sender's modification time, so "newest wins" stays meaningful across
    // devices. A device with a broken clock still syncs.
    if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(mtime));
    }

    Ok(())
}

// ## Move a note into this device's trash.
// A synced deletion lands here instead of destroying the note. A lost conflict does
// the same with " [conflicted]" added to the name.
fn move_note_to_trash(notes_dir: &Path, relative_path: &str, suffix: &str) -> Result<(), String> {
    let source = notes_dir.join(relative_path);

    if !source.exists() {
        return Ok(());
    }

    let file_name = relative_path.rsplit('/').next().unwrap_or(relative_path);

    // A collapse status file never lands in the trash. A synced deletion (empty
    // suffix) means the other device deleted its folder, so the status file goes and
    // the folder prunes away below. A lost conflict leaves it alone, the per-device
    // merge in apply_sync_files reconciles the two versions instead.
    if file_name == COLLAPSE_STATUS_FILE {
        if suffix.is_empty() {
            fs::remove_file(&source)
                .map_err(|e| format!("Failed to remove the folder state: {}.", e))?;

            prune_empty_folders(notes_dir, relative_path);
        }

        return Ok(());
    }

    let trash_dir = notes_dir.join(".trash");

    fs::create_dir_all(&trash_dir)
        .map_err(|e| format!("Failed to create trash directory: {}.", e))?;

    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, extension)) => (format!("{}{}", stem, suffix), format!(".{}", extension)),
        None => (format!("{}{}", file_name, suffix), String::new()),
    };

    let mut target = trash_dir.join(format!("{}{}", stem, extension));
    let mut counter = 2;

    while target.exists() {
        target = trash_dir.join(format!("{} {}{}", stem, counter, extension));
        counter += 1;
    }

    fs::rename(&source, &target).map_err(|e| format!("Failed to move to trash: {}.", e))?;
    prune_empty_folders(notes_dir, relative_path);

    Ok(())
}

// ## Remove the folders a synced deletion left empty.
// The manifests only carry note files, so when a whole folder is deleted on the other
// device only its notes arrive as deletions here and its folders would linger empty.
// Walks from the trashed note's folder up towards the notes root, and stops at the
// first folder that still holds anything.
fn prune_empty_folders(notes_dir: &Path, relative_path: &str) {
    let Some((mut folder, _)) = relative_path.rsplit_once('/') else {
        return;
    };

    loop {
        let dir = notes_dir.join(folder);

        let is_empty = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);

        if !is_empty || fs::remove_dir(&dir).is_err() {
            return;
        }

        match folder.rsplit_once('/') {
            Some((parent, _)) => folder = parent,
            None => return,
        }
    }
}

fn read_sync_files(notes_dir: &Path, paths: &[String]) -> Vec<Value> {
    let mut files = Vec::new();

    for path in paths {
        if !is_valid_sync_path(path) {
            continue;
        }

        let full_path = notes_dir.join(path);

        let Ok(content) = fs::read_to_string(&full_path) else {
            continue;
        };

        files.push(json!({"path": path, "mtime": file_mtime_ms(&full_path), "content": content}));
    }

    files
}

// ## Merge an incoming collapse status file with the local one.
// The remote lines win for every device except this one, whose own line always stays
// local, so another device can never fold a folder open on this device's sidebar. Both
// sides serialize sorted, so the files still converge to identical bytes.
fn merge_collapse_status(
    notes_dir: &Path,
    relative_path: &str,
    remote: &str,
    device: &str,
) -> String {
    let mut states = parse_collapse_status(remote);

    let local = fs::read_to_string(notes_dir.join(relative_path)).unwrap_or_default();

    if let Some(own) = parse_collapse_status(&local).get(device) {
        states.insert(device.to_string(), *own);
    }

    serialize_collapse_status(&states)
}

fn apply_sync_files(notes_dir: &Path, files: &Value, device: &str) -> usize {
    let mut applied = 0;

    for file in files.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let Some(path) = file["path"].as_str() else {
            continue;
        };

        if !is_valid_sync_path(path) {
            continue;
        }

        let mut content = file["content"].as_str().unwrap_or("").to_string();

        if path.rsplit('/').next() == Some(COLLAPSE_STATUS_FILE) {
            content = merge_collapse_status(notes_dir, path, &content, device);
        }

        let mtime = file["mtime"].as_u64().unwrap_or(0);

        if write_synced_file(notes_dir, path, &content, mtime).is_ok() {
            applied += 1;
        }
    }

    applied
}

// ## The sync plan, what has to move where to make both sides identical.
// Computed on the server side of a session from both manifests plus the shared index.
#[derive(Default)]
struct SyncPlan {
    to_client: Vec<String>,
    to_server: Vec<String>,
    delete_on_client: Vec<String>,
    delete_on_server: Vec<String>,

    // Lost conflicts, that side trashes its own version as "[conflicted]" before the
    // winning version arrives.
    conflict_on_client: Vec<String>,
    conflict_on_server: Vec<String>,
}

fn compute_sync_plan(
    server: &BTreeMap<String, FileMeta>,
    client: &BTreeMap<String, FileMeta>,
    index: &BTreeMap<String, String>,
    server_edited: u64,
    client_edited: u64,
) -> SyncPlan {
    let mut plan = SyncPlan::default();

    let paths: HashSet<&String> = server.keys().chain(client.keys()).collect();

    for path in paths {
        let path = path.clone();

        match (server.get(&path), client.get(&path)) {
            (Some(on_server), Some(on_client)) => {
                if on_server.hash == on_client.hash {
                    continue;
                }

                let indexed = index.get(&path);

                if indexed == Some(&on_server.hash) {
                    // Only the client changed it since the last sync.
                    plan.to_server.push(path);
                } else if indexed == Some(&on_client.hash) {
                    // Only the server changed it since the last sync.
                    plan.to_client.push(path);
                } else {
                    // Both changed it. The device that edited last wins, and the other
                    // device's version goes into its own trash as "[conflicted]".
                    if server_edited >= client_edited {
                        plan.conflict_on_client.push(path.clone());
                        plan.to_client.push(path);
                    } else {
                        plan.conflict_on_server.push(path.clone());
                        plan.to_server.push(path);
                    }
                }
            }
            (Some(on_server), None) => match index.get(&path) {
                // In the index and unchanged here means the client deleted it.
                Some(hash) if *hash == on_server.hash => plan.delete_on_server.push(path),
                // New here, or edited here after the client deleted it, send it over.
                _ => plan.to_client.push(path),
            },
            (None, Some(on_client)) => match index.get(&path) {
                Some(hash) if *hash == on_client.hash => plan.delete_on_client.push(path),
                _ => plan.to_server.push(path),
            },
            (None, None) => unreachable!(),
        }
    }

    plan
}

// ## Everything one session needs.
// Independent of Tauri, so the sessions are testable.
pub struct SessionCtx {
    pub notes_dir: PathBuf,
    pub index_path: PathBuf,
    pub local_id: String,

    // This device's name, its key in the per-device collapse status files.
    pub local_name: String,

    // This device's last-edit time, which decides who wins conflicts.
    pub local_edited: u64,

    // This device's TCP port, so the other side can find it again later.
    pub local_port: u16,
    pub peer_id: String,
    pub key: String,
}

// ## Save this side's fresh listing as the index once a session finishes.
// That way a file that failed to land anywhere heals itself on the next sync.
fn save_final_index(ctx: &SessionCtx) -> Result<(), String> {
    let final_manifest = build_manifest(&ctx.notes_dir)?;

    let final_index: BTreeMap<String, String> = final_manifest
        .iter()
        .map(|(path, meta)| (path.clone(), meta.hash.clone()))
        .collect();

    save_sync_index(&ctx.index_path, &final_index)
}

// ## The server side of a sync session.
// Authenticate, plan, exchange, and save the index. Returns whether any local files
// changed.
pub fn run_server_session(
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    hello: &Value,
    ctx: &SessionCtx,
) -> Result<bool, String> {
    let nonce_client = hello["nonce"].as_str().unwrap_or("").to_string();
    let nonce_server = random_hex(16);

    send_msg(
        stream,
        &json!({
            "t": "hello-ack",
            "id": ctx.local_id,
            "nonce": nonce_server,
            "proof": session_proof(&ctx.key, "server", &nonce_client, &nonce_server),
        }),
    )?;

    let auth = read_msg(reader)?;

    if auth["t"] != "auth"
        || auth["proof"] != session_proof(&ctx.key, "client", &nonce_client, &nonce_server)
    {
        let _ = send_msg(
            stream,
            &json!({"t": "error", "message": "Authentication failed."}),
        );
        return Err("The other device failed to authenticate.".to_string());
    }

    let client_manifest = parse_manifest(&auth["manifest"]);
    let local_manifest = build_manifest(&ctx.notes_dir)?;

    let index = load_sync_index(&ctx.index_path);
    let client_edited = hello["edited"].as_u64().unwrap_or(0);

    let plan = compute_sync_plan(
        &local_manifest,
        &client_manifest,
        &index,
        ctx.local_edited,
        client_edited,
    );

    send_msg(
        stream,
        &json!({
            "t": "plan",
            "request": plan.to_server,
            "files": read_sync_files(&ctx.notes_dir, &plan.to_client),
            "delete": plan.delete_on_client,
            "conflict": plan.conflict_on_client,
        }),
    )?;

    let files_msg = read_msg(reader)?;
    if files_msg["t"] != "files" {
        return Err("Expected the other device's files.".to_string());
    }

    // Trash this side's lost conflicts before the winning versions land.
    for path in &plan.conflict_on_server {
        let _ = move_note_to_trash(&ctx.notes_dir, path, " [conflicted]");
    }

    let written = apply_sync_files(&ctx.notes_dir, &files_msg["files"], &ctx.local_name);

    for path in &plan.delete_on_server {
        let _ = move_note_to_trash(&ctx.notes_dir, path, "");
    }

    save_final_index(ctx)?;
    send_msg(stream, &json!({"t": "done"}))?;

    Ok(written + plan.delete_on_server.len() + plan.conflict_on_server.len() > 0)
}

// ## The client side of a sync session.
// Returns whether any local files changed.
pub fn run_client_session(
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    ctx: &SessionCtx,
) -> Result<bool, String> {
    let nonce_client = random_hex(16);

    send_msg(
        stream,
        &json!({
            "t": "hello",
            "id": ctx.local_id,
            "nonce": nonce_client,
            "edited": ctx.local_edited,
            "port": ctx.local_port,
        }),
    )?;

    let ack = read_msg(reader)?;
    if ack["t"] == "error" {
        return Err(ack["message"]
            .as_str()
            .unwrap_or("The sync was rejected.")
            .to_string());
    }

    let nonce_server = ack["nonce"].as_str().unwrap_or("").to_string();

    if ack["t"] != "hello-ack"
        || ack["id"] != ctx.peer_id
        || ack["proof"] != session_proof(&ctx.key, "server", &nonce_client, &nonce_server)
    {
        return Err("The other device failed to authenticate.".to_string());
    }

    let manifest = build_manifest(&ctx.notes_dir)?;

    send_msg(
        stream,
        &json!({
            "t": "auth",
            "proof": session_proof(&ctx.key, "client", &nonce_client, &nonce_server),
            "manifest": manifest_to_json(&manifest),
        }),
    )?;

    let plan = read_msg(reader)?;

    if plan["t"] == "error" {
        return Err(plan["message"]
            .as_str()
            .unwrap_or("The sync was rejected.")
            .to_string());
    }
    if plan["t"] != "plan" {
        return Err("Expected the sync plan.".to_string());
    }

    // Send what the other side asked for first, then apply its side of the plan.
    let requested: Vec<String> = string_list(&plan["request"]);

    send_msg(
        stream,
        &json!({"t": "files", "files": read_sync_files(&ctx.notes_dir, &requested)}),
    )?;

    // Trash this side's lost conflicts before the winning versions land.
    let conflicts = string_list(&plan["conflict"]);

    for path in &conflicts {
        if is_valid_sync_path(path) {
            let _ = move_note_to_trash(&ctx.notes_dir, path, " [conflicted]");
        }
    }

    let written = apply_sync_files(&ctx.notes_dir, &plan["files"], &ctx.local_name);

    let deletes = string_list(&plan["delete"]);

    for path in &deletes {
        if is_valid_sync_path(path) {
            let _ = move_note_to_trash(&ctx.notes_dir, path, "");
        }
    }

    let done = read_msg(reader)?;
    if done["t"] != "done" {
        return Err("The sync did not finish cleanly.".to_string());
    }

    save_final_index(ctx)?;

    Ok(written + deletes.len() + conflicts.len() > 0)
}

// ## Read a JSON array of strings, dropping anything that isn't a string.
fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// # Tests for the sync engine.
// The session test exercises a full sync over a real local socket.
#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};

    #[test]
    fn pairing_code_is_six_digits_and_symmetric() {
        let code = pairing_code("secret-a", "secret-b");
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(code, pairing_code("secret-a", "secret-b"));
        assert_ne!(code, pairing_code("secret-b", "secret-a"));
    }

    fn meta(mtime: u64, hash: &str) -> FileMeta {
        FileMeta {
            mtime,
            hash: hash.to_string(),
        }
    }

    #[test]
    fn sync_plan_detects_changes_and_deletions() {
        let server = BTreeMap::from([
            ("kept.md".to_string(), meta(1, "h1")),
            ("server-new.md".to_string(), meta(2, "h2")),
            ("server-edited.md".to_string(), meta(3, "h3-new")),
            ("client-deleted.md".to_string(), meta(1, "h4")),
        ]);
        let client = BTreeMap::from([
            ("kept.md".to_string(), meta(1, "h1")),
            ("client-new.md".to_string(), meta(2, "h5")),
            ("server-edited.md".to_string(), meta(1, "h3")),
        ]);
        let index = BTreeMap::from([
            ("kept.md".to_string(), "h1".to_string()),
            ("server-edited.md".to_string(), "h3".to_string()),
            ("client-deleted.md".to_string(), "h4".to_string()),
        ]);

        let plan = compute_sync_plan(&server, &client, &index, 0, 0);

        assert_eq!(plan.to_client.len(), 2);
        assert!(plan.to_client.contains(&"server-new.md".to_string()));
        assert!(plan.to_client.contains(&"server-edited.md".to_string()));
        assert_eq!(plan.to_server, vec!["client-new.md".to_string()]);
        assert_eq!(plan.delete_on_server, vec!["client-deleted.md".to_string()]);
        assert!(plan.delete_on_client.is_empty());
        assert!(plan.conflict_on_client.is_empty() && plan.conflict_on_server.is_empty());
    }

    #[test]
    fn sync_plan_conflicts_follow_the_last_edited_device() {
        let server = BTreeMap::from([("note.md".to_string(), meta(2000, "h-server"))]);
        let client = BTreeMap::from([("note.md".to_string(), meta(1000, "h-client"))]);
        let index = BTreeMap::from([("note.md".to_string(), "h-old".to_string())]);

        // The server edited last, so the client trashes its version and takes over.
        let plan = compute_sync_plan(&server, &client, &index, 2000, 1000);
        assert_eq!(plan.conflict_on_client, vec!["note.md".to_string()]);
        assert_eq!(plan.to_client, vec!["note.md".to_string()]);
        assert!(plan.to_server.is_empty() && plan.conflict_on_server.is_empty());

        // And the mirror image when the client edited last.
        let plan = compute_sync_plan(&server, &client, &index, 1000, 2000);
        assert_eq!(plan.conflict_on_server, vec!["note.md".to_string()]);
        assert_eq!(plan.to_server, vec!["note.md".to_string()]);
        assert!(plan.to_client.is_empty() && plan.conflict_on_client.is_empty());
    }

    #[test]
    fn trashing_the_last_note_prunes_its_empty_folders() {
        let base = std::env::temp_dir().join(format!("minoo-prune-test-{}", random_hex(8)));
        let notes = base.join("notes");

        // A nested note whose folders hold nothing else, and one whose folder also
        // holds an untouched sibling.
        write_synced_file(&notes, "Folder/Sub/Note.md", "x", 1000).unwrap();
        write_synced_file(&notes, "Kept/Gone.md", "x", 1000).unwrap();
        write_synced_file(&notes, "Kept/Stays.md", "x", 1000).unwrap();

        move_note_to_trash(&notes, "Folder/Sub/Note.md", "").unwrap();
        assert!(!notes.join("Folder").exists());
        assert!(notes.join(".trash/Note.md").exists());

        move_note_to_trash(&notes, "Kept/Gone.md", "").unwrap();
        assert!(notes.join("Kept/Stays.md").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn collapse_status_syncs_but_never_lands_in_the_trash() {
        let base = std::env::temp_dir().join(format!("minoo-status-test-{}", random_hex(8)));
        let notes = base.join("notes");

        // The status file of an empty folder is a valid sync path and part of the
        // manifest, while other dot-files stay out of both.
        write_synced_file(&notes, "Empty/.collapseStatus", "closed Here\n", 1000).unwrap();
        assert!(is_valid_sync_path("Empty/.collapseStatus"));
        assert!(!is_valid_sync_path("Empty/.secret"));
        assert!(!is_valid_sync_path("../escape/.collapseStatus"));
        assert!(build_manifest(&notes)
            .unwrap()
            .contains_key("Empty/.collapseStatus"));

        // A synced deletion removes the status file and prunes the folder, and
        // puts nothing in the trash.
        move_note_to_trash(&notes, "Empty/.collapseStatus", "").unwrap();
        assert!(!notes.join("Empty").exists());
        assert!(!notes.join(".trash").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn collapse_status_merges_per_device() {
        let base = std::env::temp_dir().join(format!("minoo-merge-test-{}", random_hex(8)));
        let notes = base.join("notes");

        // This device (MacBook) opened the folder, while the incoming file carries an
        // older closed state for it plus another device's own line.
        write_synced_file(&notes, "Folder/.collapseStatus", "open MacBook\n", 1000).unwrap();

        let merged = merge_collapse_status(
            &notes,
            "Folder/.collapseStatus",
            "closed MacBook\nopen iPhone\n",
            "MacBook",
        );

        // The own line stays local, the other device's line comes in, sorted.
        assert_eq!(merged, "open MacBook\nopen iPhone\n");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn sync_session_converges_two_devices() {
        let base = std::env::temp_dir().join(format!("minoo-sync-test-{}", random_hex(8)));
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        // An identical note, one unique to each side, and a conflict where B is newer.
        write_synced_file(&dir_a, "Shared.md", "same", 1000).unwrap();
        write_synced_file(&dir_b, "Shared.md", "same", 1000).unwrap();
        write_synced_file(&dir_a, "Only A.md", "from a", 2000).unwrap();
        write_synced_file(&dir_b, "Folder/Only B.md", "from b", 3000).unwrap();
        write_synced_file(&dir_a, "Conflict.md", "a version", 4000).unwrap();
        write_synced_file(&dir_b, "Conflict.md", "b version", 5000).unwrap();

        // Device B edited last, so it wins the conflict.
        let key = pairing_key("secret-a", "secret-b");
        let ctx_a = SessionCtx {
            notes_dir: dir_a.clone(),
            index_path: base.join("index-a.json"),
            local_id: "a".repeat(64),
            local_name: "Device A".to_string(),
            local_edited: 1000,
            local_port: 0,
            peer_id: "b".repeat(64),
            key: key.clone(),
        };
        let ctx_b = SessionCtx {
            notes_dir: dir_b.clone(),
            index_path: base.join("index-b.json"),
            local_id: "b".repeat(64),
            local_name: "Device B".to_string(),
            local_edited: 2000,
            local_port: 0,
            peer_id: "a".repeat(64),
            key,
        };

        // Run two full sessions. The first merges, the second must be a no-op.
        for round in 0..2 {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();

            let (client_changed, server_changed) = thread::scope(|scope| {
                let server = scope.spawn(|| {
                    let (stream, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut stream = stream;
                    let hello = read_msg(&mut reader).unwrap();

                    run_server_session(&mut stream, &mut reader, &hello, &ctx_b).unwrap()
                });

                let mut stream = TcpStream::connect(addr).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let client_changed = run_client_session(&mut stream, &mut reader, &ctx_a).unwrap();

                (client_changed, server.join().unwrap())
            });

            if round == 1 {
                assert!(!client_changed && !server_changed);
            }
        }

        let hashes = |dir: &Path| -> BTreeMap<String, String> {
            build_manifest(dir)
                .unwrap()
                .iter()
                .map(|(path, meta)| (path.clone(), meta.hash.clone()))
                .collect()
        };

        let manifest_a = hashes(&dir_a);
        assert_eq!(manifest_a, hashes(&dir_b));

        // Shared, Only A, Folder/Only B, and the conflict winner.
        assert_eq!(manifest_a.len(), 4);

        assert_eq!(
            fs::read_to_string(dir_a.join("Conflict.md")).unwrap(),
            "b version"
        );

        assert_eq!(
            fs::read_to_string(dir_b.join("Conflict.md")).unwrap(),
            "b version"
        );

        // The losing device kept its version in its own trash, marked [conflicted].
        assert_eq!(
            fs::read_to_string(dir_a.join(".trash/Conflict [conflicted].md")).unwrap(),
            "a version"
        );

        assert!(
            !dir_b.join(".trash").exists()
                || fs::read_dir(dir_b.join(".trash")).unwrap().next().is_none()
        );

        // Both indexes were saved and agree with the merged state.
        assert_eq!(load_sync_index(&base.join("index-a.json")), manifest_a);
        assert_eq!(load_sync_index(&base.join("index-b.json")), manifest_a);

        let _ = fs::remove_dir_all(&base);
    }
}
