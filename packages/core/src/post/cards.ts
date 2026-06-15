import { join } from 'node:path';
import { chromium } from 'playwright';
import { ensureDir } from '../util/fs.js';

/**
 * Intro/recap cards (#37): full-frame title/objective and summary slates
 * composited before the first step and after the last. They make the
 * advance-organizer and summary the example tutorials already model in
 * narration explicit and reusable. Rendered the same way as burned captions —
 * browser HTML → PNG → ffmpeg — so no new renderer, and styled with plain CSS.
 *
 * Visual only by design (the issue's recommendation): authors who want the
 * objectives *spoken* put them in step-1 narration as they do today, avoiding a
 * forced redundancy between the card and the voice-over.
 */

export interface CardContent {
  kind: 'intro' | 'recap';
  /** Large heading (the tutorial title on the intro card). May be empty. */
  heading: string;
  /** Objective bullets (intro) or the summary paragraph as a single line (recap). */
  lines: string[];
}

export interface RenderedCard {
  kind: 'intro' | 'recap';
  /** Opaque PNG, viewport-sized. */
  file: string;
  /** How long to hold the card on screen, derived from its text. */
  durationMs: number;
}

const KICKERS: Record<CardContent['kind'], string> = {
  intro: "In this tutorial you'll learn to",
  recap: 'Recap',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The card document; pure so layout/styling is unit-testable. */
export function cardHtml(card: CardContent): string {
  const kicker = `<div style="font-size:28px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8b93a7;margin-bottom:24px">${escapeHtml(KICKERS[card.kind])}</div>`;
  const heading = card.heading.trim()
    ? `<div style="font-size:64px;font-weight:700;line-height:1.15;margin-bottom:${card.lines.length ? '40px' : '0'}">${escapeHtml(card.heading)}</div>`
    : '';
  let bodyHtml = '';
  if (card.kind === 'intro') {
    const items = card.lines
      .map(
        (l) =>
          `<li style="display:flex;align-items:flex-start;gap:18px;margin:0 0 22px">` +
          `<span style="color:#5b8cff;flex:none;line-height:1.3">✓</span><span>${escapeHtml(l)}</span></li>`,
      )
      .join('');
    bodyHtml = items
      ? `<ul style="list-style:none;padding:0;margin:0;font-size:40px;line-height:1.3;text-align:left;max-width:1200px">${items}</ul>`
      : '';
  } else {
    bodyHtml = card.lines
      .map(
        (l) =>
          `<div style="font-size:48px;line-height:1.35;max-width:1300px">${escapeHtml(l)}</div>`,
      )
      .join('');
  }
  return `
    <body style="margin:0;height:100%;background:#0c0e14;color:#f4f6fb;
                 font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <div style="box-sizing:border-box;height:100%;display:flex;flex-direction:column;
                  justify-content:center;align-items:center;text-align:center;padding:120px">
        ${kicker}${heading}${bodyHtml}
      </div>
    </body>`;
}

/**
 * Readable hold for a card: enough time to read its text comfortably (a 1.5s
 * base plus ~35 ms per character at a relaxed pace), clamped to a sane [3s, 12s]
 * range so a one-word card still lingers and a wordy one doesn't stall the video.
 */
export function computeCardDurationMs(card: CardContent): number {
  const chars = [card.heading, ...card.lines].join(' ').trim().length;
  return Math.min(12_000, Math.max(3000, Math.round(1500 + chars * 35)));
}

/** Render each card to an opaque, viewport-sized PNG. One browser for all cards. */
export async function renderCards(
  cards: CardContent[],
  outDir: string,
  viewport: { width: number; height: number },
): Promise<RenderedCard[]> {
  if (cards.length === 0) return [];
  await ensureDir(outDir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const rendered: RenderedCard[] = [];
    for (const card of cards) {
      await page.setContent(cardHtml(card));
      const file = join(outDir, `card-${card.kind}.png`);
      await page.screenshot({ path: file });
      rendered.push({ kind: card.kind, file, durationMs: computeCardDurationMs(card) });
    }
    return rendered;
  } finally {
    await browser.close();
  }
}

/** Build the intro/recap card content for a tutorial, or null when it declares neither. */
export function cardContentsFor(input: {
  title: string;
  objectives?: string[];
  summary?: string;
}): { intro?: CardContent; recap?: CardContent } | null {
  const intro: CardContent | undefined = input.objectives?.length
    ? { kind: 'intro', heading: input.title, lines: input.objectives }
    : undefined;
  const recap: CardContent | undefined = input.summary?.trim()
    ? { kind: 'recap', heading: '', lines: [input.summary.trim()] }
    : undefined;
  if (!intro && !recap) return null;
  return { intro, recap };
}
