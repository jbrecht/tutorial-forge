import { describe, expect, it } from 'vitest';
import { tutorial, step, stepId, slugify } from '../src/spec.js';

const noop = async () => {};

describe('tutorial()', () => {
  it('derives a slug id from the title', () => {
    const t = tutorial('Getting Started: First Event!', [step('hi', noop)]);
    expect(t.id).toBe('getting-started-first-event');
    expect(t.title).toBe('Getting Started: First Event!');
  });

  it('rejects empty steps', () => {
    expect(() => tutorial('x', [])).toThrow(/no steps/);
  });

  it('rejects duplicate step ids with the index in the message', () => {
    expect(() =>
      tutorial('x', [step('a', noop, { id: 'dup' }), step('b', noop, { id: 'dup' })]),
    ).toThrow(/step 1: duplicate step id "dup"/);
  });

  it('rejects a non-function run with the index in the message', () => {
    expect(() =>
      tutorial('x', [{ narration: 'a', run: 'nope' as unknown as typeof noop }]),
    ).toThrow(/step 0: run must be a function/);
  });

  it('rejects bad explicit ids', () => {
    expect(() => tutorial('x', [step('a', noop)], { id: 'Has Spaces' })).toThrow(/lowercase slug/);
  });

  it('rejects a non-function focus with the index in the message', () => {
    expect(() =>
      tutorial('x', [{ narration: 'a', run: noop, focus: 'nope' as unknown as () => never }]),
    ).toThrow(/step 0: focus must be a function/);
  });

  it('accepts a function focus', () => {
    expect(() =>
      tutorial('x', [{ narration: 'a', run: noop, focus: (() => ({})) as unknown as () => never }]),
    ).not.toThrow();
  });

  it('rejects a non-function tutorial setup/teardown', () => {
    expect(() =>
      tutorial('x', [step('a', noop)], { setup: 'nope' as unknown as () => Promise<void> }),
    ).toThrow(/setup must be a function/);
    expect(() =>
      tutorial('x', [step('a', noop)], { teardown: 'nope' as unknown as () => Promise<void> }),
    ).toThrow(/teardown must be a function/);
  });

  it('accepts function tutorial setup/teardown', () => {
    expect(() =>
      tutorial('x', [step('a', noop)], { setup: noop, teardown: noop }),
    ).not.toThrow();
  });
});

describe('stepId', () => {
  it('uses the explicit id when present', () => {
    expect(stepId(step('a', noop, { id: 'open-modal' }), 4)).toBe('open-modal');
  });
  it('derives a padded index otherwise', () => {
    expect(stepId(step('a', noop), 0)).toBe('step-01');
    expect(stepId(step('a', noop), 11)).toBe('step-12');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify("  Émile's   Demo!! ")).toBe('mile-s-demo');
  });
});
