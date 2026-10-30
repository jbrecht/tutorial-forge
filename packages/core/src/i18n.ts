import type { Tutorial } from './types.js';
import { stepId } from './spec.js';
import { logger } from './util/logger.js';

/**
 * Reserved translation-table keys for tutorial-level card text (they aren't step
 * ids). `__objectives__` is newline-separated (one objective per line);
 * `__summary__` is a single string. See {@link localizeTutorial}.
 */
/** Suffix marking a step's still-caption translation: `"open-modal.alt": "…"`. */
export const ALT_SUFFIX = '.alt';

export const OBJECTIVES_KEY = '__objectives__';
export const SUMMARY_KEY = '__summary__';

/**
 * Return a copy of the tutorial with narration swapped to the given language.
 * Translation tables are keyed by step id — give steps explicit ids so tables
 * stay stable when steps are reordered.
 *
 * - lang === defaultLang → the spec's own narration, unchanged.
 * - Missing entries fall back to the source narration with a warning.
 * - A language with no table at all throws: rendering a wholly untranslated
 *   tutorial under a language suffix would silently produce a mislabeled video.
 */
export function localizeTutorial<S = unknown>(tutorial: Tutorial<S>, lang: string, defaultLang = 'en'): Tutorial<S> {
  if (lang === defaultLang) return tutorial;

  const table = tutorial.translations?.[lang];
  if (!table) {
    const available = Object.keys(tutorial.translations ?? {});
    throw new Error(
      `Tutorial "${tutorial.id}" has no translations for "${lang}"` +
        (available.length ? ` (available: ${available.join(', ')})` : '') +
        ` — add a <tutorial-file>.${lang}.json sidecar or a translations entry`,
    );
  }

  const knownIds = new Set(tutorial.steps.map((s, i) => stepId(s, i)));
  const reserved = new Set([OBJECTIVES_KEY, SUMMARY_KEY]);
  // "<step-id>.alt" translates a step's still caption (#71 §4) — narration is
  // spoken, alt is read, and a localized stills directory carrying English
  // captions would quietly break the "stays in sync with the script" promise.
  const unknown = Object.keys(table).filter(
    (k) => !knownIds.has(k) && !reserved.has(k) && !(k.endsWith(ALT_SUFFIX) && knownIds.has(k.slice(0, -ALT_SUFFIX.length))),
  );
  if (unknown.length) {
    logger.warn(
      `Tutorial "${tutorial.id}" [${lang}]: translation keys match no step: ${unknown.join(', ')}`,
    );
  }

  const missing: string[] = [];
  const steps = tutorial.steps.map((step, i) => {
    const id = stepId(step, i);
    const translated = table[id];
    const translatedAlt = table[`${id}${ALT_SUFFIX}`];
    const withAlt = translatedAlt !== undefined ? { alt: translatedAlt } : {};
    if (translated === undefined) {
      if (step.narration.trim()) missing.push(id);
      return { ...step, ...withAlt };
    }
    return { ...step, narration: translated, ...withAlt };
  });
  if (missing.length) {
    logger.warn(
      `Tutorial "${tutorial.id}" [${lang}]: no translation for step(s) ${missing.join(', ')} — using source narration`,
    );
  }

  // Card text (objectives/summary) is localized via reserved keys, falling back
  // to the source strings when a table omits them.
  const localized: Tutorial<S> = { ...tutorial, steps };
  const objectivesTr = table[OBJECTIVES_KEY];
  if (objectivesTr !== undefined) {
    localized.objectives = objectivesTr.split('\n').map((l) => l.trim()).filter(Boolean);
  } else if (tutorial.objectives?.length) {
    logger.warn(`Tutorial "${tutorial.id}" [${lang}]: no ${OBJECTIVES_KEY} translation — using source objectives`);
  }
  const summaryTr = table[SUMMARY_KEY];
  if (summaryTr !== undefined) {
    localized.summary = summaryTr;
  } else if (tutorial.summary?.trim()) {
    logger.warn(`Tutorial "${tutorial.id}" [${lang}]: no ${SUMMARY_KEY} translation — using source summary`);
  }

  return localized;
}

/** Languages a tutorial can render in: the default language plus every translation table. */
export function availableLanguages(tutorial: Pick<Tutorial, 'translations'>, defaultLang = 'en'): string[] {
  return [defaultLang, ...Object.keys(tutorial.translations ?? {}).filter((l) => l !== defaultLang)];
}
