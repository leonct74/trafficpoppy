// One-shot file handoff: how a file made by this backend reaches the owner's disk.
//
// Two things can't save a file here. The frontend runs in a sandboxed frame inside a
// desktop webview that ignores `<a download>` and blob: URLs — a blob download is a dead
// button that reports success and produces nothing (CrewPoppy, founder live 2026-08-01;
// VM-Poppy's old key button had the same fault). And the backend is CONFINED
// (extension.json `backend.isolation: "strict"`): it may write only its data folder and
// the OS temp dir, so writing ~/Downloads or ~/Documents itself is not an option either.
//
// What works, and is the host's sanctioned path: the backend keeps the bytes in memory
// under a random single-use token; the frontend asks the host to open
// `/ext-dl/<poppy-id>/local-download/<token>` in the SYSTEM BROWSER; the broker proxies
// that one route (and only that route) to our `GET /local-download/:token`; the browser
// sees `Content-Disposition: attachment` and saves the file the normal way. The token
// dies on first use or after a minute. For a backup file that is the right shape: the
// bytes go straight to the browser, and the link can't be replayed.
//
// Same module as CrewPoppy's backend/src/local-download.ts — keep them in step.
import { randomUUID } from "node:crypto";

/** How long an unclaimed file waits before it is dropped. */
export const LOCAL_DOWNLOAD_TTL_MS = 60_000;

export interface StagedFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

type Pending = StagedFile & { timer: NodeJS.Timeout };

const pending = new Map<string, Pending>();

/** Base name only — no path separators (traversal), no leading dot (hidden file), never empty. */
export function safeFilename(filename: string, fallback = "download"): string {
  return (filename || fallback).replace(/[/\\]/g, "_").replace(/^\.+/, "_") || fallback;
}

/** Park a file for one fetch. Returns the token the frontend puts in the download URL. */
export function stageDownload(file: StagedFile, ttlMs = LOCAL_DOWNLOAD_TTL_MS): { token: string; filename: string } {
  const token = randomUUID();
  const filename = safeFilename(file.filename);
  const timer = setTimeout(() => pending.delete(token), ttlMs);
  if (typeof timer.unref === "function") timer.unref(); // never keep the process alive for this
  pending.set(token, { filename, contentType: file.contentType, bytes: file.bytes, timer });
  return { token, filename };
}

/** Claim a staged file. Single-use: the second call for the same token returns null. */
export function takeDownload(token: string): StagedFile | null {
  const item = pending.get(token);
  if (!item) return null;
  clearTimeout(item.timer);
  pending.delete(token);
  return { filename: item.filename, contentType: item.contentType, bytes: item.bytes };
}

/** `Content-Disposition` with an ASCII-safe name AND the RFC 5987 UTF-8 one; no header injection. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
