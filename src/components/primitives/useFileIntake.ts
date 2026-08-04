import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, CSSProperties, DragEvent } from 'react';

/**
 * useFileIntake — THE upload primitive. One headless hook that gives any UI
 * (dashed zone, icon button, chat composer, whole page) the full intake set:
 *
 *   • drag & drop  — depth-counted `dragging` state (no flicker over children),
 *     reacts ONLY to drags that carry files (never to in-app reorder drags),
 *     reads `dataTransfer.items` when `files` is empty (iOS/iPadOS WebKit).
 *   • paste        — clipboard files on the element carrying `rootProps`.
 *   • picker       — hidden input via `inputProps` + programmatic `open()`;
 *     `accept` drives the iOS photo-library/file-picker choice, `capture`
 *     opens the camera.
 *   • folders      — OPT-IN (`directories` for drops, `pickDirectories` for the
 *     picker): a whole tree comes in flat, each file stamped with the `relPath`
 *     it was found at, so a consumer can read the folders it came from.
 *
 * Usage — spread `rootProps` on the drop surface, render an <input
 * {...inputProps} />, and wire your own click affordance to `open()`
 * (deliberately not auto-attached, so buttons/labels never double-open):
 *
 *   const intake = useFileIntake({ accept: 'image/*', onFiles: ([f]) => upload(f) });
 *   <div {...intake.rootProps} onClick={intake.open} className={intake.dragging ? … : …}>
 *     …
 *     <input {...intake.inputProps} />
 *   </div>
 *
 * Nesting is safe: an inner intake consumes the drop (flagged on the native
 * event) and outer intakes still clear their highlight. While at least one
 * intake is mounted, a window-level guard stops the browser from navigating
 * away when a file misses every zone (the classic drop-outside-the-target
 * data-loss on desktop).
 */

export interface FileIntakeOptions {
  /** Receives the accepted files (≥1, already filtered by `accept`). */
  onFiles: (files: File[]) => void;
  /** Lenient accept list — ".csv" (extension), "image/*" (family) or exact MIME. */
  accept?: string;
  /** Deliver every accepted file; default hands over only the first. */
  multiple?: boolean;
  disabled?: boolean;
  /** Forwarded to the input — e.g. "environment" for the rear camera. */
  capture?: boolean | 'user' | 'environment';
  /** Files that failed the `accept` filter (show a hint, never silent-drop). */
  onReject?: (files: File[]) => void;
  /** Walk DROPPED folders (default off — every other consumer takes files
   *  only). Each delivered file carries the `relPath` it was found at. */
  directories?: boolean;
  /** The folder walk hit its file ceiling and delivered a PREFIX of the tree.
   *  Wire it or the dealer is told nothing when half a library is dropped. */
  onTruncated?: (delivered: number) => void;
  /** Make the picker a FOLDER picker (`webkitdirectory`). Separate opt-in
   *  because it REPLACES multi-file selection in the native dialog — a surface
   *  that wants both affordances renders two intakes. */
  pickDirectories?: boolean;
  /**
   * SIDECARS — kinds that ride ALONGSIDE the accepted files but are never
   * content on their own (a Ligne Roset product folder ships its texture
   * bitmaps next to the .3ds, and the mesh is unreadable without them).
   *
   * Same lenient syntax as `accept`. A sidecar is delivered with the batch and
   * never reported to `onReject` — but it CANNOT carry a drop by itself: a pick
   * that matched only sidecars rejects exactly as it did before this option
   * existed (a folder of pure bitmaps is still "no models here"), so nothing
   * downstream has to re-derive "was there anything real in that?".
   */
  sidecarAccept?: string;
}

/**
 * The one extra own property this hook stamps: the POSIX-ish path a file was
 * found at, relative to the dropped/picked root
 * ("upholstery-sofa/Togo/Togo_gb.3ds"). A file picked through `webkitdirectory`
 * carries the same fact natively as the read-only `webkitRelativePath`; BOTH
 * sources are normalized onto `relPath` so a consumer reads exactly one thing.
 * A loose file carries its bare name (no separator ⇒ no folders).
 */
export type FileWithPath = File & { relPath?: string };

/** Whether this browser's native picker can select a FOLDER at all
 *  (`webkitdirectory`) — true on every evergreen desktop browser (Chrome,
 *  Edge, Firefox 50+, Safari on macOS), but iOS/iPadOS Safari has never
 *  implemented it — no exception, no fallback prompt, the input just quietly
 *  behaves like an ordinary file picker with no way to pick a directory.
 *  Callers use this to hide/disable a folder-picker affordance instead of
 *  offering one that can't do what it says on that device. */
