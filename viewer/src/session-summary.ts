// Per-session metadata for the post-stream summary card (gh #73).
// Tracks only what the user can act on: how long the session ran, how it
// was routed, and any files that came down. The tracker is the source of
// truth for "did this session actually go live?" — the summary card only
// appears when at least one frame was received.

import type { ConnectionType } from "./webrtc-client.js";

export interface ReceivedFile {
  name: string;
  size: number;
}

export interface SessionSummary {
  durationMs: number;
  connectionType: ConnectionType | null;
  receivedFiles: ReceivedFile[];
}

export class SessionTracker {
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private connectionType: ConnectionType | null = null;
  private receivedFiles: ReceivedFile[] = [];

  // Inject `now` so tests can run with fake timers without monkey-patching
  // Date.now. Production code uses the default.
  constructor(private now: () => number = () => Date.now()) {}

  markStreamStarted(): void {
    if (this.startedAt === null) this.startedAt = this.now();
  }

  setConnectionType(type: ConnectionType): void {
    this.connectionType = type;
  }

  recordReceivedFile(file: ReceivedFile): void {
    this.receivedFiles.push(file);
  }

  markEnded(): void {
    if (this.startedAt !== null && this.endedAt === null) {
      this.endedAt = this.now();
    }
  }

  isLive(): boolean {
    return this.startedAt !== null;
  }

  summary(): SessionSummary | null {
    if (this.startedAt === null) return null;
    const end = this.endedAt ?? this.now();
    return {
      durationMs: Math.max(0, end - this.startedAt),
      connectionType: this.connectionType,
      receivedFiles: [...this.receivedFiles],
    };
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatConnectionType(type: ConnectionType | null): string {
  if (type === "p2p") return "Direkt (peer-to-peer)";
  if (type === "relay") return "Über Relay-Server";
  return "Unbekannt";
}
