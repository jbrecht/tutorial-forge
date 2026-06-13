import type { Step, Tutorial } from './types.js';
import { logger } from './util/logger.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// SSML tags or ASCII control chars in narration usually mean copy-paste from
// another TTS system; providers read them literally, so warn at load time.
const SUSPICIOUS_NARRATION_RE = /<[a-z][^>]*>|[\x00-\x08\x0b\x0c\x0e-\x1f]/i;

export function step(narration: string, run: Step['run'], opts?: Partial<Step>): Step {
  return { narration, run, ...opts };
}

export function tutorial(idOrTitle: string, steps: Step[], meta?: Partial<Tutorial>): Tutorial {
  const id = meta?.id ?? slugify(idOrTitle);
  const title = meta?.title ?? idOrTitle;
  const t: Tutorial = { ...meta, id, title, steps };
  validateTutorial(t);
  return t;
}

export function validateTutorial(t: Tutorial): void {
  if (!t.id || !SLUG_RE.test(t.id)) {
    throw new Error(`Tutorial id "${t.id}" must be a lowercase slug (a-z, 0-9, hyphens)`);
  }
  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    throw new Error(`Tutorial "${t.id}" has no steps`);
  }
  for (const hook of ['setup', 'teardown'] as const) {
    if (t[hook] != null && typeof t[hook] !== 'function') {
      throw new Error(`Tutorial "${t.id}": ${hook} must be a function`);
    }
  }
  const seen = new Set<string>();
  t.steps.forEach((s, i) => {
    if (typeof s.narration !== 'string') {
      throw new Error(`Tutorial "${t.id}" step ${i}: narration must be a string`);
    }
    if (typeof s.run !== 'function') {
      throw new Error(`Tutorial "${t.id}" step ${i}: run must be a function`);
    }
    if (s.focus != null && typeof s.focus !== 'function') {
      throw new Error(`Tutorial "${t.id}" step ${i}: focus must be a function returning a locator`);
    }
    if (s.settleUntil != null && !['load', 'domcontentloaded', 'networkidle'].includes(s.settleUntil)) {
      throw new Error(
        `Tutorial "${t.id}" step ${i}: settleUntil must be 'load', 'domcontentloaded', or 'networkidle'`,
      );
    }
    const id = stepId(s, i);
    if (seen.has(id)) {
      throw new Error(`Tutorial "${t.id}" step ${i}: duplicate step id "${id}"`);
    }
    seen.add(id);
    if (SUSPICIOUS_NARRATION_RE.test(s.narration)) {
      logger.warn(
        `Tutorial "${t.id}" step ${i} ("${id}"): narration contains markup or control characters; TTS providers will read these literally`,
      );
    }
  });
}

/** Resolve a step's stable id: explicit id, or its zero-padded index. */
export function stepId(s: Step, index: number): string {
  return s.id ?? `step-${String(index + 1).padStart(2, '0')}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
