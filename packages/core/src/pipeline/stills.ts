import { join, dirname, basename, extname } from 'node:path';
import { copyFile, writeFile, readFile, open as openFile, unlink } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import type { TimingManifest } from '../types.js';
import { ensureDir, exists } from '../util/fs.js';

/**
 * Still export (#71): publish the per-step frames the record phase already
 * captures as a durable, named artifact, so a render doubles as the
 * screenshot source for help documentation.
 *
 * Record captures up to two frames per step — the pre-action one
 * (workDir/steps/<id>@before.png), taken with the cursor on the focus target,
 * and the settled end-of-step one (workDir/steps/<id>.png, also what the
 * contact sheet assembles). This phase is file plumbing over those: select a
 * variant, copy, index. The index is the point: a step's `alt` (or its
 * narration) becomes the caption, so a docs author gets captioned images that
 * stay in sync with the tutorial.
 *
 * Scope notes (see #71): zoom never applies (it is an ffmpeg filter applied
 * later in post); stills carry the fake cursor but no callout ring (it
 * self-removes well before either capture point). A full-frame still is 2x the
 * CSS viewport from record's `deviceScaleFactor: 2`; under `crop` each image is
 * its own target's size instead.
 */

export interface StillsConfig {
  /**
   * Which steps to export: comma-separated step ids and/or "from-id..to-id"
   * ranges. All steps when omitted.
   */
  steps?: string;
  /** Also write index.md with paste-ready markdown image snippets. Default true. */
  markdown?: boolean;
  /**
   * Which frame to export per step: the pre-action frame (default), the settled
   * end-of-step frame, or both. Per-step `Step.still` overrides this.
   */
  capture?: 'before' | 'after' | 'both';
  /** Crop to the step's focus target plus padding. Default false. */
  crop?: 'target' | false;
  /** Padding in CSS px around a crop. Default 24. */
  cropPaddingPx?: number;
  /**
   * `'id'` (default) → `<step-id>.png`, stable when a step is inserted earlier.
   * `'indexed'` → `NN-<step-id>.png`, listing in tutorial order.
   */
  filenames?: 'id' | 'indexed';
}

export const DEFAULT_STILLS: Required<Omit<StillsConfig, 'steps'>> = {
  markdown: true,
  capture: 'before',
  crop: false,
  cropPaddingPx: 24,
  filenames: 'id',
};

export interface StillEntry {
  /** 1-based position in the tutorial (not in the selection). */
  index: number;
  id: string;
  narration: string;
  /** Absolute path to record's screenshot; may not exist (skipped if missing). */
  source: string;
  /** Basename written into the stills dir, e.g. "save.png" or "03-save.png". */
  file: string;
  /** Which captured frame this entry publishes. */
  variant: 'before' | 'after';
  /**
   * Whether *this* recording pass produced a frame for the step — true only for
   * steps present in the pass's manifest, which on a failed render is just the
   * ones that completed. `runRecordPhase` clears `steps/` on entry so a reused
   * work dir cannot carry frames between passes; this flag is the second guard,
   * keeping a partial render from publishing a frame for a step that never ran.
   */
  recorded: boolean;
}

/**
 * Decode a PNG to raw 8-bit RGBA-ish scanlines using only node:zlib, so a
 * re-export can tell "visually identical" from "different" without pulling in
 * an image library or shelling out to ffmpeg (the stills path advertises that
 * it needs neither). Returns null for anything outside Playwright's output
 * shape (8-bit, non-interlaced, colour type 0/2/4/6), which callers treat as
 * "can't compare".
 */
function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer } | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    // A chunk that runs past the end means the file is truncated — a half-written
    // copy, say. Bail instead of reading a short subarray and overrunning it.
    if (pos + 12 + len > buf.length) return null;
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      if (body.length < 13) return null;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0) return null;
      if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return null;
      const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
      channels = CHANNELS[colorType!] ?? 0;
      if (!channels) return null;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }
  if (!width || !height || !channels || idat.length === 0) return null;
  let raw: Buffer;
  try {
    // Cap the output at exactly what IHDR implies, so a corrupt or crafted IDAT
    // can't inflate into an unbounded allocation.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * channels + 1) * height });
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  // Undo per-scanline filtering (PNG spec §9).
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= channels ? prev[x - channels]! : 0;
      const v = line[x]!;
      let val: number;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      cur[x] = val & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largest per-channel difference that still counts as the same screenshot. */
const STILL_PIXEL_TOLERANCE = 8;

/**
 * Whether two PNGs are the same picture. Re-rendering the same tutorial
 * produces frames that differ by a few least-significant bits (antialiasing,
 * font rasterisation) while being visually identical — rewriting those churns
 * a docs repo that commits its stills, defeating the point of the
 * timestamp-free index (#71 §5).
 */
export async function stillsEquivalent(a: string, b: string): Promise<boolean> {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    [bufA, bufB] = await Promise.all([readFileBytes(a), readFileBytes(b)]);
  } catch {
    return false;
  }
  if (bufA.equals(bufB)) return true;
  // A malformed destination (a half-written copy from an interrupted export, or
  // something an author dropped in) must degrade to "different" — i.e. rewrite
  // it — never abort the export.
  let pa: ReturnType<typeof decodePng>;
  let pb: ReturnType<typeof decodePng>;
  try {
    pa = decodePng(bufA);
    pb = decodePng(bufB);
  } catch {
    return false;
  }
  if (!pa || !pb) return false;
  if (pa.width !== pb.width || pa.height !== pb.height || pa.channels !== pb.channels) return false;
  for (let i = 0; i < pa.data.length; i++) {
    if (Math.abs(pa.data[i]! - pb.data[i]!) > STILL_PIXEL_TOLERANCE) return false;
  }
  return true;
}

function readFileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

/** One still as recorded in a written index.json. */
export interface StillIndexEntry {
  index: number;
  id: string;
  file: string;
  narration: string;
  /** Which frame this is. Present so a `capture: 'both'` pair is distinguishable. */
  variant?: 'before' | 'after';
}

/**
 * Read the index.json a previous export left behind. It is the authority on
 * which files this phase owns: a name-shape regex would also match an author's
 * own `03-save-annotated.png` or `2024-logo.png`, and deleting those is
 * unacceptable when the advertised workflow is committing this directory to a
 * docs repo. Returns [] when there is no readable previous index, which makes
 * the export purely additive — the safe direction.
 */
/** True when this step published a still this run, but under a different filename. */
function renamedAway(previous: StillIndexEntry, present: StillEntry[]): boolean {
  return present.some((e) => e.id === previous.id && e.file !== previous.file);
}

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
  /** Stills left untouched because the new frame was visually identical (#71 §5). */
  unchanged: number;
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
export function stillFileName(
  index: number,
  id: string,
  totalSteps: number,
  scheme: 'id' | 'indexed' = DEFAULT_STILLS.filenames,
  variant: 'before' | 'after' = 'before',
): string {
  const suffix = variant === 'after' ? '-after' : '';
  const safe = fileSafeId(id);
  if (scheme === 'id') return `${safe}${suffix}.png`;
  const width = Math.max(2, String(totalSteps).length);
  return `${String(index).padStart(width, '0')}-${safe}${suffix}.png`;
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
  config: StillsConfig = {},
): StillEntry[] {
  const total = tutorialStepIds.length;
  const scheme = config.filenames ?? DEFAULT_STILLS.filenames;
  const defaultMode = config.capture ?? DEFAULT_STILLS.capture;
  const recorded = new Map(manifest.steps.map((s) => [s.id, s]));

  const entries: StillEntry[] = [];
  for (const i of selectStillStepIds(tutorialStepIds, manifest.tutorialId, steps)) {
    const id = tutorialStepIds[i]!;
    const step = recorded.get(id);
    const mode = assertCaptureMode(step?.still ?? defaultMode, id);
    // Caption precedence: the step's explicit alt, else its narration (#71 §4).
    const caption = step?.alt ?? step?.narration ?? '';
    const variants: Array<'before' | 'after'> =
      mode === 'both' ? ['before', 'after'] : [mode];
    // The "-after" suffix exists only to let the two frames coexist. When a
    // step exports just one, it gets the plain name — a docs link shouldn't
    // say "-after" merely because the author preferred the settled frame.
    const suffixed = variants.length > 1;
    for (const variant of variants) {
      entries.push({
        index: i + 1,
        id,
        narration: caption,
        // record writes the pre-action frame as <id>@before.png and the
        // settled one as <id>.png.
        // Matches what record writes — both sides sanitise, so an awkward id
        // can't point the export at a path record never wrote (or escape the dir).
        source: join(
          workDir,
          'steps',
          variant === 'before' ? `${fileSafeId(id)}@before.png` : `${fileSafeId(id)}.png`,
        ),
        file: stillFileName(i + 1, id, total, scheme, suffixed ? variant : 'before'),
        variant,
        recorded: step !== undefined,
      });
    }
  }
  // Check the whole tutorial, not just the selection: two colliding steps in
  // separate subset exports would otherwise each succeed and silently write
  // onto one file.
  assertNoFilenameCollisions(tutorialStepIds, total, scheme, manifest.tutorialId);
  return entries;
}

/**
 * `filenames: 'id'` drops the index prefix that used to guarantee uniqueness,
 * and `fileSafeId` can map two distinct ids onto one name ("a b" and "a-b").
 * Fail loudly rather than silently overwriting one still with another.
 */