export function supportsDirectoryPicker(): boolean {
  if (typeof document === 'undefined') return false;
  return 'webkitdirectory' in document.createElement('input');
}

// A mis-dropped drive must not hang the tab — but the real workload is Ligne
// Roset's whole 3D library (`International-3DS`), which is THOUSANDS of files,
// so 500 stopped the actual use case rather than an accident. Hitting the cap
// is REPORTED (`onTruncated`), never silent: an import that quietly kept the
// first N and dropped the rest reads as "it worked".
const MAX_WALK_FILES = 5000;

const relPathOf = (f: File): string => (f as FileWithPath).relPath || f.webkitRelativePath || '';

function stampRelPath(file: File, path: string): File {
  try { (file as FileWithPath).relPath = path; } catch { /* frozen File — the name still reads */ }
  return file;
}

// Fallback MIME sniff for files that arrive typeless (iOS drags and some
// WebKit clipboard files) so "image/*" zones don't bounce a real photo.
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values',
};

function fileMime(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
  return EXT_MIME[ext] || '';
}

export function matchesAccept(file: File, accept?: string): boolean {
  if (!accept || !file) return true;
  const name = (file.name || '').toLowerCase();
  const mime = fileMime(file);
  return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) => (
    a.startsWith('.') ? name.endsWith(a)
      : a.endsWith('/*') ? mime.startsWith(a.slice(0, -1))
        : mime === a
  ));
}

// DataTransfer.types is a frozen array in modern browsers but a DOMStringList
// in older WebKit — probe both shapes.
function typesHaveFiles(types: unknown): boolean {
  const t = types as { includes?: (s: string) => boolean; contains?: (s: string) => boolean } | null;
  if (!t) return false;
  if (typeof t.includes === 'function') return t.includes('Files');
  if (typeof t.contains === 'function') return t.contains('Files');
  return false;
}

function dtHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && typesHaveFiles(dt.types);
}

// `files` first; fall back to `items` (iOS/iPadOS drags sometimes populate
// only the item list). Works for both DataTransfer and clipboardData.
function extractFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  if (dt.files && dt.files.length) return Array.from(dt.files);
  return Array.from(dt.items || [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

// ── Folder walking (only ever reached with `directories` on).

/** The SYNCHRONOUS half of a folder drop: one handle per dropped item, taken
 *  before any await — a DataTransfer is dead the moment the handler returns,
 *  while the walk below is asynchronous. */
function dropHandles(dt: DataTransfer | null) {
  return Array.from(dt?.items || [])
    .filter((i) => i.kind === 'file')
    .map((i) => ({
      entry: typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null,
      file: i.getAsFile(),
    }));
}

const entryFile = (entry: FileSystemFileEntry): Promise<File | null> => new Promise((resolve) => {
  try { entry.file((f) => resolve(f), () => resolve(null)); } catch { resolve(null); }
});

/** One directory's children. `readEntries` hands back at most ~100 per call in
 *  Chromium, so it MUST be drained until an EMPTY batch comes back — a single
 *  call silently truncates a real collection folder. */
function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve) => {
    const pump = () => {
      reader.readEntries((batch) => {
        if (!batch.length || out.length >= MAX_WALK_FILES) { resolve(out); return; }
        out.push(...batch);
        pump();
      }, () => resolve(out));
    };
    pump();
  });
}

/** Depth-first walk of ONE dropped entry, stamping every file with the path it
 *  was found at. Bounded by MAX_WALK_FILES. */
async function walkEntry(entry: FileSystemEntry | null, prefix: string, out: File[]): Promise<void> {
  if (!entry || out.length >= MAX_WALK_FILES) return;
  if (entry.isFile) {
    const f = await entryFile(entry as FileSystemFileEntry);
    if (f) out.push(stampRelPath(f, prefix ? `${prefix}/${f.name}` : f.name));
    return;
  }
  if (!entry.isDirectory) return;
  const next = prefix ? `${prefix}/${entry.name}` : entry.name;
  for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
    if (out.length >= MAX_WALK_FILES) return;
    await walkEntry(child, next, out);
  }
}

/** Every dropped handle → ONE flat, path-stamped list. Falls back to the plain
 *  DataTransfer files when the browser handed back no entries at all (no entry
 *  API ⇒ there were no folders to walk anyway). */
