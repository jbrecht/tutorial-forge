import { describe, expect, it } from 'vitest';
import { stepHoldUntilMs } from '../src/browser/timing.js';

describe('stepHoldUntilMs', () => {
  it('holds for the narration budget when the action is fast', () => {
    expect(
      stepHoldUntilMs({ startMs: 1000, leadInMs: 300, audioDurationMs: 4000, actionEndMs: 1800, settleMs: 400 }),
    ).toBe(1000 + 300 + 4000 + 400);
  });

  it('holds for the action when it outlasts the narration', () => {
    expect(
      stepHoldUntilMs({ startMs: 1000, leadInMs: 300, audioDurationMs: 500, actionEndMs: 9000, settleMs: 400 }),
    ).toBe(9000 + 400);
  });

  it('handles silent steps (zero audio)', () => {
    expect(
      stepHoldUntilMs({ startMs: 0, leadInMs: 300, audioDurationMs: 0, actionEndMs: 350, settleMs: 400 }),
    ).toBe(350 + 400);
  });
});
