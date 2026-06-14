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

- **narration** — the line spoken over this step. Plain text (no SSML). May be `''` for silent steps. This is your highest-leverage teaching surface — see [Writing narration that teaches](#writing-narration-that-teaches) for how to write a line that trains rather than just demonstrates.
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
- **opts.lint** — set to `false` to opt this step out of the [narration lints](#narration-lints) (for an intentionally long or multi-action step).

## Writing narration that teaches

The engine already does the load-bearing pedagogy for you — it paces every step to its narration, cues the eye with a cursor and callouts, and keeps the visual channel free of on-screen prose. What it can't do is write a line that *teaches* instead of merely narrating clicks. These principles come straight from multimedia-learning research; the [example tutorial](../packages/example-app/tutorials/getting-started.tutorial.ts) follows all of them.

- **One idea per step (segmenting).** A step is a learning chunk, not just a click. Keep it to a single concept the learner can absorb before the next one arrives. If a sentence has two "and then"s in it, it's probably two steps. This is the single most impactful thing you can do — the over-long-narration [lint](#narration-lints) nudges you when a step grows past one idea.
- **Explain the *why*, not only the *what*.** "Give the event a descriptive name" tells them what to type; "Give the event a descriptive name — *this is what attendees will see on their invitations*" tells them why it matters, which is what actually sticks. Pair each action with the reason behind it.
- **Use signaling language.** Words like "notice…", "here…", "this is the…" direct attention to the element that matters — reinforcing what the cursor and callouts already point at. They turn a demonstration into a guided observation.
- **Open with an objective, close with a recap.** Start the tutorial with a short pure-narration step that says what the learner will be able to do ("In this tour, we'll create your first event and adjust a workspace setting"). End with one that recaps what they accomplished. The opening primes attention (advance-organizer); the recap consolidates it (summary). Strict-mode lints check for both.
- **Write for the ear, not the page.** Narration is *heard*, not read. Use short sentences and plain words; avoid parentheticals, semicolons, and anything that only parses on a second read. Don't paste paragraphs of on-screen text — doing so makes the eyes compete with the ears (the modality principle the tool otherwise protects for free).
- **Name *what* and *where* — never bare "click here."** Say "click the **New event** button in the toolbar," not "click here." Deictic narration is meaningless to anyone watching sound-off, with captions, or with low vision, and it teaches the learner nothing transferable about the interface.

Because each chapter title is the first sentence of a step's narration (see [Chapters](#chapters)), a short, descriptive opening sentence does double duty — it teaches *and* it gives you clean navigation for free.

### Narration lints

`tutorial()` runs these principles as **load-time warnings** before any browser launches. They are advisory only — they never fail a render and never change the video; they just print a `warn` line pointing at the step.

- **Over-long narration** *(on by default)* — warns when a step's narration exceeds `maxNarrationWords` (default **60** words, ~24s of speech), the segmenting signal that a step is carrying more than one idea.
- **Multiple instrumented actions per step** *(strict mode)* — warns when one `run()` performs three or more cursor-animated actions (clicks, fills, checks…), a best-effort segmenting heuristic.
- **Missing objective / recap** *(strict mode)* — warns when the first step doesn't open with an objective or the last doesn't close with a recap.

Tune or disable them on the tutorial:

```ts
export default tutorial('My tutorial', steps, {
  // Defaults: over-long-narration on, heuristics off.
  lint: { maxNarrationWords: 80, strict: true }, // tune the threshold; enable the heuristics
  // lint: false,                                // turn every lint off
});
```

Silence a single intentional step with `step(narration, run, { lint: false })`. The heuristic lints are gated behind `strict` because they can misfire on deliberate choices — turn them on when you want the extra nudges and accept the occasional false positive.

## Chapters

Every render emits chapter markers (an MP4 chapter track plus `.chapters.vtt` and `.chapters.txt` sidecars) so learners can self-pace and jump between segments. There's one chapter per narrated step — silent steps fold into the chapter before them — and each chapter title is the **first sentence of that step's narration**. That makes the opening line of every step do double duty: write a short, descriptive first sentence and you get clean chapter titles for free. See [Render → Chapters](getting-started.md#render) for the output formats and how to disable them.

## Pacing

Narration drives pacing. The pipeline synthesizes and measures every narration clip *first*; during recording each step is held on screen for at least `leadInMs` (default 300) + the clip's duration. If the action takes longer than the narration, the step holds until the action finishes instead. You never specify durations by hand.

## Settling: waitFor vs settleUntil vs settleMs

After a step's action, the recording needs to wait until the app has visually caught up before moving on. There are three tools, in order of preference — reach for a magic number last:

| | What it waits on | Use when |
|---|---|---|
| **`waitFor`** | A DOM signal you choose (a locator appears, text changes, a spinner detaches) | There's a specific element/state that marks "done". This is the principled default — it waits exactly as long as needed, no more. |
| **`waitForResponse`** *(via `waitFor`/`run`)* | A specific network response | There's no clean DOM signal but you *know the request* behind the change — arm `page.waitForResponse(...)` before the action and await it. The principled choice for `startTransition`-deferred Server Actions; see the warning below. |
| **`settleUntil`** | A page load-state signal (`networkidle` / `load` / `domcontentloaded`) | There's *neither* a clean DOM signal *nor* a knowable endpoint — e.g. a `router.refresh()` that just repaints, or a navigation whose result you don't want to assert on. `'networkidle'` waits for in-flight requests to quiesce. **Not** for `startTransition`-deferred Server Actions when you can name the request — prefer `waitForResponse`; see the warning below. |
| **`settleMs`** | A fixed number of milliseconds | A last resort, or a deliberate on-screen beat *after* readiness (e.g. let an animation finish, or hold the final frame a touch longer). |

Rule of thumb: **if you can name the thing you're waiting for, use `waitFor`.** If you can't name a DOM signal but you know the request behind the change, arm `page.waitForResponse(...)` before the action (see the deferred-mutation warning below). If the only signal is "the network went quiet," use `settleUntil: 'networkidle'`. Only fall back to `settleMs` for a deliberate pause or when nothing else applies — and keep it small.

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

> **`networkidle` races React `startTransition` — prefer `waitFor` for deferred mutations.** The standard Next.js App Router mutation — a controlled input whose `onChange` runs `startTransition(async () => { await someServerAction(); router.refresh() })` — does **not** dispatch its request synchronously. At the instant your `selectOption`/`click` returns, React hasn't fired the action's fetch yet, so the page is *momentarily* network-idle and `settleUntil: 'networkidle'` can resolve against the **pre-mutation** UI (the screenshot shows the old value). It often lands correctly by luck (the request is usually in flight by the time Playwright polls), but it's timing-dependent. Don't reach for `networkidle` here. Two reliable options, most precise first:
>
> ```ts
> // ❌ races the transition — can settle before the server action even dispatches
> step('Switch the status to Tickets open.', async (page) => {
>   await page.getByLabel('Status').selectOption('open');
> }, { settleUntil: 'networkidle' })
>
> // ✅ best: wait on the committed UI — exactly as long as the repaint takes, no race
> step('Switch the status to Tickets open.', async (page) => {
>   await page.getByLabel('Status').selectOption('open');
> }, { waitFor: (page) => page.getByText('Tickets open').waitFor() })
>
> // ✅ when no committed DOM signal is nameable but you know the endpoint:
> //    arm the response wait *before* the action, then await it. This closes the
> //    transition gap without guessing — `waitForResponse` can't resolve until the
> //    request it matches has actually fired and come back.
> step('Switch the status to Tickets open.', async (page) => {
>   const saved = page.waitForResponse(
>     (r) => r.url().includes('/status') && r.request().method() === 'POST',
>   );
>   await page.getByLabel('Status').selectOption('open');
>   await saved;
> })
> ```
>
> Reach for the `waitForResponse` recipe when the mutation repaints existing data (so there's no new element to name for `waitFor`) but you can identify its request — it's strictly more reliable than `settleUntil: 'networkidle'` for deferred transitions and needs no fixed `settleMs`. Reserve `settleUntil: 'networkidle'` for cases with **neither** a committed-state signal **nor** a knowable endpoint — a `router.refresh()`/reload that only repaints existing data, or a navigation whose result you don't assert on.

## Iterating on a step

A passing render only proves your selectors *resolved* — not that the right thing was on screen. A step that locates a wrong-but-valid element (or one scrolled off-screen) succeeds silently. Two helpers close that gap without re-recording the whole tutorial every cycle:

**`tutorial-forge preview <step>`** renders one step to a PNG in seconds. It runs `adapter.setup()` and then every step *before* the target back-to-back (no narration pacing, no TTS, no video) to reach the state the step runs in, then runs just the target step and screenshots it. `<step>` is a 1-based index (`preview 11`) or a step id (`preview set-status`); narrow to one tutorial with `--only <id>` when your globs match several. Use it to check a single step's selectors and framing fast.

```sh
tutorial-forge preview set-status --only my-tutorial
# → .forge/preview/my-tutorial/preview-set-status.png
```

> Prior-step state is reached by replaying earlier `run()`/`waitFor()` callbacks in order — exactly what a real render does — so anything those steps set up (navigation, form state, seeded data) is present. Only the target step's `settleMs` hold is honored; intermediate pacing is skipped for speed.

**`tutorial-forge render --contact-sheet`** keeps a settled screenshot per step and emits a labeled grid PNG next to the video (`<name>-contact-sheet.png`), one thumbnail per step tagged with its id and narration. Scan it to confirm every step framed the right thing at a glance, instead of scrubbing the video. Enable it persistently with `contactSheet: true` in `forge.config.ts`. If a step fails mid-render, you still get a **partial** sheet of the steps that completed plus the failure frame as the last cell — the at-a-glance view of how the run got to the failure.

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
