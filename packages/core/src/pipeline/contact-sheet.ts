import { join, dirname, basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { TimingManifest } from '../types.js';
import { exists } from '../util/fs.js';

/**
 * Authoring verification (#9): a single PNG grid with one settled thumbnail
 * per step, labeled with step id + narration. Lets an author confirm at a
 * glance that every step framed the right thing — a passing render only
 * proves selectors resolved, not that the intended element was on-screen.
 *
 * Built the same way as burned captions: render HTML in a headless browser
 * and screenshot it, so no image library is needed.
 */

export interface ContactSheetEntry {
  index: number;
  id: string;
  narration: string;
  /** Absolute path to the step's PNG; may not exist (skipped if missing). */
  file: string;
}

export interface ContactSheetStyle {
  /** Thumbnail width in px; cell height follows the viewport aspect. */
  thumbWidthPx: number;
  /** Grid columns. */
  columns: number;
}

export const DEFAULT_CONTACT_SHEET_STYLE: ContactSheetStyle = {
  thumbWidthPx: 480,
  columns: 3,
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface RenderedCell extends ContactSheetEntry {
  /** data: URI of the thumbnail, or null when the screenshot is missing. */
  dataUri: string | null;
}

/**
 * The contact-sheet document. Pure (cells already carry inlined image data),
 * so layout/labeling is unit-testable without a browser.
 */
export function contactSheetHtml(
  cells: RenderedCell[],
  aspect: number,
  style: ContactSheetStyle,
): string {
  const thumbH = Math.round(style.thumbWidthPx / aspect);
  const items = cells
    .map((c) => {
      const img = c.dataUri
        ? `<img src="${c.dataUri}" width="${style.thumbWidthPx}" height="${thumbH}" style="display:block;border-radius:6px;background:#000">`
        : `<div style="width:${style.thumbWidthPx}px;height:${thumbH}px;display:flex;align-items:center;justify-content:center;
             background:#1b1e26;color:#8a93a6;border-radius:6px;font-size:15px">no screenshot</div>`;
      const narration = c.narration ? escapeHtml(c.narration) : '<span style="color:#8a93a6">(no narration)</span>';
      return `
        <figure style="margin:0;width:${style.thumbWidthPx}px">
          ${img}
          <figcaption style="margin-top:8px;font-size:14px;line-height:1.3">
            <div style="font-weight:600;color:#fff">${c.index}. ${escapeHtml(c.id)}</div>
            <div style="color:#c2c8d4;margin-top:2px;max-height:2.7em;overflow:hidden">${narration}</div>
          </figcaption>
        </figure>`;
    })
    .join('');
  return `
    <body style="margin:0;padding:28px;background:#0f1117;
                 font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <div style="display:grid;grid-template-columns:repeat(${style.columns},${style.thumbWidthPx}px);
                  gap:28px 24px;justify-content:center">${items}</div>
    </body>`;
}

async function toDataUri(file: string): Promise<string | null> {
  if (!(await exists(file))) return null;
  try {
    const buf = await readFile(file);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Build entries from a manifest, pointing at the per-step screenshots the
 * record phase wrote into workDir/steps/<id>.png.
 */
export function contactSheetEntries(manifest: TimingManifest, workDir: string): ContactSheetEntry[] {
  return manifest.steps.map((s, i) => ({
    index: i + 1,
    id: s.id,
    narration: s.narration,
    file: join(workDir, 'steps', `${s.id}.png`),
  }));
}

/** Render the contact sheet to outPath. Returns outPath, or null if no thumbnails existed. */
export async function renderContactSheet(
  entries: ContactSheetEntry[],
  outPath: string,
  viewport: { width: number; height: number },
  style: ContactSheetStyle = DEFAULT_CONTACT_SHEET_STYLE,
): Promise<string | null> {
  const cells: RenderedCell[] = await Promise.all(
    entries.map(async (e) => ({ ...e, dataUri: await toDataUri(e.file) })),
  );
  if (cells.every((c) => c.dataUri === null)) return null;

  const aspect = viewport.width / viewport.height;
  const columns = Math.min(style.columns, Math.max(1, cells.length));
  const html = contactSheetHtml(cells, aspect, { ...style, columns });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    // Width sized to fit the grid; height auto-grows and fullPage captures it all.
    const pageWidth = columns * style.thumbWidthPx + (columns - 1) * 24 + 56;
    await page.setViewportSize({ width: pageWidth, height: 800 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: outPath, fullPage: true });
    return outPath;
  } finally {
    await browser.close();
  }
}

/** Default sheet path next to the final video: <output dir>/<name>-contact-sheet.png */
export function contactSheetPath(output: string): string {
  return join(dirname(output), `${basename(output, extname(output))}-contact-sheet.png`);
}
