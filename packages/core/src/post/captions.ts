import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Cue } from './subtitles.js';
import { ensureDir } from '../util/fs.js';

/**
 * Burned-in captions, rendered by the browser instead of libass: each cue
 * becomes a transparent PNG "pill" composited by ffmpeg's built-in overlay
 * filter. Works on every ffmpeg build (Homebrew's ffmpeg 8 has no libass)
 * and styles with plain CSS.
 */

export interface CaptionStyle {
  fontSizePx: number;
  /** Pill wraps at this width. */
  maxWidthPx: number;
  /** Gap between the pill and the bottom edge of the video. */
  bottomMarginPx: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSizePx: 34,
  maxWidthPx: 1500,
  bottomMarginPx: 24,
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The caption pill document; pure so styling is unit-testable. */
export function captionHtml(text: string, style: CaptionStyle): string {
  return `
    <body style="margin:0;display:flex;justify-content:center;align-items:flex-end;height:100%;background:transparent">
      <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:${style.fontSizePx}px;line-height:1.35;
                  color:#fff;background:rgba(12,14,20,.82);padding:14px 28px;border-radius:12px;
                  max-width:${style.maxWidthPx}px;text-align:center">${escapeHtml(text)}</div>
    </body>`;
}

export interface CaptionImage {
  file: string;
  startMs: number;
  endMs: number;
}

/** Render one transparent PNG per cue into outDir. */
export async function renderCaptionImages(
  cues: Cue[],
  style: CaptionStyle,
  outDir: string,
  viewportWidth: number,
): Promise<CaptionImage[]> {
  await ensureDir(outDir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: viewportWidth, height: Math.max(200, style.fontSizePx * 8) },
      deviceScaleFactor: 1,
    });
    const images: CaptionImage[] = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]!;
      await page.setContent(captionHtml(cue.text, style));
      const file = join(outDir, `cue-${String(i + 1).padStart(2, '0')}.png`);
      await page.locator('div').screenshot({ path: file, omitBackground: true });
      images.push({ file, startMs: cue.startMs, endMs: cue.endMs });
    }
    return images;
  } finally {
    await browser.close();
  }
}
