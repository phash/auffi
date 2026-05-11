use std::{
    collections::BTreeMap,
    collections::HashMap,
    io::{BufWriter, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

/// A message received on the `files` DataChannel.
///
/// The channel carries two kinds of data:
/// - JSON text: a `FileEvent` (offer, accept, reject, done, error).
/// - Binary: a raw chunk frame with an 8-byte header.
pub enum FileMessage {
    Event(FileEvent),
    Chunk(Vec<u8>),
}

/// Events exchanged on the `files` DataChannel (JSON side).
///
/// The `kind` field acts as the discriminant tag; variants mirror the viewer's
/// `FileEvent` type in `viewer/src/protocol.ts`.
///
/// The `File` prefix is intentional: it matches the protocol naming convention
/// used in the viewer and is kept for cross-language clarity.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FileEvent {
    FileOffer {
        id: String,
        name: String,
        size: u64,
        mime: String,
    },
    FileAccept {
        id: String,
    },
    FileReject {
        id: String,
    },
    FileDone {
        id: String,
    },
    FileError {
        id: String,
        message: String,
    },
}

/// State tracked for a single incoming file transfer.
struct ReceiveState {
    /// The UUID supplied by the sender — stored for future reference.
    #[allow(dead_code)]
    id: String,
    name: String,
    /// Total expected file size in bytes — stored for progress display.
    #[allow(dead_code)]
    total_size: u64,
    received_bytes: u64,
    file: BufWriter<std::fs::File>,
    /// Out-of-order chunks buffered until the preceding seq arrives.
    pending_chunks: BTreeMap<u32, Vec<u8>>,
    /// Next expected contiguous sequence number to write to disk.
    next_seq: u32,
}

/// Manages incoming and outgoing file transfers on behalf of the sharer.
pub struct FileTransferManager {
    active: HashMap<u32, ReceiveState>,
}

impl FileTransferManager {
    pub fn new() -> Self {
        Self {
            active: HashMap::new(),
        }
    }

    /// Process an incoming JSON `FileEvent` and return any response events to
    /// transmit back to the viewer.
    ///
    /// `file-offer` events are only queued here; the actual
    /// `file-accept`/`file-reject` comes from the webview via Tauri commands.
    pub fn handle_offer<R: Runtime>(
        &mut self,
        event: FileEvent,
        app: &AppHandle<R>,
    ) -> Vec<FileEvent> {
        match event {
            FileEvent::FileOffer {
                id,
                name,
                size,
                mime,
            } => {
                let id_hash = fnv1a32(&id);
                let sanitized = sanitize_filename(&name);
                match Self::open_output_file(&sanitized) {
                    Ok(file) => {
                        let state = ReceiveState {
                            id: id.clone(),
                            name: sanitized.clone(),
                            total_size: size,
                            received_bytes: 0,
                            file: BufWriter::new(file),
                            pending_chunks: BTreeMap::new(),
                            next_seq: 0,
                        };
                        self.active.insert(id_hash, state);

                        let payload = serde_json::json!({
                            "id": id,
                            "name": sanitized,
                            "size": size,
                            "mime": mime,
                        });
                        if let Err(e) = app.emit("file-offer", payload) {
                            log::warn!("file-offer emit failed: {e}");
                        }
                    }
                    Err(e) => {
                        log::warn!("cannot open output file for '{sanitized}': {e}");
                        return vec![FileEvent::FileError {
                            id,
                            message: format!("cannot open file: {e}"),
                        }];
                    }
                }
                vec![]
            }
            FileEvent::FileDone { id } => {
                let id_hash = fnv1a32(&id);
                if let Some(mut state) = self.active.remove(&id_hash) {
                    if let Err(e) = state.file.flush() {
                        log::warn!("flush failed for '{}': {e}", state.name);
                    }
                    let path = output_dir().join(&state.name);
                    let payload = serde_json::json!({ "path": path.to_string_lossy() });
                    if let Err(e) = app.emit("file-received", payload) {
                        log::warn!("file-received emit failed: {e}");
                    }
                }
                vec![]
            }
            FileEvent::FileError { id, message } => {
                let id_hash = fnv1a32(&id);
                self.active.remove(&id_hash);
                log::warn!("file transfer error for id={id}: {message}");
                vec![]
            }
            // These are responses from the viewer — not processed by the receive path.
            FileEvent::FileAccept { .. } | FileEvent::FileReject { .. } => vec![],
        }
    }

    /// Generate a `file-accept` response for the given file id (called after
    /// user confirmation in the webview).
    pub fn accept(&mut self, id: &str) -> FileEvent {
        FileEvent::FileAccept { id: id.to_string() }
    }

    /// Generate a `file-reject` response and remove any pending state.
    pub fn reject(&mut self, id: &str) -> FileEvent {
        let id_hash = fnv1a32(id);
        self.active.remove(&id_hash);
        FileEvent::FileReject { id: id.to_string() }
    }

    /// Parse an 8-byte chunk frame header and write the payload to disk.
    ///
    /// Frame layout (all little-endian):
    ///   bytes 0–3: FNV-1a-32 of the file UUID
    ///   bytes 4–7: sequence number (u32)
    ///   bytes 8…:  payload
    pub fn handle_chunk(&mut self, buf: &[u8]) -> Result<(), String> {
        if buf.len() < 8 {
            return Err(format!("chunk too short: {} bytes (need ≥ 8)", buf.len()));
        }

        let id_hash = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let seq = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let payload = &buf[8..];

        let state = self
            .active
            .get_mut(&id_hash)
            .ok_or_else(|| format!("no active transfer for id_hash=0x{id_hash:08x}"))?;

        // Buffer out-of-order chunk.
        if seq != state.next_seq {
            state.pending_chunks.insert(seq, payload.to_vec());
            return Ok(());
        }

        // Write the in-order chunk.
        state
            .file
            .write_all(payload)
            .map_err(|e| format!("write failed: {e}"))?;
        state.received_bytes += payload.len() as u64;
        state.next_seq += 1;

        // Drain any buffered chunks that are now contiguous.
        while let Some(data) = state.pending_chunks.remove(&state.next_seq) {
            state
                .file
                .write_all(&data)
                .map_err(|e| format!("write (buffered) failed: {e}"))?;
            state.received_bytes += data.len() as u64;
            state.next_seq += 1;
        }

        Ok(())
    }

    fn open_output_file(filename: &str) -> std::io::Result<std::fs::File> {
        let dir = output_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(filename);
        std::fs::File::create(path)
    }
}

/// Returns the directory where received files are saved (`~/Downloads/Screenie/`).
/// The directory is created lazily (by `open_output_file`) so this function
/// itself does not perform I/O.
pub fn output_dir() -> PathBuf {
    let base = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Screenie")
}

/// FNV-1a 32-bit hash — identical algorithm to `fnv1a32` in
/// `viewer/src/file-transfer.ts`.
pub fn fnv1a32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in s.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Sanitize a user-supplied filename so it is safe to create on the local
/// filesystem:
///
/// - Strips path-traversal components (`..` and `.`).
/// - Joins the remaining path components with `_` so that
///   `../etc/passwd` → `etc_passwd` and `/absolute/path` → `absolute_path`.
/// - Replaces control characters (U+0000–U+001F, U+007F) with `_`.
/// - Strips a leading dot (hidden-file convention on Unix).
/// - Falls back to `"untitled"` if the result would be empty.
/// - Truncates to 255 bytes (the POSIX filename limit).
pub fn sanitize_filename(input: &str) -> String {
    // Split on both Unix and Windows path separators, collect non-traversal
    // components (drop empty strings, `.`, and `..`).
    let parts: Vec<&str> = input
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".." && *s != ".")
        .collect();

    // Join surviving components with `_`.
    let joined = parts.join("_");

    // Replace control characters (0x00–0x1F, 0x7F).
    let cleaned: String = joined
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || c == '\x7f' {
                '_'
            } else {
                c
            }
        })
        .collect();

    // Strip leading dot (hidden-file convention on Unix).
    let stripped = cleaned.trim_start_matches('.');

    let result = if stripped.is_empty() {
        "untitled".to_string()
    } else {
        stripped.to_string()
    };

    // Enforce POSIX filename length limit.
    if result.len() <= 255 {
        result
    } else {
        // Truncate at a UTF-8 character boundary.
        let mut end = 255;
        while !result.is_char_boundary(end) {
            end -= 1;
        }
        result[..end].to_string()
    }
}