async function walkDropped(
  handles: ReturnType<typeof dropHandles>,
  fallback: File[],
): Promise<{ files: File[]; truncated: boolean }> {
  const out: File[] = [];
  let any = false;
  for (const h of handles) {
    if (h.entry) { any = true; await walkEntry(h.entry, '', out); }
    else if (h.file) { any = true; out.push(stampRelPath(h.file, h.file.name)); }
  }
  // At the cap we cannot tell "exactly that many" from "there were more", and
  // saying so is the safe error: the caller warns, nothing is lost silently.
  return { files: any ? out : fallback, truncated: out.length >= MAX_WALK_FILES };
}

/** Whether a file matches an OPTIONAL extra list. Distinct from `matchesAccept`
 *  because an EMPTY list there means "everything passes" — right for `accept`
 *  (no filter), catastrophic for a sidecar list (every junk file would ride
 *  along and a folder of nothing could never reject). */
const matchesSidecar = (file: File, sidecar?: string): boolean => !!sidecar && matchesAccept(file, sidecar);

/** Files found INSIDE a folder are filtered against `accept` SILENTLY — a
 *  collection folder is full of .txt/.jpg junk and that is not a dealer
 *  mistake. A loose file still rides the ordinary `onReject` path. Sidecars
 *  survive the same cut (they are the accepted files' own material), and
 *  `deliver` is what decides whether they amount to anything. */
function acceptNested(files: File[], accept?: string, sidecar?: string): File[] {
  return files.filter((f) => !relPathOf(f).includes('/') || matchesAccept(f, accept) || matchesSidecar(f, sidecar));
}

// Window-level guard (refcounted across mounted intakes): a file dropped
// outside every zone must not navigate the SPA away to the file.
let guardCount = 0;
function guardDragOver(e: globalThis.DragEvent) { if (dtHasFiles(e.dataTransfer)) e.preventDefault(); }
function guardDrop(e: globalThis.DragEvent) { if (dtHasFiles(e.dataTransfer)) e.preventDefault(); }

// Flag stamped on the native event so nested intakes don't double-deliver.
const HANDLED = '__fileIntakeHandled';

export interface FileIntake {
  /** Spread on the drop/paste surface. */
  rootProps: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onPaste: (e: ClipboardEvent) => void;
  };
  /** Spread on a (self-hiding) <input>; pair with `open()`. */
  inputProps: {
    ref: (el: HTMLInputElement | null) => void;
    type: 'file';
    accept?: string;
    multiple: boolean;
    capture?: boolean | 'user' | 'environment';
    /** Present only with `pickDirectories` — the native folder picker. */
    webkitdirectory?: string;
    tabIndex: number;
    'aria-hidden': boolean;
    style: CSSProperties;
    disabled: boolean;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  };
  /** Open the native picker (wire to your own button/zone click). */
  open: () => void;
  /** True while a file drag hovers the surface — drive the highlight. */
  dragging: boolean;
}