export function assertNoFilenameCollisions(
  tutorialStepIds: string[],
  totalSteps: number,
  scheme: 'id' | 'indexed',
  tutorialId: string,
): void {
  const seen = new Map<string, string>();
  tutorialStepIds.forEach((id, i) => {
    // Both variants, so a step named "<x>-after" can't collide with x's settled frame.
    for (const variant of ['before', 'after'] as const) {
      const file = stillFileName(i + 1, id, totalSteps, scheme, variant);
      const prior = seen.get(file);
      if (prior !== undefined && prior !== id) {
        throw new Error(
          `Steps "${prior}" and "${id}" in tutorial "${tutorialId}" both produce the still "${file}". ` +
            (scheme === 'id'
              ? 'Rename one step, or set stills.filenames to "indexed".'
              : 'Rename one of the steps.'),
        );
      }
      seen.set(file, id);
    }
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
        // Per-still dimensions, so a cropped set is still machine-readable.
        ...(meta.pixelSize ? {} : { pixelSizeVaries: true }),
        stills: entries.map((e) => ({
          index: e.index,
          id: e.id,
          file: e.file,
          narration: e.narration,
          ...(e.variant ? { variant: e.variant } : {}),
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * Section heading for a still: the caption's first sentence reads far better
 * than the raw step id ("## 4. continue"), which is an internal handle (#71 §4).
 * Falls back to the id when there is no caption.
 */
function headingFor(e: StillIndexEntry): string {
  const flat = (e.narration ?? '').replace(/\s+/g, ' ').trim();
  const base = flat ? firstSentence(flat) : e.id;
  // Under capture: 'both' the two frames share a caption and an index; say which
  // is which rather than emitting the same heading twice.
  return e.variant === 'after' ? `${base} (result)` : base;
}

/**
 * The caption's opening sentence, for a section heading. Splits on terminal
 * punctuation followed by a capital, so "e.g. report.pdf" doesn't end the
 * sentence, and truncates on grapheme boundaries so an emoji or combining mark
 * is never cut in half.
 */
function firstSentence(text: string): string {
  const match = /^(.*?[.!?\u3002])(?=\s+[\p{Lu}\p{Lo}])/u.exec(text);
  const sentence = (match?.[1] ?? text).trim();
  const stripped = sentence.replace(/[.\u3002]+$/u, '');
  return truncateGraphemes(stripped, 60).replace(/[|\[\]#`<>]/g, '');
}

/** Truncate to at most `max` user-perceived characters, appending an ellipsis. */
function truncateGraphemes(text: string, max: number): string {
  const units =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.segment)
      : [...text];
  if (units.length <= max) return text;
  return `${units.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Guard the mode for callers who bypass the zod-validated config (the programmatic API). */
function assertCaptureMode(mode: unknown, stepId: string): 'before' | 'after' | 'both' {
  if (mode !== 'before' && mode !== 'after' && mode !== 'both') {
    throw new Error(
      `Invalid stills capture mode ${JSON.stringify(mode)} for step "${stepId}" (expected before | after | both)`,
    );
  }
  return mode;
}

function variantRank(e: StillIndexEntry): number {
  return e.variant === 'after' ? 1 : 0;
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
    'Alt text comes from each step’s `alt`, falling back to its narration — a draft caption, not a finished one. Edit freely once pasted into your docs.',
    '',
  ];
  for (const e of entries) {
    // encodeURI as belt-and-braces: fileSafeId already removes the characters
    // that would break a markdown link, but the href should survive either way.
    lines.push(
      `## ${e.index}. ${headingFor(e)}`,
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
      unchanged: 0,
    };
  }

  await ensureDir(outDir);
  const previous = await readPreviousIndex(outDir);

  const files: string[] = [];
  let unchanged = 0;
  for (const e of present) {
    const dest = join(outDir, e.file);
    // Leave a byte-identical-enough file alone so committed stills don't churn.
    if (await stillsEquivalent(e.source, dest)) unchanged++;
    else await copyFile(e.source, dest);
    files.push(dest);
  }

  // Reconcile against the previous export.
  const freshFiles = new Set(present.map((e) => e.file));
  const tutorialIds = new Set(input.tutorialStepIds ?? entries.map((e) => e.id));
  const carried: StillIndexEntry[] = [];
  let pruned = 0;
  for (const p of previous) {
    if (freshFiles.has(p.file)) continue; // just rewritten
    // Keying on the *file*, not the id, is what catches a still whose name
    // changed — switching filenames: 'indexed' → 'id', or capture 'both' → one
    // variant. Keyed on id those files survived on disk while dropping out of
    // the index, leaving a docs page pointing at a frozen screenshot forever.
    if (!tutorialIds.has(p.id) || renamedAway(p, present)) {
      // Either the step left the tutorial, or this step published under a
      // different name this run — the old file is an orphan either way.
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

  // Stamp the real pixel dimensions — but only when every still shares them.
  // Under crop each image has its own size, and a single number would be a lie
  // an author might hardcode.
  const sizes = await Promise.all(files.map((f) => pngSize(f)));
  const first = sizes[0];
  const uniform =
    first !== undefined &&
    sizes.every((d) => d !== undefined && d.width === first.width && d.height === first.height);
  const indexMeta: StillsIndexMeta = {
    ...meta,
    ...(uniform ? { pixelSize: first } : { pixelSize: undefined }),
  };

  const indexed: StillIndexEntry[] = [
    ...present.map((e) => ({
      index: e.index,
      id: e.id,
      file: e.file,
      narration: e.narration,
      variant: e.variant,
    })),
    ...carried,
  ].sort((a, b) => a.index - b.index || variantRank(a) - variantRank(b));

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

  return {
    dir: outDir,
    files,
    indexJsonPath,
    indexMarkdownPath,
    missing,
    kept: carried.length,
    pruned,
    unchanged,
  };
}
