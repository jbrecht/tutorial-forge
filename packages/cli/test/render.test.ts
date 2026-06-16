import { describe, expect, it } from 'vitest';
import { resolveRenderConcurrency, buildRenderJobs } from '../src/render.js';

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

  it('throws on a cross-tutorial id+suffix collision instead of letting jobs share a path (#65)', () => {
    // `setup` rendered in `es` → "setup.es"; `setup.es` rendered source → also "setup.es".
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