/// Build an 8-byte chunk frame header followed by the given payload.
///
/// Layout (little-endian):
///   bytes 0–3: FNV-1a-32 of `id`
///   bytes 4–7: `seq`
///   bytes 8…:  `payload`
pub fn build_chunk_frame(id: &str, seq: u32, payload: &[u8]) -> Vec<u8> {
    let id_hash = fnv1a32(id);
    let mut frame = Vec::with_capacity(8 + payload.len());
    frame.extend_from_slice(&id_hash.to_le_bytes());
    frame.extend_from_slice(&seq.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

const CHUNK_SIZE: usize = 16 * 1024;

/// Read a file from `path` and send it to the viewer as a series of binary
/// chunk frames.  The `peer` is used to transmit both JSON events and raw
/// chunk frames over the `"files"` DataChannel.
pub async fn send_file(path: PathBuf, peer: &crate::webrtc_peer::SharerPeer) -> Result<(), String> {
    use std::io::Read;

    let name = path
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?
        .to_string_lossy()
        .to_string();

    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = metadata.len();

    let id = uuid_v4();
    let mime = mime_guess(&name);

    peer.send_file_event(&FileEvent::FileOffer {
        id: id.clone(),
        name,
        size,
        mime,
    })
    .await?;

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut seq: u32 = 0;

    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let frame = build_chunk_frame(&id, seq, &buf[..n]);
        peer.send_file_chunk(frame).await?;
        seq += 1;
    }

    peer.send_file_event(&FileEvent::FileDone { id }).await?;

    Ok(())
}

/// Generate a simple UUID v4 string without external crate dependencies.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // Use process ID + time nanos as low-quality random seed for UUID generation.
    let pid = std::process::id();
    let a = nanos ^ (pid << 16);
    let b = nanos.wrapping_mul(0x9e3779b9) ^ pid;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        a,
        (b & 0xffff),
        (a >> 4) & 0xfff,
        0x8000 | ((b >> 8) & 0x3fff),
        (u64::from(a) << 16) | u64::from(b & 0xffff),
    )
}

