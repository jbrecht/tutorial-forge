import type { TimingManifest } from '../types.js';

export interface IdleSpeedupConfig {
  /** Narration-free spans longer than this get compressed. Default 2000. */
  maxIdleMs: number;
  /** Playback speed inside compressed spans. Default 3. */
  speed: number;
}

export const DEFAULT_IDLE_SPEEDUP: IdleSpeedupConfig = { maxIdleMs: 2000, speed: 3 };

/** Kept at 1x at each end of a compressed span so transitions read gently (s). */
const MARGIN_S = 0.5;
/** Protected window around a callout: ring lead → click + pulse playing out (s). */
const CALLOUT_BEFORE_S = 0.3;
const CALLOUT_AFTER_S = 1.5;
/** Compressed spans shorter than this after margins aren't worth the cut. */
const MIN_COMPRESSED_S = 0.4;

export interface SpeedSegment {
  /** Trimmed-timeline seconds. */
  startS: number;
  endS: number;
  speed: number;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

/**
 * Find the compressible spans of the trimmed timeline: everything is fair
 * game except narration playback (pacing floor — compressing it would desync
 * audio) and a window around each callout (the ring/click choreography
 * shouldn't play at 3x). Spans keep a 1x margin at each end.
 */
export function computeIdleSegments(
  manifest: TimingManifest,
  trimStartMs: number,
  leadInMs: number,
  config: IdleSpeedupConfig,
): SpeedSegment[] {
  const totalS = (manifest.totalDurationMs - trimStartMs) / 1000;
  const rel = (ms: number) => (ms - trimStartMs) / 1000;

  const protectedIvs: Interval[] = [];
  for (const step of manifest.steps) {
    if (step.audioDurationMs > 0) {
      const start = rel(step.startMs + leadInMs);
      protectedIvs.push({ start, end: start + step.audioDurationMs / 1000 });
    }
    for (const c of step.callouts) {
      protectedIvs.push({ start: rel(c.atMs) - CALLOUT_BEFORE_S, end: rel(c.atMs) + CALLOUT_AFTER_S });
    }
  }
  const merged = mergeIntervals(
    protectedIvs
      .map((iv) => ({ start: Math.max(0, iv.start), end: Math.min(totalS, iv.end) }))
      .filter((iv) => iv.end > iv.start),
  );

  const segments: SpeedSegment[] = [];
  let cursor = 0;
  const gaps: Interval[] = [];
  for (const iv of merged) {
    if (iv.start > cursor) gaps.push({ start: cursor, end: iv.start });
    cursor = Math.max(cursor, iv.end);
  }
  if (cursor < totalS) gaps.push({ start: cursor, end: totalS });

  for (const gap of gaps) {
    if ((gap.end - gap.start) * 1000 < config.maxIdleMs) continue;
    const startS = gap.start + MARGIN_S;
    const endS = gap.end - MARGIN_S;
    if (endS - startS < MIN_COMPRESSED_S - 1e-9) continue;
    segments.push({ startS, endS, speed: config.speed });
  }
  return segments;
}

export interface TimeMap {
  /** Map a trimmed-timeline time (s) to the retimed output timeline (s). */
  mapS(t: number): number;
  outputDurationS: number;
  segments: SpeedSegment[];
}

/** Piecewise-linear time map: identity outside compressed segments. */
export function buildTimeMap(segments: SpeedSegment[], totalS: number): TimeMap {
  // Precompute output time at each segment boundary.
  const marks: Array<{ inS: number; outS: number; rate: number }> = [{ inS: 0, outS: 0, rate: 1 }];
  let inPos = 0;
  let outPos = 0;
  for (const seg of segments) {
    outPos += seg.startS - inPos; // 1x stretch before the segment
    marks.push({ inS: seg.startS, outS: outPos, rate: 1 / seg.speed });
    outPos += (seg.endS - seg.startS) / seg.speed;
    marks.push({ inS: seg.endS, outS: outPos, rate: 1 });
    inPos = seg.endS;
  }
  const outputDurationS = outPos + (totalS - inPos);

  const mapS = (t: number): number => {
    let m = marks[0]!;
    for (const mark of marks) {
      if (mark.inS <= t) m = mark;
      else break;
    }
    return m.outS + (t - m.inS) * m.rate;
  };
  return { mapS, outputDurationS, segments };
}

const f3 = (n: number) => n.toFixed(3);

/**
 * setpts expression implementing the time map. T is the input frame time in
 * seconds (after the trim's PTS-STARTPTS reset); output PTS = mapped seconds.
 * Follow with an fps filter to re-normalize to constant frame rate (frames
 * bunch up inside compressed segments and must be dropped).
 */
export function buildRetimeFilter(map: TimeMap): string {
  let expr = 'T'; // identity tail (also covers t past the last segment)
  let outAtEnd = 0;
  // Build innermost-last: walk segments in reverse, wrapping the expression.
  const pieces: Array<{ ltS: number; expr: string }> = [];
  let inPos = 0;
  let outPos = 0;
  for (const seg of map.segments) {
    outPos += seg.startS - inPos;
    pieces.push({ ltS: seg.startS, expr: `${f3(outPos - seg.startS)}+T` }); // 1x: out = T + (outPos - inS)
    const outAtSegStart = outPos;
    outPos += (seg.endS - seg.startS) / seg.speed;
    pieces.push({
      ltS: seg.endS,
      expr: `${f3(outAtSegStart)}+(T-${f3(seg.startS)})/${f3(seg.speed)}`,
    });
    inPos = seg.endS;
    outAtEnd = outPos;
  }
  expr = `${f3(outAtEnd - inPos)}+T`; // after the last segment, 1x with accumulated offset
  for (const piece of [...pieces].reverse()) {
    expr = `if(lt(T,${f3(piece.ltS)}),${piece.expr},${expr})`;
  }
  return `setpts='(${expr})/TB'`;
}
