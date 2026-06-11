import type { CalloutRecord } from '../types.js';
import { logger } from '../util/logger.js';

export interface ZoomConfig {
  /** Zoom factor at full zoom-in. Default 1.35. */
  factor: number;
}

export const DEFAULT_ZOOM_FACTOR = 1.35;

/** Ramp duration for zoom in/out (seconds). */
const RAMP_S = 0.5;
/** Zoom-in begins this long before the callout ring appears (s). */
const LEAD_S = 0.3;
/**
 * Hold past the ring appearance: ring plays ~850ms before the click fires,
 * then the click's consequences (modal, navigation) render. 1.4s keeps the
 * zoom through the click and the first beat of what it reveals.
 */
const HOLD_AFTER_CALLOUT_S = 1.4;

export interface ZoomWindow {
  /** Seconds (relative to trimmed video) when zoom-in starts. */
  startS: number;
  /** Seconds when zoom-out starts (end of hold). */
  endS: number;
  rampS: number;
  /** Zoom target center, px in recorded-video coordinates. */
  cx: number;
  cy: number;
}

/**
 * Turn manifest callouts into non-overlapping zoom windows on the trimmed
 * video's timeline. Overlapping windows are dropped (clicks in quick
 * succession read better without zoom ping-pong).
 */
export function computeZoomWindows(
  callouts: CalloutRecord[],
  trimStartMs: number,
  totalDurationMs: number,
): ZoomWindow[] {
  const durationS = (totalDurationMs - trimStartMs) / 1000;
  const sorted = [...callouts].sort((a, b) => a.atMs - b.atMs);
  const windows: ZoomWindow[] = [];
  for (const c of sorted) {
    const atS = (c.atMs - trimStartMs) / 1000;
    const startS = Math.max(0, atS - LEAD_S);
    const endS = Math.min(durationS - RAMP_S, atS + HOLD_AFTER_CALLOUT_S);
    if (endS <= startS + RAMP_S) continue; // too close to the edges to play out
    const prev = windows[windows.length - 1];
    if (prev && startS < prev.endS + prev.rampS) {
      logger.debug(`zoom: dropping overlapping window at ${atS.toFixed(1)}s`);
      continue;
    }
    windows.push({ startS, endS, rampS: RAMP_S, cx: c.x + c.w / 2, cy: c.y + c.h / 2 });
  }
  return windows;
}

/** smoothstep easing as an ffmpeg expression of the (string) sub-expression u. */
function smooth(u: string): string {
  return `(${u})*(${u})*(3-2*(${u}))`;
}

const f3 = (n: number) => n.toFixed(3);

/**
 * Piecewise envelope: 0 outside windows, smoothstep up over rampS, 1 during
 * hold, smoothstep down over rampS. Windows are disjoint by construction so
 * a chained if() is safe.
 */
function envelopeExpr(windows: ZoomWindow[]): string {
  let expr = '0';
  for (const w of [...windows].reverse()) {
    const s = f3(w.startS);
    const sr = f3(w.startS + w.rampS);
    const e = f3(w.endS);
    const er = f3(w.endS + w.rampS);
    const up = smooth(`(it-${s})/${f3(w.rampS)}`);
    const down = smooth(`1-(it-${e})/${f3(w.rampS)}`);
    expr = `if(between(it,${s},${sr}),${up},if(between(it,${sr},${e}),1,if(between(it,${e},${er}),${down},${expr})))`;
  }
  return expr;
}

/** Piecewise zoom-target coordinate (cx or cy per active window; center otherwise). */
function centerExpr(windows: ZoomWindow[], axis: 'cx' | 'cy', fallback: string): string {
  let expr = fallback;
  for (const w of [...windows].reverse()) {
    const s = f3(w.startS);
    const er = f3(w.endS + w.rampS);
    expr = `if(between(it,${s},${er}),${f3(w[axis])},${expr})`;
  }
  return expr;
}

/**
 * Build the `fps`-normalize + `zoompan` filter stage implementing the zoom.
 * Returns null when there is nothing to zoom to. The stage is inserted into
 * the merge filter graph between setpts and scale.
 *
 * zoompan evaluates z/x/y per input frame (d=1); `it` is the input timestamp.
 * x/y position the crop's top-left in input pixels, clamped to the frame.
 */
export function buildZoomFilter(
  windows: ZoomWindow[],
  factor: number,
  width: number,
  height: number,
  fps: number,
): string | null {
  if (windows.length === 0) return null;
  const z = `1+${f3(factor - 1)}*(${envelopeExpr(windows)})`;
  const cx = centerExpr(windows, 'cx', `iw/2`);
  const cy = centerExpr(windows, 'cy', `ih/2`);
  const x = `clip((${cx})-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip((${cy})-ih/zoom/2,0,ih-ih/zoom)`;
  return `fps=${fps},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}
