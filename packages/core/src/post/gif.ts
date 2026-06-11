import type { TimingManifest } from '../types.js';
import { stepIndexById } from './gif-util.js';

export interface GifConfig {
  /** GIF width; height keeps aspect. Default 720. */
  widthPx: number;
  /** Default 10. */
  fps: number;
  /** Burn narration captions into the GIF (it has no audio). Default true. */
  captions: boolean;
  /** Step range to excerpt: "step-id" or "from-id..to-id". Whole video if omitted. */
  steps?: string;
}

export const DEFAULT_GIF: Omit<GifConfig, 'steps'> = { widthPx: 720, fps: 10, captions: true };

export interface GifWindow {
  /** Output-timeline ms. */
  startMs: number;
  endMs: number;
}

/**
 * Resolve a step range ("a..b" or "a") to a window on the final output
 * timeline (post trim and retime). Throws on unknown step ids.
 */
export function resolveGifWindow(
  manifest: TimingManifest,
  trimStartMs: number,
  range: string,
  mapMs: (ms: number) => number = (ms) => ms,
): GifWindow {
  const [fromId, toId = fromId] = range.split('..').map((s) => s.trim());
  const from = stepIndexById(manifest, fromId!);
  const to = stepIndexById(manifest, toId!);
  if (to < from) throw new Error(`--gif-steps range "${range}" runs backwards`);
  return {
    startMs: Math.max(0, mapMs(manifest.steps[from]!.startMs - trimStartMs)),
    endMs: mapMs(manifest.steps[to]!.endMs - trimStartMs),
  };
}

export interface GifArgsInput {
  /** The final rendered MP4. */
  source: string;
  output: string;
  widthPx: number;
  fps: number;
  /** Excerpt window (output-timeline ms); whole video if omitted. */
  window?: GifWindow;
  /** Caption overlays (output-timeline ms, same space as window). */
  captions?: {
    items: Array<{ file: string; startMs: number; endMs: number }>;
    bottomMarginPx: number;
  };
}

/**
 * Single-invocation GIF encode: caption overlays at full resolution, then
 * fps-downsample, downscale, and two-pass palette (palettegen/paletteuse via
 * split). The window trim is applied as output options so filter `enable`
 * times stay on the source timeline. Pure function: tested on the args.
 */
export function buildGifArgs(input: GifArgsInput): string[] {
  const args: string[] = ['-y', '-i', input.source];
  const chain: string[] = [];

  const captionItems = input.captions?.items ?? [];
  let label = '[0:v]';
  const filters: string[] = [];
  captionItems.forEach((c, k) => {
    args.push('-i', c.file);
    const out = `[gc${k}]`;
    filters.push(
      `${label}[${k + 1}:v]overlay=(W-w)/2:H-h-${input.captions!.bottomMarginPx}:enable='between(t,${(c.startMs / 1000).toFixed(3)},${(c.endMs / 1000).toFixed(3)})'${out}`,
    );
    label = out;
  });

  chain.push(
    `fps=${input.fps}`,
    `scale=${input.widthPx}:-1:flags=lanczos`,
    'split[ga][gb]',
  );
  filters.push(`${label}${chain.join(',')}`);
  filters.push('[ga]palettegen=stats_mode=diff[gp]');
  filters.push('[gb][gp]paletteuse=dither=bayer:bayer_scale=4[gout]');

  args.push('-filter_complex', filters.join(';'), '-map', '[gout]');
  if (input.window) {
    args.push('-ss', (input.window.startMs / 1000).toFixed(3));
    args.push('-t', ((input.window.endMs - input.window.startMs) / 1000).toFixed(3));
  }
  args.push(input.output);
  return args;
}
