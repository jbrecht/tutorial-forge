import { join, dirname, basename, extname } from 'node:path';
import { copyFile, writeFile, readFile, open as openFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { TimingManifest } from '../types.js';
import { ensureDir, exists } from '../util/fs.js';

/**
 * Still export (#71): publish the per-step frames the record phase already
 * captures as a durable, named artifact, so a render doubles as the
 * screenshot source for help documentation.
 *
 * The frames come from record's settled end-of-step screenshots
 * (workDir/steps/<id>.png) — the same ones the contact sheet assembles — so
 * this phase is pure file plumbing: select, copy, index. The index is the
 * point: narration is already written alt text, so a docs author gets
 * captioned images that stay in sync with the video's script.
 *
 * Scope notes (see #71): stills are the full, un-zoomed viewport (zoom is an
 * ffmpeg filter applied later in post) and carry the fake cursor but no
 * callout ring (the ring self-removes long before the settled frame). They
 * come out at 2x the CSS viewport, deterministically, from record's
 * `deviceScaleFactor: 2`.
 */

export interface StillsConfig {
  /**
   * Which steps to export: comma-separated step ids and/or "from-id..to-id"
   * ranges. All steps when omitted.
   */
  steps?: string;
  /** Also write index.md with paste-ready markdown image snippets. Default true. */
  markdown?: boolean;
}

export const DEFAULT_STILLS: Required<Omit<StillsConfig, 'steps'>> = { markdown: true };

export interface StillEntry {
  /** 1-based position in the tutorial (not in the selection). */
  index: number;
  id: string;
  narration: string;
  /** Absolute path to record's screenshot; may not exist (skipped if missing). */
  source: string;
  /** Basename written into the stills dir, e.g. "03-set-status.png". */
  file: string;
  /**
   * Whether *this* recording pass produced a frame for the step — true only for
   * steps present in the pass's manifest, which on a failed render is just the
   * ones that completed. `runRecordPhase` clears `steps/` on entry so a reused
   * work dir cannot carry frames between passes; this flag is the second guard,
   * keeping a partial render from publishing a frame for a step that never ran.
   */
  recorded: boolean;
}

/** One still as recorded in a written index.json. */
export interface StillIndexEntry {
  index: number;
  id: string;
  file: string;
  narration: string;
}

/**
 * Read the index.json a previous export left behind. It is the authority on
 * which files this phase owns: a name-shape regex would also match an author's
 * own `03-save-annotated.png` or `2024-logo.png`, and deleting those is
 * unacceptable when the advertised workflow is committing this directory to a
 * docs repo. Returns [] when there is no readable previous index, which makes
 * the export purely additive — the safe direction.
 */
async function readPreviousIndex(outDir: string): Promise<StillIndexEntry[]> {
  try {
    const raw = await readFile(join(outDir, 'index.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const stills = (parsed as { stills?: unknown }).stills;
    if (!Array.isArray(stills)) return [];
    return stills.filter(
      (e): e is StillIndexEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as StillIndexEntry).file === 'string' &&
        typeof (e as StillIndexEntry).id === 'string' &&
        typeof (e as StillIndexEntry).index === 'number',
    );
  } catch {
    return [];
  }
}

export interface StillsResult {
  /** The stills directory, or null when nothing was exported. */
  dir: string | null;
  /** Absolute paths of the PNGs written, in tutorial order. */
  files: string[];
  indexJsonPath: string | null;
  indexMarkdownPath: string | null;
  /** Step ids with no frame from this recording pass (e.g. steps after a failure). */
  missing: string[];
  /**
   * Stills carried forward from a previous export: still part of the tutorial,
   * outside this run's selection, and left in place so regenerating one step
   * doesn't discard the rest.
   */
  kept: number;
  /** Orphans deleted — previously-indexed stills whose step no longer exists. */
  pruned: number;
}

/** Default stills directory next to the final video: <output dir>/<name>-stills/ */
export function stillsDir(output: string): string {
  return join(dirname(output), `${basename(output, extname(output))}-stills`);
}

/**
 * Zero-padded, index-prefixed basename so a directory listing reads in
 * tutorial order. Padding comes from the tutorial's total step count, not the
 * selection, so a step's filename is identical whether it was exported alone
 * or as part of the whole set.
 */
export function stillFileName(index: number, id: string, totalSteps: number): string {
  const width = Math.max(2, String(totalSteps).length);
  return `${String(index).padStart(width, '0')}-${fileSafeId(id)}.png`;
}

/**
 * Step ids are only checked for uniqueness, not shape (`validateTutorial`
 * slug-checks the *tutorial* id), so an id can carry spaces, `#`, `?`, or even
 * path separators. Those would produce a broken markdown image link and, for
 * `../`, a copy outside the stills directory — so collapse anything outside a
 * filename-safe set. Slug-shaped ids (the overwhelming majority) pass through
 * unchanged.
 */
export function fileSafeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return safe || 'step';
}

/**
 * Resolve a selection expression against a list of step ids. Accepts
 * comma-separated ids and "from..to" ranges; duplicates collapse. Throws on an
 * unknown id (a typo'd step should fail loudly, not silently export nothing).
 *
 * Takes plain ids rather than a manifest so the selection can be validated
 * from the tutorial spec *before* the record phase runs — otherwise a typo
 * costs a full recording pass before it surfaces.
 */
export function selectStillStepIds(stepIds: string[], tutorialId: string, steps?: string): number[] {
  if (!steps?.trim()) return stepIds.map((_, i) => i);
  const indexOf = (id: string): number => {
    const i = stepIds.indexOf(id);
    if (i === -1) {
      throw new Error(
        `No step "${id}" in tutorial "${tutorialId}" (steps: ${stepIds.join(', ')})`,
      );
    }
    return i;
  };
  const picked = new Set<number>();
  for (const part of steps.split(',')) {
    const spec = part.trim();
    if (!spec) continue;
    const [fromId, toId = fromId] = spec.split('..').map((s) => s.trim());
    const from = indexOf(fromId!);
    const to = indexOf(toId!);
    if (to < from) throw new Error(`--stills-steps range "${spec}" runs backwards`);
    for (let i = from; i <= to; i++) picked.add(i);
  }
  // A selection that resolves to nothing (e.g. "," or " , ") would otherwise
  // export zero images and report it as "no frames found", blaming the
  // recording for a malformed selection. Fail like any other bad selection.
  if (picked.size === 0) {
    throw new Error(`--stills-steps "${steps}" selected no steps (steps: ${stepIds.join(', ')})`);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Selection resolved against a recorded manifest (what the export itself uses). */
export function selectStillSteps(manifest: TimingManifest, steps?: string): number[] {
  return selectStillStepIds(
    manifest.steps.map((s) => s.id),
    manifest.tutorialId,
    steps,
  );
}

/**
 * Pre-flight the selection against the tutorial spec, before recording. Throws
 * the same error the export would, just minutes earlier.
 */
export function validateStillsSelection(stepIds: string[], tutorialId: string, steps?: string): void {
  selectStillStepIds(stepIds, tutorialId, steps);
}

/**
 * Build entries for the selected steps, pointing at record's per-step
 * screenshots.
 *
 * `tutorialStepIds` is the tutorial spec's full id list and is the authority
 * for both selection and numbering; the manifest only supplies narration and
 * says which steps actually recorded. They differ on a failed render, where the
 * manifest holds just the completed steps — resolving against it there would
 * reject any selection naming a step that never ran (abandoning the whole
 * partial export) and would renumber the survivors. Defaults to the manifest's
 * own ids for a plain full-render call.
 */
export function stillsEntries(
  manifest: TimingManifest,
  workDir: string,
  steps?: string,
  tutorialStepIds: string[] = manifest.steps.map((s) => s.id),
): StillEntry[] {
  const total = tutorialStepIds.length;
  const recordedById = new Map(manifest.steps.map((s) => [s.id, s.narration]));
  return selectStillStepIds(tutorialStepIds, manifest.tutorialId, steps).map((i) => {
    const id = tutorialStepIds[i]!;
    const recorded = recordedById.has(id);
    return {
      index: i + 1,
      id,
      narration: recordedById.get(id) ?? '',
      source: join(workDir, 'steps', `${id}.png`),
      file: stillFileName(i + 1, id, total),
      // A step absent from the manifest did not record in this pass.
      recorded,
    };
  });
}

export interface StillsIndexMeta {
  tutorialId: string;
  title?: string;
  lang?: string;
  /** CSS viewport the tutorial recorded at. */
  viewport: { width: number; height: number };
  /**
   * Actual pixel dimensions of the exported PNGs — 2x the CSS viewport, because
   * the recording context pins `deviceScaleFactor: 2` (see record.ts). That is a
   * Playwright emulation setting, not a host-display property, so the size is
   * the same on a retina laptop and a headless CI box. Recorded explicitly so a
   * docs author can rely on the dimensions without re-measuring.
   */
  pixelSize?: { width: number; height: number };
}

/**
 * Read a PNG's dimensions from its IHDR chunk (big-endian u32 width/height at
 * byte 16/20). Cheap enough to do on one file and avoids an image dependency.
 * Returns undefined for anything that isn't a readable PNG.
 */
export async function pngSize(file: string): Promise<{ width: number; height: number } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(file, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(24), 0, 24, 0);
    // Require the signature *and* that the first chunk really is IHDR — a PNG
    // whose first chunk is something else would otherwise yield garbage.
    if (
      bytesRead < 24 ||
      buffer.toString('ascii', 1, 4) !== 'PNG' ||
      buffer.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      return undefined;
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Machine-readable index. Deliberately carries no timestamp: a docs repo that
 * commits its stills should see a diff only when an image or its narration
 * actually changed, not on every re-render.
 */
export function stillsIndexJson(entries: StillIndexEntry[], meta: StillsIndexMeta): string {
  return (
    JSON.stringify(
      {
        tutorialId: meta.tutorialId,
        ...(meta.title ? { title: meta.title } : {}),
        ...(meta.lang ? { lang: meta.lang } : {}),
        viewport: meta.viewport,
        ...(meta.pixelSize ? { pixelSize: meta.pixelSize } : {}),
        stills: entries.map((e) => ({
          index: e.index,
          id: e.id,
          file: e.file,
          narration: e.narration,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/** Escape text for use as markdown image alt text (single-line, bracket-safe). */
function altText(narration: string, id: string): string {
  const flat = narration.replace(/\s+/g, ' ').trim();
  if (!flat) return id;
  return flat.replace(/([\[\]\\])/g, '\\$1');
}

/**
 * Paste-ready markdown: one captioned image per step, referenced by basename
 * so the file works as-is inside the stills directory.
 */
export function stillsIndexMarkdown(entries: StillIndexEntry[], meta: StillsIndexMeta): string {
  const heading = meta.title ?? meta.tutorialId;
  const lines = [
    `# ${heading} — screenshots`,
    '',
    `Generated by tutorial-forge from tutorial \`${meta.tutorialId}\`${meta.lang ? ` (${meta.lang})` : ''}.`,
    'Alt text is each step’s narration — edit freely once pasted into your docs.',
    '',
  ];
  for (const e of entries) {
    // encodeURI as belt-and-braces: fileSafeId already removes the characters
    // that would break a markdown link, but the href should survive either way.
    lines.push(
      `## ${e.index}. ${e.id}`,
      '',
      `![${altText(e.narration, e.id)}](${encodeURI(e.file)})`,
      '',
    );
  }
  return lines.join('\n');
}

/**
 * Copy the selected stills into outDir and write the indexes. Entries whose
 * source screenshot is missing are reported in `missing` rather than failing:
 * on a failed render the completed steps still have frames on disk, and
 * exporting those is exactly when an author wants them.
 */
export interface ExportStillsInput {
  entries: StillEntry[];
  outDir: string;
  meta: StillsIndexMeta;
  config?: StillsConfig;
  /**
   * Every step id in the tutorial. Used to tell a still that is merely outside
   * this run's selection (keep it) from one whose step no longer exists at all
   * (an orphan to delete). Defaults to the entries' own ids, which makes a
   * subset export purely additive.
   */
  tutorialStepIds?: string[];
}

/**
 * Copy the selected stills into outDir and write the indexes.
 *
 * Three behaviors worth knowing:
 *
 * - **Missing frames are reported, not fatal.** On a failed render the
 *   completed steps still have frames on disk, and exporting those is exactly
 *   when an author wants them. A step with no frame *from this pass* lands in
 *   `missing` and never reaches the index, so there are no broken links.
 * - **Re-export merges.** Stills for steps outside this run's selection are
 *   left in place and folded into the index, so regenerating one changed step
 *   doesn't discard the other eleven.
 * - **Pruning is index-driven.** Only stills the previous index.json listed,
 *   whose step has since left the tutorial, are deleted. An author's own files
 *   in this directory are never touched.
 */
export async function exportStills(input: ExportStillsInput): Promise<StillsResult> {
  const { entries, outDir, meta } = input;
  const config = input.config ?? {};
  const wantMarkdown = config.markdown ?? DEFAULT_STILLS.markdown;

  const present: StillEntry[] = [];
  const missing: string[] = [];
  for (const e of entries) {
    // `recorded` first: a file at `source` can be a leftover from an earlier
    // run of a reused work dir, and publishing that as current would be a
    // silently stale screenshot.
    if (e.recorded && (await exists(e.source))) present.push(e);
    else missing.push(e.id);
  }
  if (present.length === 0) {
    // Nothing to publish — leave any previous export untouched rather than
    // emptying a directory the author may have committed.
    return {
      dir: null,
      files: [],
      indexJsonPath: null,
      indexMarkdownPath: null,
      missing,
      kept: 0,
      pruned: 0,
    };
  }

  await ensureDir(outDir);
  const previous = await readPreviousIndex(outDir);

  const files: string[] = [];
  for (const e of present) {
    const dest = join(outDir, e.file);
    await copyFile(e.source, dest);
    files.push(dest);
  }

  // Reconcile against the previous export.
  const freshIds = new Set(present.map((e) => e.id));
  const tutorialIds = new Set(input.tutorialStepIds ?? entries.map((e) => e.id));
  const carried: StillIndexEntry[] = [];
  let pruned = 0;
  for (const p of previous) {
    if (freshIds.has(p.id)) continue; // just rewritten
    if (!tutorialIds.has(p.id)) {
      // The step is gone from the tutorial — its still is an orphan.
      try {
        await unlink(join(outDir, p.file));
        pruned++;
      } catch {
        /* already gone; nothing to prune */
      }
      continue;
    }
    // Still a real step, just not in this selection: keep it if it's on disk.
    if (await exists(join(outDir, p.file))) carried.push(p);
  }

  // Stamp the real pixel dimensions from what we just wrote.
  const pixelSize = (await pngSize(files[0]!)) ?? meta.pixelSize;
  const indexMeta: StillsIndexMeta = { ...meta, pixelSize };

  const indexed: StillIndexEntry[] = [
    ...present.map((e) => ({ index: e.index, id: e.id, file: e.file, narration: e.narration })),
    ...carried,
  ].sort((a, b) => a.index - b.index);

  const indexJsonPath = join(outDir, 'index.json');
  await writeFile(indexJsonPath, stillsIndexJson(indexed, indexMeta));

  const markdownPath = join(outDir, 'index.md');
  let indexMarkdownPath: string | null = null;
  if (wantMarkdown) {
    indexMarkdownPath = markdownPath;
    await writeFile(markdownPath, stillsIndexMarkdown(indexed, indexMeta));
  } else {
    // A stale index.md from an earlier run would list pruned filenames — the
    // broken-link state this reconciliation exists to prevent.
    try {
      await unlink(markdownPath);
    } catch {
      /* nothing to remove */
    }
  }

  return { dir: outDir, files, indexJsonPath, indexMarkdownPath, missing, kept: carried.length, pruned };
}
