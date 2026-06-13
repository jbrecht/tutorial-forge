import { describe, expect, it } from 'vitest';
import { resolveStepIndex } from '../src/pipeline/preview.js';
import { tutorial, step } from '../src/spec.js';

const noop = async () => {};
const t = tutorial('Demo', [
  step('Open.', noop, { id: 'open' }),
  step('Fill.', noop, { id: 'fill' }),
  step('Submit.', noop), // no id → step-03
]);

describe('resolveStepIndex', () => {
  it('resolves a 1-based index', () => {
    expect(resolveStepIndex(t, '1')).toBe(0);
    expect(resolveStepIndex(t, '3')).toBe(2);
  });

  it('resolves an explicit step id', () => {
    expect(resolveStepIndex(t, 'fill')).toBe(1);
  });

  it('resolves a derived (index-based) id', () => {
    expect(resolveStepIndex(t, 'step-03')).toBe(2);
  });

  it('rejects an out-of-range index with the step count', () => {
    expect(() => resolveStepIndex(t, '4')).toThrow(/out of range.*3 steps/);
    expect(() => resolveStepIndex(t, '0')).toThrow(/out of range/);
  });

  it('rejects an unknown id and lists valid ids', () => {
    expect(() => resolveStepIndex(t, 'nope')).toThrow(/No step with id "nope".*open, fill, step-03/);
  });
});
