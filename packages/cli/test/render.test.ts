import { describe, expect, it } from 'vitest';
import { resolveRenderConcurrency, buildRenderJobs, resolveStillsOption } from '../src/render.js';

describe('resolveRenderConcurrency (#62)', () => {
  it('defaults to 1 when neither flag nor config is set (serial — unchanged behavior)', () => {
    expect(resolveRenderConcurrency(undefined, undefined)).toBe(1);
  });

  it('uses the config value when there is no flag', () => {
    expect(resolveRenderConcurrency(undefined, 4)).toBe(4);
  });

  it('lets the flag win over config', () => {
    expect(resolveRenderConcurrency('2', 8)).toBe(2);
  });

  it('clamps non-positive / non-numeric flags to 1 (safe serial)', () => {
    for (const bad of ['0', '-3', 'abc', '']) {
      expect(resolveRenderConcurrency(bad, 8)).toBe(1);
    }
  });

  it('floors a fractional flag', () => {
    expect(resolveRenderConcurrency('3.9', undefined)).toBe(3);
  });
});

describe('buildRenderJobs (#62)', () => {
  const discovered = [{ tutorial: { id: 'a' } }, { tutorial: { id: 'b' } }];

  it('flattens tutorial × language in tutorial-major order', () => {
    expect(buildRenderJobs(discovered, [null]).map((j) => [j.tutorial.id, j.lang])).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(buildRenderJobs(discovered, ['es', 'fr']).map((j) => [j.tutorial.id, j.lang])).toEqual([
      ['a', 'es'],
      ['a', 'fr'],
      ['b', 'es'],
      ['b', 'fr'],
    ]);
  });

  it('de-duplicates languages so two jobs cannot collide on a work dir', () => {
    expect(buildRenderJobs([{ tutorial: { id: 'a' } }], ['es', 'es', 'fr', 'es']).map((j) => j.lang)).toEqual([
      'es',
      'fr',
    ]);
  });

  it('produces exactly one job for a single tutorial rendered in the source language', () => {
    expect(buildRenderJobs([{ tutorial: { id: 'a' } }], [null])).toHaveLength(1);
  });

  it('backstop: throws if two jobs would resolve to the same path (#65)', () => {
    // `setup` rendered in `es` → "setup.es"; `setup.es` rendered source → also "setup.es".
    // Note: a dotted id can't reach here via the CLI (validateTutorial/SLUG_RE
    // forbids it — see spec.test.ts); these literals bypass that to exercise the
    // backstop directly.
    expect(() =>
      buildRenderJobs([{ tutorial: { id: 'setup' } }, { tutorial: { id: 'setup.es' } }], [null, 'es']),
    ).toThrow(/collision.*setup\.es/i);
  });

  it('does not flag legitimately distinct id+suffix combinations', () => {
    expect(() =>
      buildRenderJobs([{ tutorial: { id: 'setup' } }, { tutorial: { id: 'teardown' } }], ['es', 'fr']),
    ).not.toThrow();
  });
});

describe('resolveStillsOption (#71)', () => {
  it('passes config through untouched when neither flag is given', () => {
    expect(resolveStillsOption({}, undefined)).toBeUndefined();
    expect(resolveStillsOption({}, true)).toBe(true);
    expect(resolveStillsOption({}, { steps: 'a..b' })).toEqual({ steps: 'a..b' });
  });

  it('enables stills from the bare flag with no config', () => {
    expect(resolveStillsOption({ stills: true }, undefined)).toEqual({});
  });

  it('keeps other config keys when the flag turns stills on', () => {
    expect(resolveStillsOption({ stills: true }, { markdown: false })).toEqual({ markdown: false });
  });

  it('lets --stills-steps imply --stills and override config.steps', () => {
    expect(resolveStillsOption({ stillsSteps: 'save' }, undefined)).toEqual({ steps: 'save' });
    expect(resolveStillsOption({ stillsSteps: 'save' }, { steps: 'open', markdown: false })).toEqual({
      steps: 'save',
      markdown: false,
    });
  });

  it('does not inherit steps from a boolean config', () => {
    expect(resolveStillsOption({ stillsSteps: 'save' }, true)).toEqual({ steps: 'save' });
  });
});

describe('resolveStillsOption — capture and crop flags (#71)', () => {
  it('maps --stills-capture onto the config', () => {
    expect(resolveStillsOption({ stillsCapture: 'after' }, undefined)).toEqual({ capture: 'after' });
    expect(resolveStillsOption({ stillsCapture: 'both' }, { markdown: false })).toEqual({
      capture: 'both',
      markdown: false,
    });
  });

  it('rejects an unknown capture value', () => {
    expect(() => resolveStillsOption({ stillsCapture: 'sideways' }, undefined)).toThrow(
      /Invalid --stills-capture "sideways"/,
    );
  });

  it('turns --stills-crop into crop: target, and implies --stills', () => {
    expect(resolveStillsOption({ stillsCrop: true }, undefined)).toEqual({ crop: 'target' });
  });

  it('combines flags and still lets config supply the rest', () => {
    expect(
      resolveStillsOption({ stillsSteps: 'save', stillsCapture: 'both', stillsCrop: true }, { filenames: 'indexed' }),
    ).toEqual({ steps: 'save', capture: 'both', crop: 'target', filenames: 'indexed' });
  });
});
