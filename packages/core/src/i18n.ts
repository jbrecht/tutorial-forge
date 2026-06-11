import type { Tutorial } from './types.js';
import { stepId } from './spec.js';
import { logger } from './util/logger.js';

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
export function localizeTutorial(tutorial: Tutorial, lang: string, defaultLang = 'en'): Tutorial {
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
  const unknown = Object.keys(table).filter((k) => !knownIds.has(k));
  if (unknown.length) {
    logger.warn(
      `Tutorial "${tutorial.id}" [${lang}]: translation keys match no step: ${unknown.join(', ')}`,
    );
  }

  const missing: string[] = [];
  const steps = tutorial.steps.map((step, i) => {
    const id = stepId(step, i);
    const translated = table[id];
    if (translated === undefined) {
      if (step.narration.trim()) missing.push(id);
      return step;
    }
    return { ...step, narration: translated };
  });
  if (missing.length) {
    logger.warn(
      `Tutorial "${tutorial.id}" [${lang}]: no translation for step(s) ${missing.join(', ')} — using source narration`,
    );
  }

  return { ...tutorial, steps };
}

/** Languages a tutorial can render in: the default language plus every translation table. */
export function availableLanguages(tutorial: Tutorial, defaultLang = 'en'): string[] {
  return [defaultLang, ...Object.keys(tutorial.translations ?? {}).filter((l) => l !== defaultLang)];
}
