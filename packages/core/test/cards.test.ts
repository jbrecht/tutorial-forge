import { describe, expect, it } from 'vitest';
import { cardHtml, computeCardDurationMs, cardContentsFor, type CardContent } from '../src/post/cards.js';

const intro: CardContent = {
  kind: 'intro',
  heading: 'Getting started with Lumen Events',
  lines: ['Create your first event', 'Configure a workspace setting'],
};
const recap: CardContent = { kind: 'recap', heading: '', lines: ['Your event is drafted and your workspace is configured.'] };

describe('cardHtml', () => {
  it('renders the intro heading and objectives as a list', () => {
    const html = cardHtml(intro);
    expect(html).toContain('Getting started with Lumen Events');
    expect(html).toContain('Create your first event');
    expect(html).toContain('<ul');
    expect(html).toContain("In this tutorial you'll learn to"); // kicker
  });

  it('renders the recap kicker and summary paragraph (no list)', () => {
    const html = cardHtml(recap);
    expect(html).toContain('Recap');
    expect(html).toContain('Your event is drafted');
    expect(html).not.toContain('<ul');
  });

  it('escapes HTML in card text', () => {
    const html = cardHtml({ kind: 'intro', heading: 'A & B <x>', lines: ['1 < 2 & "ok"'] });
    expect(html).toContain('A &amp; B &lt;x&gt;');
    expect(html).toContain('1 &lt; 2 &amp; &quot;ok&quot;');
    expect(html).not.toContain('<x>');
  });

  it('omits the heading block when heading is empty', () => {
    expect(cardHtml(recap)).not.toContain('font-size:64px');
  });
});

describe('computeCardDurationMs', () => {
  it('clamps a tiny card up to the 3s floor', () => {
    expect(computeCardDurationMs({ kind: 'recap', heading: '', lines: ['Hi'] })).toBe(3000);
  });

  it('clamps a wordy card down to the 12s ceiling', () => {
    const long = { kind: 'recap' as const, heading: '', lines: ['word '.repeat(200)] };
    expect(computeCardDurationMs(long)).toBe(12_000);
  });

  it('scales with text length between the bounds', () => {
    const short = computeCardDurationMs({ kind: 'intro', heading: 'A'.repeat(80), lines: [] });
    const longer = computeCardDurationMs({ kind: 'intro', heading: 'A'.repeat(160), lines: [] });
    expect(longer).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(3000);
    expect(longer).toBeLessThan(12_000);
  });
});

describe('cardContentsFor', () => {
  it('builds an intro from objectives and a recap from summary', () => {
    const c = cardContentsFor({ title: 'T', objectives: ['Do a thing'], summary: 'Done.' });
    expect(c?.intro).toEqual({ kind: 'intro', heading: 'T', lines: ['Do a thing'] });
    expect(c?.recap).toEqual({ kind: 'recap', heading: '', lines: ['Done.'] });
  });

  it('returns only the intro when there is no summary', () => {
    const c = cardContentsFor({ title: 'T', objectives: ['x'] });
    expect(c?.intro).toBeTruthy();
    expect(c?.recap).toBeUndefined();
  });

  it('returns null when neither objectives nor summary are present', () => {
    expect(cardContentsFor({ title: 'T' })).toBeNull();
    expect(cardContentsFor({ title: 'T', objectives: [], summary: '   ' })).toBeNull();
  });
});
