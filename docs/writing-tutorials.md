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
- **run(page)** — the action. You get the **raw Playwright `Page`**; use any Playwright API. The pipeline never wraps or re-invents Playwright — it only instruments `click`/`hover`/`fill`/`check`/`selectOption`-style calls to animate the fake cursor and record callouts. Before each such action the target is **smooth-scrolled into the center of the frame** if it isn't already visible, so below-the-fold fills/selects/clicks play on-screen with the cursor on the right element — no manual `scrollIntoView` + `waitForTimeout`. If an exotic call path escapes the instrumentation, the action still works; the cursor just doesn't move.
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

- **opts.focus(page)** — returns a locator to **anchor the cursor on at the start of the step**: it smooth-scrolls that control into frame and moves the fake cursor there, so narration about "this control" has a visual focus even when the step's action is elsewhere or it is pure narration. Decorative — a failure here is logged and skipped, never failing the render.

  ```ts
  step('Now switch the status to Tickets open.', async (page) => {
    await page.getByLabel('Status').selectOption('open');
  }, {
    // Usually unnecessary — the selectOption above already scrolls + anchors.
    // Use focus when the control you're describing isn't the one you act on:
    focus: (page) => page.getByText('Event status'),
  })
  ```

- **opts.settleUntil** — wait for a real page load-state signal (`'networkidle' | 'load' | 'domcontentloaded'`) after `run()`/`waitFor()`, instead of guessing a `settleMs`. See [Settling](#settling-waitfor-vs-settleuntil-vs-settlems) below.
- **opts.settleMs** — extra on-screen hold after both narration and action (and any `settleUntil`) complete (default 400).

## Pacing

Narration drives pacing. The pipeline synthesizes and measures every narration clip *first*; during recording each step is held on screen for at least `leadInMs` (default 300) + the clip's duration. If the action takes longer than the narration, the step holds until the action finishes instead. You never specify durations by hand.

## Settling: waitFor vs settleUntil vs settleMs

After a step's action, the recording needs to wait until the app has visually caught up before moving on. There are three tools, in order of preference — reach for a magic number last:

| | What it waits on | Use when |
|---|---|---|
| **`waitFor`** | A DOM signal you choose (a locator appears, text changes, a spinner detaches) | There's a specific element/state that marks "done". This is the principled default — it waits exactly as long as needed, no more. |
| **`settleUntil`** | A page load-state signal (`networkidle` / `load` / `domcontentloaded`) | There's *no* clean DOM signal — e.g. a `router.refresh()` that just repaints, or a navigation whose result you don't want to assert on. `'networkidle'` waits for in-flight requests to quiesce. |
| **`settleMs`** | A fixed number of milliseconds | A last resort, or a deliberate on-screen beat *after* readiness (e.g. let an animation finish, or hold the final frame a touch longer). |

Rule of thumb: **if you can name the thing you're waiting for, use `waitFor`.** If the only signal is "the network went quiet," use `settleUntil: 'networkidle'`. Only fall back to `settleMs` for a deliberate pause or when nothing else applies — and keep it small.

```ts
// Best: wait on the concrete signal.
step('Create the event.', async (page) => {
  await page.getByRole('button', { name: 'Create' }).click();
}, { waitFor: (page) => page.getByText('Event created').waitFor() })

// No DOM signal — a refresh just repaints. Wait on the network instead of guessing.
step('The list refreshes with your new row.', async (page) => {
  await page.reload();
}, { settleUntil: 'networkidle' })
```

`settleUntil` is **best-effort and bounded** (~5s): a page that never goes idle — websockets, polling, server-sent events — logs and proceeds rather than failing the render, so it's safe to use even when you're not sure the app quiesces. `settleUntil` and `settleMs` compose: the signal-based wait happens first, then `settleMs` adds its on-screen hold.

## Iterating on a step

A passing render only proves your selectors *resolved* — not that the right thing was on screen. A step that locates a wrong-but-valid element (or one scrolled off-screen) succeeds silently. Two helpers close that gap without re-recording the whole tutorial every cycle:

**`tutorial-forge preview <step>`** renders one step to a PNG in seconds. It runs `adapter.setup()` and then every step *before* the target back-to-back (no narration pacing, no TTS, no video) to reach the state the step runs in, then runs just the target step and screenshots it. `<step>` is a 1-based index (`preview 11`) or a step id (`preview set-status`); narrow to one tutorial with `--only <id>` when your globs match several. Use it to check a single step's selectors and framing fast.

```sh
tutorial-forge preview set-status --only my-tutorial
# → .forge/preview/my-tutorial/preview-set-status.png
```

> Prior-step state is reached by replaying earlier `run()`/`waitFor()` callbacks in order — exactly what a real render does — so anything those steps set up (navigation, form state, seeded data) is present. Only the target step's `settleMs` hold is honored; intermediate pacing is skipped for speed.

**`tutorial-forge render --contact-sheet`** keeps a settled screenshot per step and emits a labeled grid PNG next to the video (`<name>-contact-sheet.png`), one thumbnail per step tagged with its id and narration. Scan it to confirm every step framed the right thing at a glance, instead of scrubbing the video. Enable it persistently with `contactSheet: true` in `forge.config.ts`.

## Timing manifest

Every render writes `manifest.json` describing the full timeline (per-step start/end, action windows, audio durations, callout boxes). It is the contract between the record and post phases and a debugging gold mine — run with `--keep-work` to keep it on success.

## Localization

A tutorial renders in any number of languages from one spec. Put translations in a sidecar JSON file next to the tutorial, keyed by step id:

```
tutorials/
├── getting-started.tutorial.ts
├── getting-started.tutorial.es.json
└── getting-started.tutorial.fr.json
```

```json
{
  "welcome": "Bienvenido a Lumen Events. En este breve recorrido…",
  "open-events": "Desde el panel principal, abre la página de Eventos…"
}
```

Then render with `tutorial-forge render --lang es,fr` (or set `languages: ['es', 'fr']` in config to make it the default). Each language is a full pipeline run — narration is re-synthesized and re-measured, so pacing adapts to each language's actual speech duration — and outputs land as `<id>.<lang>.mp4` + `<id>.<lang>.srt`. The TTS cache partitions by provider + voice + text, so each translated line is synthesized once, ever.

Give steps **explicit ids** when using translations: tables are keyed by id, so `step-03` style auto-ids break when you reorder steps.

Missing entries fall back to the source narration with a warning; a language with no sidecar at all is an error. `tutorial-forge list` shows each tutorial's available languages.

### Localized apps

If the app itself is localized, your selectors and setup need the language too. Every adapter and step callback receives a context as its second argument:

```ts
export const adapter: TutorialAdapter = {
  baseURL,
  async setup(page, ctx) {
    await page.goto(`${baseURL}/${ctx.lang ?? 'en'}`);
  },
};

step('…', async (page, ctx) => {
  // Prefer locale-independent selectors (test ids, roles without names)
  await page.getByTestId('new-event').click();
});
```

Per-language voices: set `ttsByLang` in config (`{ es: ElevenLabs({ voiceId: '…' }) }`); languages without an entry use the main `tts` provider. ElevenLabs' multilingual models speak most languages with the same voice, so often no override is needed.

## Validation

`tutorial()` validates at load time — before any browser launches: non-empty steps, unique step ids, and narration free of markup/control characters (warning only). Errors include the step index.
