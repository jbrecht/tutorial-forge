import type { Locator, Page } from 'playwright';
import type { CalloutRecord } from '../types.js';
import { CURSOR_TRAVEL_MS } from './cursor.js';
import { CALLOUT_VISIBLE_MS } from './callout.js';
import { logger } from '../util/logger.js';

export interface InstrumentHooks {
  cursor: boolean;
  callouts: boolean;
  /** Recording-clock time, for callout timestamps. */
  nowMs: () => number;
  onCallout: (c: CalloutRecord) => void;
}

/** Locator methods that interact with an element (cursor should travel there first). */
const ACTION_METHODS = new Set([
  'click', 'dblclick', 'hover', 'fill', 'check', 'uncheck', 'setChecked',
  'selectOption', 'tap', 'press', 'pressSequentially', 'type', 'clear',
]);

/** Subset that warrants a click pulse + callout ring. */
const CLICK_METHODS = new Set([
  'click', 'dblclick', 'check', 'uncheck', 'setChecked', 'selectOption', 'tap',
]);

/** Locator methods that return another Locator and must stay instrumented. */
const CHAIN_METHODS = new Set([
  'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
  'getByTestId', 'getByTitle', 'getByAltText', 'first', 'last', 'nth',
  'filter', 'and', 'or', 'describe',
]);

/** Page methods that return a Locator to instrument. */
const PAGE_LOCATOR_METHODS = new Set([
  'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
  'getByTestId', 'getByTitle', 'getByAltText',
]);

/** Deprecated-but-supported page-level shortcuts taking a selector first arg. */
const PAGE_ACTION_METHODS = new Set([
  'click', 'dblclick', 'hover', 'fill', 'check', 'uncheck', 'selectOption', 'tap', 'press', 'type',
]);

/**
 * Smooth-scroll the target to the center of the viewport when it isn't fully
 * visible, then wait for the scroll to settle. Playwright auto-scrolls (and
 * jumps) right before an action; doing it here first — smoothly — means the
 * cursor travels and the callout rings over the framed element instead of an
 * off-screen one, so below-the-fold fills/selects/clicks read on video without
 * the author hand-writing scrollIntoView + waitForTimeout (#10).
 */
async function scrollIntoViewSmooth(page: Page, target: Locator): Promise<void> {
  const alreadyInView = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
    if (!inView) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    return inView;
  });
  if (alreadyInView) return;
  // Poll the element's own position until it stops moving — catches both
  // window- and scroll-container scrolling — capped so an animating element
  // can never stall the render.
  let lastTop = Number.NaN;
  for (let i = 0; i < 12; i++) {
    const box = await target.boundingBox();
    const top = box ? Math.round(box.y) : Number.NaN;
    if (top === lastTop) break;
    lastTop = top;
    await page.waitForTimeout(80);
  }
}

/**
 * Move the cursor to the target, pulse + ring on click-like actions, record
 * the callout. Any failure here is swallowed: the action must still run.
 */
async function presentAction(
  page: Page,
  target: Locator,
  method: string,
  hooks: InstrumentHooks,
): Promise<void> {
  if (!hooks.cursor && !hooks.callouts) return;
  try {
    await target.waitFor({ state: 'visible', timeout: 5000 });
    await scrollIntoViewSmooth(page, target);
    const box = await target.boundingBox();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (hooks.cursor) {
      await page.evaluate(
        ([x, y]) => (window as { __forgeCursor?: { moveTo(x: number, y: number): void } }).__forgeCursor?.moveTo(x!, y!),
        [cx, cy],
      );
      await page.waitForTimeout(CURSOR_TRAVEL_MS + 50);
    }
    if (CLICK_METHODS.has(method)) {
      if (hooks.callouts) {
        await page.evaluate(
          ([x, y, w, h]) =>
            (window as { __forgeCallout?: (x: number, y: number, w: number, h: number) => void }).__forgeCallout?.(x!, y!, w!, h!),
          [box.x, box.y, box.width, box.height],
        );
        hooks.onCallout({ atMs: hooks.nowMs(), x: box.x, y: box.y, w: box.width, h: box.height });
        // Let the ring play out fully BEFORE the click: it sits above app
        // content (high z-index), so if it lingered past the click it would
        // float over whatever the click reveals — modal backdrops, new routes.
        await page.waitForTimeout(CALLOUT_VISIBLE_MS + 250);
      }
      if (hooks.cursor) {
        await page.evaluate(
          ([x, y]) => (window as { __forgeCursor?: { pulse(x: number, y: number): void } }).__forgeCursor?.pulse(x!, y!),
          [cx, cy],
        );
      }
    }
  } catch (err) {
    logger.debug(`cursor presentation skipped for ${method}: ${err instanceof Error ? err.message : err}`);
  }
}

function wrapLocator(locator: Locator, page: Page, hooks: InstrumentHooks): Locator {
  return new Proxy(locator, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      if (ACTION_METHODS.has(prop)) {
        return async (...args: unknown[]) => {
          await presentAction(page, target, prop, hooks);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (CHAIN_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return isLocatorLike(result) ? wrapLocator(result as Locator, page, hooks) : result;
        };
      }
      return value.bind(target);
    },
  });
}

function isLocatorLike(v: unknown): boolean {
  return !!v && typeof (v as Locator).click === 'function' && typeof (v as Locator).boundingBox === 'function';
}

/**
 * Wrap a Page so locators it produces animate the fake cursor and emit
 * callout records before delegating to real Playwright methods. If an exotic
 * call path escapes the proxy, the action still works — the cursor just
 * doesn't move.
 */
export function instrumentPage(page: Page, hooks: InstrumentHooks): Page {
  return new Proxy(page, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      if (PAGE_LOCATOR_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return isLocatorLike(result) ? wrapLocator(result as Locator, target, hooks) : result;
        };
      }
      if (PAGE_ACTION_METHODS.has(prop)) {
        return async (...args: unknown[]) => {
          if (typeof args[0] === 'string') {
            await presentAction(target, target.locator(args[0]), prop, hooks);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}
