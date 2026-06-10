/** Recording clock: all manifest offsets are ms since zero(). */
export class RecordingClock {
  private zeroEpochMs = 0;

  zero(): void {
    this.zeroEpochMs = Date.now();
  }

  get zeroEpoch(): number {
    return this.zeroEpochMs;
  }

  /** ms since zero() */
  now(): number {
    if (this.zeroEpochMs === 0) throw new Error('RecordingClock used before zero()');
    return Date.now() - this.zeroEpochMs;
  }
}

/**
 * Step pacing: the step holds until both the narration budget
 * (leadIn + audio) and the action have completed, then settles.
 * Pure function so the math is unit-testable.
 */
export function stepHoldUntilMs(input: {
  startMs: number;
  leadInMs: number;
  audioDurationMs: number;
  actionEndMs: number;
  settleMs: number;
}): number {
  const narrationBudgetEnd = input.startMs + input.leadInMs + input.audioDurationMs;
  return Math.max(narrationBudgetEnd, input.actionEndMs) + input.settleMs;
}
