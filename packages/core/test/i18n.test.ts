import { describe, expect, it, vi } from 'vitest';
import { localizeTutorial, availableLanguages } from '../src/i18n.js';
import { tutorial, step } from '../src/spec.js';
import { logger } from '../src/util/logger.js';

const noop = async () => {};

function fixture() {
  return tutorial(
    'demo',
    [
      step('Welcome to the app.', noop, { id: 'welcome' }),
      step('', noop, { id: 'silent' }),
      step('Click the button.', noop, { id: 'click' }),
    ],
    {
      id: 'demo',
      translations: {
        es: { welcome: 'Bienvenido a la aplicación.', click: 'Haz clic en el botón.' },
        fr: { welcome: 'Bienvenue dans l’application.' }, // click intentionally missing
      },
    },
  );
}

describe('localizeTutorial', () => {
  it('swaps narration by step id', () => {
    const es = localizeTutorial(fixture(), 'es');
    expect(es.steps.map((s) => s.narration)).toEqual([
      'Bienvenido a la aplicación.',
      '',
      'Haz clic en el botón.',
    ]);
  });

  it('returns the tutorial unchanged for the default language', () => {
    const t = fixture();
    expect(localizeTutorial(t, 'en')).toBe(t);
    const original = tutorial('x', [step('hallo', noop)], { id: 'x' });
    expect(localizeTutorial(original, 'de', 'de')).toBe(original);
  });

  it('falls back to source narration for untranslated steps', () => {
    const fr = localizeTutorial(fixture(), 'fr');
    expect(fr.steps[0]!.narration).toBe('Bienvenue dans l’application.');
    expect(fr.steps[2]!.narration).toBe('Click the button.');
  });

  it('does not mutate the source tutorial', () => {
    const t = fixture();
    localizeTutorial(t, 'es');
    expect(t.steps[0]!.narration).toBe('Welcome to the app.');
  });

  it('throws for a language with no table', () => {
    expect(() => localizeTutorial(fixture(), 'ja')).toThrow(/no translations for "ja".*available: es, fr/);
  });

  it('keeps run/waitFor/settle untouched', () => {
    const t = fixture();
    const es = localizeTutorial(t, 'es');
    expect(es.steps[0]!.run).toBe(t.steps[0]!.run);
  });

  it('localizes card objectives/summary via reserved keys without flagging them as unknown steps', () => {
    const warns: string[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((m) => void warns.push(m));
    try {
      const t = tutorial('cards', [step('Hi.', noop, { id: 'only' })], {
        id: 'cards',
        objectives: ['Do A', 'Do B'],
        summary: 'You did it.',
        translations: {
          es: {
            only: 'Hola.',
            __objectives__: 'Hacer A\nHacer B',
            __summary__: 'Lo lograste.',
          },
        },
      });
      const es = localizeTutorial(t, 'es');
      expect(es.objectives).toEqual(['Hacer A', 'Hacer B']);
      expect(es.summary).toBe('Lo lograste.');
      expect(warns.some((w) => /match no step/.test(w))).toBe(false); // reserved keys excluded
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to source card text and warns when reserved keys are missing', () => {
    const warns: string[] = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((m) => void warns.push(m));
    try {
      const t = tutorial('cards', [step('Hi.', noop, { id: 'only' })], {
        id: 'cards',
        objectives: ['Do A'],
        summary: 'You did it.',
        translations: { es: { only: 'Hola.' } },
      });
      const es = localizeTutorial(t, 'es');
      expect(es.objectives).toEqual(['Do A']); // source fallback
      expect(es.summary).toBe('You did it.');
      expect(warns.some((w) => /no __objectives__ translation/.test(w))).toBe(true);
      expect(warns.some((w) => /no __summary__ translation/.test(w))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('availableLanguages', () => {
  it('lists default plus translated languages', () => {
    expect(availableLanguages(fixture())).toEqual(['en', 'es', 'fr']);
  });
  it('handles tutorials without translations', () => {
    expect(availableLanguages(tutorial('x', [step('a', noop)], { id: 'x' }))).toEqual(['en']);
  });
});
