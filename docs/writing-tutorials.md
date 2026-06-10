# Writing tutorials

A tutorial file is any TS/JS module whose default export is a `Tutorial` (or `Tutorial[]`), built with the `tutorial()` and `step()` helpers. The CLI discovers them by glob (default `**/*.tutorial.ts`).

```ts
import { tutorial, step } from 'tutorial-forge';

export default tutorial('Getting started with Lumen Events', [
  step(
    'Welcome to Lumen Events. Let us create your first event.',
    async () => {},                       // pure-narration step: nothing happens on screen
    { id: 'welcome' },
  ),
  step(
    'Open the Events page from the navigation bar.',
    async (page) => {
      await page.getByRole('link', { name: 'Events' }).click();
      await page.getByRole('heading', { name: 'Events' }).waitFor();
    },
    { id: 'open-events' },
  ),
], { id: 'getting-started' });
```

## Steps

`step(narration, run, opts?)`:

- **narration** — the line spoken over this step. Plain text (no SSML). May be `''` for silent steps.
- **run(page)** — the action. You get the **raw Playwright `Page`**; use any Playwright API. The pipeline never wraps or re-invents Playwright — it only instruments `click`/`hover`/`fill`/`check`/`selectOption`-style calls to animate the fake cursor and record callouts. If an exotic call path escapes the instrumentation, the action still works; the cursor just doesn't move.
- **opts.id** — stable slug used in the manifest, cache keys, and logs. Auto-derived from the index (`step-01`) if omitted, but explicit ids keep artifacts stable when you reorder steps.
- **opts.waitFor(page)** — awaited after `run()`. Playwright auto-waiting covers most readiness; use this for slow async operations. Prefer locator waits over timeouts:

  ```ts
  step('Click Create. Saving takes a moment.', async (page) => {
    await page.getByRole('button', { name: 'Create event' }).click();
  }, {
    waitFor: async (page) => {
      await page.locator('#toast.show').waitFor();
    },
  })
  ```

- **opts.settleMs** — extra hold after both narration and action complete (default 400).

## Pacing

Narration drives pacing. The pipeline synthesizes and measures every narration clip *first*; during recording each step is held on screen for at least `leadInMs` (default 300) + the clip's duration. If the action takes longer than the narration, the step holds until the action finishes instead. You never specify durations by hand.

## Timing manifest

Every render writes `manifest.json` describing the full timeline (per-step start/end, action windows, audio durations, callout boxes). It is the contract between the record and post phases and a debugging gold mine — run with `--keep-work` to keep it on success.

## Validation

`tutorial()` validates at load time — before any browser launches: non-empty steps, unique step ids, and narration free of markup/control characters (warning only). Errors include the step index.