/// Guess a MIME type from a file extension (covers common cases).
fn mime_guess(name: &str) -> String {
    let ext = name
        .rfind('.')
        .map(|i| &name[i + 1..])
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "txt" => "text/plain",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── sanitize_filename tests ──────────────────────────────────────────────

    #[test]
    fn sanitize_strips_path_traversal() {
        assert_eq!(sanitize_filename("../etc/passwd"), "etc_passwd");
    }

    #[test]
    fn sanitize_strips_absolute_path() {
        assert_eq!(sanitize_filename("/absolute/path"), "absolute_path");
    }

    #[test]
    fn sanitize_keeps_normal() {
        assert_eq!(sanitize_filename("normal.txt"), "normal.txt");
    }

    #[test]
    fn sanitize_strips_backslash_traversal() {
        // `..` components are dropped; remaining components joined with `_`.
        let result = sanitize_filename("..\\..\\windows\\bad");
        assert_eq!(result, "windows_bad");
    }

    #[test]
    fn sanitize_replaces_control_chars() {
        let input = "file\x01name.txt";
        let result = sanitize_filename(input);
        assert_eq!(result, "file_name.txt");
    }

    #[test]
    fn sanitize_truncates_to_255() {
        let long: String = "a".repeat(300);
        let result = sanitize_filename(&long);
        assert_eq!(result.len(), 255);
    }

    #[test]
    fn sanitize_rejects_empty_or_dots() {
        assert_eq!(sanitize_filename("."), "untitled");
        assert_eq!(sanitize_filename(".."), "untitled");
        assert_eq!(sanitize_filename(""), "untitled");
    }

    #[test]
    fn sanitize_strips_leading_dot() {
        assert_eq!(sanitize_filename(".hidden"), "hidden");
    }

    // ─── fnv1a32 tests ────────────────────────────────────────────────────────

    /// Known values verified against the viewer's `fnv1a32` implementation in
    /// `viewer/src/file-transfer.ts` (computed via Node.js).
    #[test]
    fn fnv1a_matches_viewer_hash() {
        // fnv1a32("550e8400-e29b-41d4-a716-446655440000") === 2292069672
        assert_eq!(
            fnv1a32("550e8400-e29b-41d4-a716-446655440000"),
            2_292_069_672_u32
        );
        // fnv1a32("test-file-id") === 4043076924
        assert_eq!(fnv1a32("test-file-id"), 4_043_076_924_u32);
    }

    // ─── chunk header parsing tests ──────────────────────────────────────────

    #[test]
    fn chunk_header_parsing() {
        let id = "test-file-id";
        let seq: u32 = 7;
        let payload = b"hello world";

        let frame = build_chunk_frame(id, seq, payload);

        assert!(frame.len() >= 8);
        let id_hash_parsed = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
        let seq_parsed = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
        let payload_parsed = &frame[8..];

        assert_eq!(id_hash_parsed, fnv1a32(id));
        assert_eq!(seq_parsed, seq);
        assert_eq!(payload_parsed, payload);
    }

    #[test]
    fn chunk_too_short_is_rejected() {
        let mut mgr = FileTransferManager::new();
        let result = mgr.handle_chunk(&[0u8; 4]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too short"));
    }

    // ─── FileEvent serialization tests ───────────────────────────────────────

    #[test]
    fn file_event_offer_serializes_with_kebab_kind() {
        let ev = FileEvent::FileOffer {
            id: "abc".to_string(),
            name: "test.txt".to_string(),
            size: 1024,
            mime: "text/plain".to_string(),
        };
        let json = serde_json::to_string(&ev).expect("serialize");
        assert!(json.contains(r#""kind":"file-offer""#));
    }

    #[test]
    fn file_event_accept_deserializes() {
        let json = r#"{"kind":"file-accept","id":"abc"}"#;
        let ev: FileEvent = serde_json::from_str(json).expect("deserialize");
        if let FileEvent::FileAccept { id } = ev {
            assert_eq!(id, "abc");
        } else {
            panic!("expected FileAccept");
        }
    }

    // ─── out-of-order chunk buffering test ───────────────────────────────────

    #[test]
    fn out_of_order_chunks_are_reassembled() {
        use tempfile::NamedTempFile;

        let tmp = NamedTempFile::new().expect("tempfile");
        let file = tmp.reopen().expect("reopen");

        let state = ReceiveState {
            id: "oo-id".to_string(),
            name: "oo.bin".to_string(),
            total_size: 6,
            received_bytes: 0,
            file: BufWriter::new(file),
            pending_chunks: BTreeMap::new(),
            next_seq: 0,
        };

        let id_hash = fnv1a32("oo-id");
        let mut mgr = FileTransferManager::new();
        mgr.active.insert(id_hash, state);

        // Send seq=1 before seq=0 — must be buffered.
        let frame1 = build_chunk_frame("oo-id", 1, b"DEF");
        mgr.handle_chunk(&frame1).expect("chunk 1");

        // Send seq=0 — should flush both.
        let frame0 = build_chunk_frame("oo-id", 0, b"ABC");
        mgr.handle_chunk(&frame0).expect("chunk 0");

        let s = mgr.active.get(&id_hash).expect("state present");
        // Both chunks written — pending_chunks empty, next_seq advanced.
        assert_eq!(s.next_seq, 2);
        assert!(s.pending_chunks.is_empty());
        assert_eq!(s.received_bytes, 6);
    }
}
