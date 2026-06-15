import { afterEach, describe, expect, it, vi } from 'vitest';
import { tutorial, step, stepId, slugify } from '../src/spec.js';
import { logger } from '../src/util/logger.js';

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

  it('rejects non-string objectives', () => {
    expect(() =>
      tutorial('x', [step('a', noop)], { objectives: ['ok', 42 as unknown as string] }),
    ).toThrow(/objectives must be an array of strings/);
  });

  it('rejects empty-string objectives', () => {
    expect(() => tutorial('x', [step('a', noop)], { objectives: ['ok', '  '] })).toThrow(
      /objectives must not contain empty strings/,
    );
  });

  it('rejects a non-string summary', () => {
    expect(() =>
      tutorial('x', [step('a', noop)], { summary: 123 as unknown as string }),
    ).toThrow(/summary must be a string/);
  });

  it('accepts valid objectives and summary', () => {
    expect(() =>
      tutorial('x', [step('a', noop)], { objectives: ['Create an event'], summary: 'Done.' }),
    ).not.toThrow();
  });

  it('rejects an invalid settleUntil', () => {
    expect(() =>
      tutorial('x', [step('a', noop, { settleUntil: 'idle' as unknown as 'networkidle' })]),
    ).toThrow(/step 0: settleUntil must be/);
  });

  it('accepts the valid settleUntil values', () => {
    for (const v of ['load', 'domcontentloaded', 'networkidle'] as const) {
      expect(() => tutorial('x', [step('a', noop, { settleUntil: v })])).not.toThrow();
    }
  });
});

describe('narration lints', () => {
  afterEach(() => vi.restoreAllMocks());

  const warns = () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    return spy;
  };
  const longLine = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

  it('warns on over-long narration by default', () => {
    const warn = warns();
    tutorial('x', [step(longLine(61), noop, { id: 'wordy' })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/step 0 \("wordy"\): narration is 61 words \(over 60\)/);
  });

  it('does not warn at or under the threshold', () => {
    const warn = warns();
    tutorial('x', [step(longLine(60), noop)]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('honors a custom maxNarrationWords threshold', () => {
    const warn = warns();
    tutorial('x', [step(longLine(20), noop)], { lint: { maxNarrationWords: 10 } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/20 words \(over 10\)/);
  });

  it('maxNarrationWords: 0 disables only the length lint', () => {
    const warn = warns();
    tutorial('x', [step(longLine(200), noop)], { lint: { maxNarrationWords: 0 } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('lint: false on the tutorial silences every lint', () => {
    const warn = warns();
    tutorial('x', [step(longLine(200), noop)], { lint: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('lint: false on a step silences that step only', () => {
    const warn = warns();
    tutorial('x', [
      step(longLine(200), noop, { id: 'allowed', lint: false }),
      step(longLine(200), noop, { id: 'flagged' }),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/"flagged"/);
  });

  it('never throws — lints are warnings, not errors', () => {
    expect(() => tutorial('x', [step(longLine(500), noop)])).not.toThrow();
  });

  describe('strict mode', () => {
    it('warns when a step bundles 3+ instrumented actions', () => {
      const warn = warns();
      tutorial('x', [
        step('Do a lot.', async (page: any) => {
          await page.getByText('a').click();
          await page.getByLabel('b').fill('x');
          await page.getByRole('checkbox').check();
        }, { id: 'busy' }),
      ], { lint: { strict: true } });
      expect(warn.mock.calls.some((c) => /performs 3 instrumented actions/.test(c[0] as string))).toBe(true);
    });

    it('does not warn on a single nav-then-act pair (2 actions)', () => {
      const warn = warns();
      tutorial('x', [
        step('Open settings.', async (page: any) => {
          await page.getByRole('link', { name: 'Settings' }).click();
          await page.getByRole('heading').waitFor();
          await page.locator('#x').check();
        }, { id: 'two' }),
      ], { lint: { strict: true } });
      // 2 instrumented actions (click + check); waitFor isn't instrumented.
      expect(warn.mock.calls.some((c) => /instrumented actions/.test(c[0] as string))).toBe(false);
    });

    it('is off by default — no action-bundling warning without strict', () => {
      const warn = warns();
      tutorial('x', [
        step('Do a lot.', async (page: any) => {
          await page.a.click();
          await page.b.fill('x');
          await page.c.check();
        }),
      ]);
      expect(warn.mock.calls.some((c) => /instrumented actions/.test(c[0] as string))).toBe(false);
    });

    it('warns when the first step lacks an objective and the last lacks a recap', () => {
      const warn = warns();
      tutorial('x', [step('Click the button.', noop), step('Type a name.', noop)], { lint: { strict: true } });
      const msgs = warn.mock.calls.map((c) => c[0] as string).join('\n');
      expect(msgs).toMatch(/first step's narration doesn't open with an objective/);
      expect(msgs).toMatch(/last step's narration doesn't close with a recap/);
    });

    it('is satisfied by an intro opener and a recap closer', () => {
      const warn = warns();
      tutorial('x', [
        step("In this tour, we'll create an event.", noop),
        step('That is all — you are ready to invite attendees.', noop),
      ], { lint: { strict: true } });
      const msgs = warn.mock.calls.map((c) => c[0] as string).join('\n');
      expect(msgs).not.toMatch(/objective|recap/);
    });
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