export default function useFileIntake({
  onFiles, accept = '', multiple = false, disabled = false, capture, onReject, onTruncated,
  directories = false, pickDirectories = false, sidecarAccept = '',
}: FileIntakeOptions): FileIntake {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Latest-callback refs keep rootProps/inputProps stable across renders.
  const onFilesRef = useRef(onFiles); onFilesRef.current = onFiles;
  const onRejectRef = useRef(onReject); onRejectRef.current = onReject;
  const onTruncatedRef = useRef(onTruncated); onTruncatedRef.current = onTruncated;

  const deliver = useCallback((all: File[]) => {
    if (!all.length) return;
    const hits: File[] = [];    // matched `accept` — the CONTENT
    const rides: File[] = [];   // matched `sidecarAccept` — carried, never content
    const bad: File[] = [];
    for (const f of all) {
      if (matchesAccept(f, accept)) hits.push(f);
      else if (matchesSidecar(f, sidecarAccept)) rides.push(f);
      else bad.push(f);
    }
    // NOTHING real came in ⇒ the sidecars are junk like anything else. Without
    // this the option would quietly change what a drop MEANS: a folder of pure
    // bitmaps would "succeed" with zero models, and the caller's onReject —
    // the only thing that tells the dealer his pick was wrong — never fires.
    if (!hits.length) {
      const refused = [...rides, ...bad];
      if (refused.length) onRejectRef.current?.(refused);
      return;
    }
    if (bad.length) onRejectRef.current?.(bad);
    // Single-file mode takes the first CONTENT file, never a sidecar that
    // happened to be listed ahead of it.
    const chosen = multiple ? [...hits, ...rides] : hits.slice(0, 1);
    onFilesRef.current(chosen);
  }, [accept, sidecarAccept, multiple]);

  useEffect(() => {
    guardCount += 1;
    if (guardCount === 1) {
      window.addEventListener('dragover', guardDragOver);
      window.addEventListener('drop', guardDrop);
    }
    return () => {
      guardCount -= 1;
      if (guardCount === 0) {
        window.removeEventListener('dragover', guardDragOver);
        window.removeEventListener('drop', guardDrop);
      }
    };
  }, []);

  // While highlighted, any drop/dragend anywhere clears the state — covers
  // drops consumed by a nested intake and drags cancelled outside the window.
  useEffect(() => {
    if (!dragging) return undefined;
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
    };
  }, [dragging]);

  const rootProps = useMemo(() => ({
    onDragEnter(e: DragEvent) {
      if (disabled || !dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(e: DragEvent) {
      if (disabled || !dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* IE-era quirk */ }
    },
    onDragLeave(e: DragEvent) {
      if (disabled || !dtHasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(e: DragEvent) {
      if (disabled || !dtHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const native = e.nativeEvent as unknown as Record<string, unknown>;
      if (native[HANDLED]) return; // a nested intake already took it
      native[HANDLED] = true;
      if (!directories) { deliver(extractFiles(e.dataTransfer)); return; }
      // Folders: the entry handles are taken NOW (synchronously), the walk
      // resolves a tick later — so `onFiles` fires after this handler returns.
      const handles = dropHandles(e.dataTransfer);
      const loose = extractFiles(e.dataTransfer);
      // A walk that blows up still delivers the plain files, so the drop fails
      // LOUDLY through the ordinary accept/reject path instead of vanishing.
      walkDropped(handles, loose)
        .then(({ files: walked, truncated }) => {
          if (truncated) onTruncatedRef.current?.(walked.length);
          const nested = acceptNested(walked, accept, sidecarAccept);
          // The whole tree matched NOTHING (a folder of pure texture/seed
          // junk, or the wrong folder entirely) — `deliver` would otherwise
          // see an ALREADY-EMPTY list and return before its own bad/ok split
          // ever runs, so `onReject` would never fire and the drop reads as
          // dead silence: the dealer watches the picker complete and nothing
          // happens, no error, nothing imported. (A tree of pure sidecars
          // survives this cut and is refused one line later, by `deliver`.)
          if (walked.length && !nested.length) { onRejectRef.current?.(walked); return; }
          deliver(nested);
        })
        .catch(() => deliver(loose));
    },
    onPaste(e: ClipboardEvent) {
      if (disabled) return;
      const native = e.nativeEvent as unknown as Record<string, unknown>;
      if (native[HANDLED]) return;
      const files = extractFiles(e.clipboardData);
      if (!files.length) return; // plain text paste — let it through
      native[HANDLED] = true;
      e.preventDefault();
      deliver(files);
    },
  }), [disabled, deliver, directories, accept, sidecarAccept]);

  const open = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const inputProps = useMemo(() => ({
    ref: (el: HTMLInputElement | null) => { inputRef.current = el; },
    type: 'file' as const,
    // The native dialog offers the sidecars too — a dealer picking a model's
    // files by hand has to be ABLE to pick its bitmaps, or the manual path
    // silently produces the untextured model the folder path fixed.
    accept: [accept, sidecarAccept].filter(Boolean).join(',') || undefined,
    multiple,
    capture,
    webkitdirectory: pickDirectories ? '' : undefined,
    tabIndex: -1,
    'aria-hidden': true,
    style: { display: 'none' } as CSSProperties,
    disabled,
    onChange(e: ChangeEvent<HTMLInputElement>) {
      const picked = Array.from(e.target.files || []);
      // A folder pick carries the tree in the native (read-only)
      // `webkitRelativePath` — copy it onto `relPath` so drop and pick hand a
      // consumer the SAME property. Empty on an ordinary pick: nothing stamped.
      for (const f of picked) if (f.webkitRelativePath) stampRelPath(f, f.webkitRelativePath);
      if (pickDirectories) {
        const nested = acceptNested(picked, accept, sidecarAccept);
        // Same silent-death guard as the drop path above: a picked folder
        // that matched nothing must not read as "the picker did nothing" —
        // the dealer just watched the OS dialog complete successfully.
        if (picked.length && !nested.length) { onRejectRef.current?.(picked); e.target.value = ''; return; }
        deliver(nested);
      } else {
        deliver(picked);
      }
      e.target.value = ''; // same file re-pickable immediately
    },
  }), [accept, sidecarAccept, multiple, capture, disabled, deliver, pickDirectories]);

  return { rootProps, inputProps, open, dragging };
}
