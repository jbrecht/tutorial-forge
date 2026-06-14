import type { LintOptions, Step, Tutorial } from './types.js';
import { logger } from './util/logger.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// SSML tags or ASCII control chars in narration usually mean copy-paste from
// another TTS system; providers read them literally, so warn at load time.
const SUSPICIOUS_NARRATION_RE = /<[a-z][^>]*>|[\x00-\x08\x0b\x0c\x0e-\x1f]/i;

// At ~150 words/min of speech, 60 words is ~24s on a single step — well past
// the one-idea-per-step segmenting sweet spot. Tunable via LintOptions.
const DEFAULT_MAX_NARRATION_WORDS = 60;
// Playwright calls the pipeline instruments (animates the cursor / records a
// callout for). Three or more in one step usually means it bundles unrelated
// actions that each deserve their own segment. Best-effort: matched against the
// run() source, so exotic call paths can slip through — a low-confidence lint.
const INSTRUMENTED_ACTION_RE = /\.(click|dblclick|hover|fill|check|uncheck|selectOption|setInputFiles|press|type|tap)\s*\(/g;
// Loose cues that a line opens with an objective / closes with a recap. Used
// only for the heuristic strict-mode framing lints, so false matches are cheap.
const INTRO_CUE_RE = /\b(in this|we['’]ll|we will|you['’]ll|you will|let['’]s|let us|this (?:tour|guide|tutorial|walkthrough|video)|by the end)\b/i;
const RECAP_CUE_RE = /\b(that['’]s all|that is all|you['’]re (?:ready|done|all set)|you are (?:ready|done|all set)|in summary|to recap|to sum up|now you (?:can|know)|you['’]ve (?:now|just)|you have (?:now|just))\b/i;

export function step<S = unknown>(narration: string, run: Step<S>['run'], opts?: Partial<Step<S>>): Step<S> {
  return { narration, run, ...opts };
}

export function tutorial<S = unknown>(idOrTitle: string, steps: Step<S>[], meta?: Partial<Tutorial<S>>): Tutorial<S> {
  const id = meta?.id ?? slugify(idOrTitle);
  const title = meta?.title ?? idOrTitle;
  const t: Tutorial<S> = { ...meta, id, title, steps };
  validateTutorial(t);
  return t;
}

export function validateTutorial<S = unknown>(t: Tutorial<S>): void {
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
  if (t.lint !== false) lintTutorial(t, t.lint ?? {});
}

/**
 * Advisory pedagogy lints: warn (never throw) about narration that demonstrates
 * without teaching. Default-on lints are objective and high-signal; the noisier
 * heuristics are gated behind {@link LintOptions.strict}. Authors silence a
 * single intentional step with `step(..., { lint: false })` and turn the whole
 * pass off with `tutorial(..., { lint: false })`.
 */
function lintTutorial<S>(t: Tutorial<S>, cfg: LintOptions): void {
  const maxWords = cfg.maxNarrationWords ?? DEFAULT_MAX_NARRATION_WORDS;
  const linted = t.steps.filter((s) => s.lint !== false);

  t.steps.forEach((s, i) => {
    if (s.lint === false) return;
    const id = stepId(s, i);
    if (maxWords > 0) {
      const words = wordCount(s.narration);
      if (words > maxWords) {
        logger.warn(
          `Tutorial "${t.id}" step ${i} ("${id}"): narration is ${words} words (over ${maxWords}); ` +
            `split it so each step carries one idea (segmenting). Suppress with step({ lint: false }).`,
        );
      }
    }
    if (cfg.strict) {
      const actions = (s.run.toString().match(INSTRUMENTED_ACTION_RE) ?? []).length;
      if (actions > 2) {
        logger.warn(
          `Tutorial "${t.id}" step ${i} ("${id}"): step performs ${actions} instrumented actions; ` +
            `consider one action per step so learners absorb each before the next (segmenting).`,
        );
      }
    }
  });

  if (cfg.strict && linted.length > 0) {
    if (!INTRO_CUE_RE.test(linted[0]!.narration)) {
      logger.warn(
        `Tutorial "${t.id}": the first step's narration doesn't open with an objective; ` +
          `tell learners what they'll accomplish (advance-organizer).`,
      );
    }
    if (!RECAP_CUE_RE.test(linted[linted.length - 1]!.narration)) {
      logger.warn(
        `Tutorial "${t.id}": the last step's narration doesn't close with a recap; ` +
          `summarize what they accomplished (summary principle).`,
      );
    }
  }
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Resolve a step's stable id: explicit id, or its zero-padded index. */
export function stepId(s: Pick<Step, 'id'>, index: number): string {
  return s.id ?? `step-${String(index + 1).padStart(2, '0')}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
