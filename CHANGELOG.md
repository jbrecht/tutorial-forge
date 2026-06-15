# Changelog

All notable changes to `tutorial-forge` and `tutorial-forge-cli`. Versions are published in lockstep.

## Upgrading from 0.1.x → 0.8.0

**There are no breaking changes.** Update both packages and everything keeps working as before:

```sh
pnpm up tutorial-forge@latest tutorial-forge-cli@latest
pnpm exec tutorial-forge doctor   # confirm the environment is still happy
```

Everything below is opt-in. Notes for existing consumers:

- Adapter `setup`/`teardown` and step `run`/`waitFor` callbacks now receive an optional second argument (`ctx: { lang }`). Existing one-argument callbacks are unaffected; use `ctx.lang` only if you adopt localization.
- `subtitles: 'burn'` previously required an ffmpeg built with libass and silently depended on it; it now works on **every** ffmpeg build (see 0.6.0) and no longer writes a sidecar `.srt`.
- `StepError` messages are richer (multi-line, with artifact paths). If you parsed them, prefer the new structured `error.artifacts` field.
- The timing manifest gained optional fields (`lang`, `capture`). Old kept work dirs still post-process fine.

## 0.11.0 — teaching-first rendering

A pedagogy-focused release: the engine already nailed the mechanics (narration-first pacing, signaling, coherence), so this round makes the *tutorials it produces* teach better, acting on the instructional-designer review. All three additions are additive and opt-in/presence-driven — existing tutorials and adapters render unchanged, and no public API was removed or changed. Update both packages in lockstep.

- **Chapters / segmenting (#35).** Every render now emits chapter markers derived from the per-step timeline: an MP4 chapter track (QuickTime/VLC/most players), a `<id>.chapters.vtt` sidecar for web players, and a `<id>.chapters.txt` YouTube-style timestamp list. One chapter per narrated step (silent steps fold into the prior chapter); the title is the first sentence of the step's narration. On by default; disable with `--no-chapters` or `chapters: false`. Author-defined section grouping is a planned follow-up. Additive — no change to the rendered video itself.
- **Teaching-narration guidance + germane lints (#36).** New "[Writing narration that teaches](docs/writing-tutorials.md#writing-narration-that-teaches)" guide covering the evidence-based principles the engine already supports (one idea per step, explain the *why*, signaling language, objective/recap framing, write for the ear, name what-and-where). Backed by advisory **load-time lints** in `tutorial()` that warn (never fail) on narration that demonstrates without teaching: over-long narration per step (on by default, threshold via `lint.maxNarrationWords`), plus strict-mode heuristics for steps bundling multiple instrumented actions and a missing objective/recap. Suppress per step with `step({ lint: false })` or globally with `tutorial(..., { lint: false })`. New `LintOptions` type exported.
- **Objective + recap cards (#37).** A tutorial can now declare `objectives?: string[]` and `summary?: string`; when present, an intro title/objective card is composited before the first step and a recap card after the last (advance-organizer + summary principles). Card durations fold into the timeline — subtitles, chapter markers, and GIF excerpts stay aligned, and the chapter track gains **Objectives**/**Recap** entries. Cards are visual-only (put spoken objectives in step-1 narration), localizable via the reserved `__objectives__` / `__summary__` keys in a translation sidecar, and suppressible with `--no-cards` or `cards: false`. Additive — a tutorial that declares neither renders unchanged. New `CardContent` type and card helpers exported.

## 0.10.0 — teardown safety & authoring state

A second dogfooding pass (umami again, on 0.9.0) surfaced a cluster of setup/teardown lifecycle gaps and the ergonomic hole the new per-tutorial setup opened. Additive for normal use — existing tutorials and adapters render unchanged. One type-only caveat: `StepContext` gained a required `state` field, so if you construct a `StepContext` object literal yourself (e.g. a test harness) it now needs that field; code that merely *receives* `ctx` in a callback is unaffected.

Bug fixes (teardown coverage):

- **Setup-phase failures no longer leak.** A throw in `adapter.setup` or `tutorial.setup` now runs the full teardown chain (step `onTeardown` thunks → `tutorial.teardown` → `adapter.teardown`) before rethrowing, instead of only `browser.close()`. `ctx.onTeardown` registered inside a `setup()` now means what it looks like it means, on the path most likely to seed-then-throw (a flaky sign-in, a warm-up `goto` timeout) (#15).
- **`preview` no longer leaks the adapter seed.** It now runs the *full* teardown chain on every exit path, not just the step thunks. `preview` is the run-repeatedly iterate tool, so the previous behavior (clean up step data, leak the adapter seed) quietly filled a shared test DB. Teardown hooks should tolerate the partial, mid-tutorial state `preview` reaches (#16).
- **Partial contact sheet on failure.** A failed render with `--contact-sheet`/`contactSheet` now emits a partial sheet of the steps that completed plus the failure frame as the last cell, instead of nothing — the at-a-glance view you most want for a failing run (#20).
- The `ctx.onTeardown` callback return type is widened to `() => unknown | Promise<unknown>` (the result is awaited and discarded), so value-returning cleanups like `() => Promise.all(...)` typecheck without a wrapper (#21).

New (additive API):

- **`ctx.state` — a typed, per-render state channel.** `adapter.setup`'s return value lands on `ctx.state`, which `tutorial.setup` and steps read — replacing the module-global + `!`-assertion handoff with something scoped to one render (parallel-safe). Steps can also stash a live-created id on it for their own `onTeardown`. Typed end-to-end via `TutorialAdapter<S>` / `tutorial<S>` / `step<S>` (#17).
- **`tutorial-forge doctor --setup`** actually runs `adapter.setup` once and tears it down, catching the "reachable but pointed at the wrong database" class of failure — a green reachability check followed by a guaranteed sign-in failure — before you wait out a whole render. Exposed programmatically as `probeAdapterSetup(adapter)`. Off by default (it seeds + signs in for real) (#19).

Docs:

- The "Settling" section now warns that `settleUntil: 'networkidle'` races React `startTransition`-deferred Server Actions (the standard Next.js App Router mutation) and steers those to `waitFor` on the committed UI (#18).
- Adapters docs gain a `ctx.state` section and a teardown-coverage matrix spelling out which hooks run on each path — clean finish, step failure, setup failure, `preview`, `doctor --setup` (#23).

## 0.9.0 — authoring loop

Ergonomics from a real-world dogfooding pass (authoring tutorials for the umami app). Additive for normal use — existing tutorials and adapters render unchanged. One type-only caveat: `StepContext` gained a required `onTeardown` method, so if you construct a `StepContext` object literal yourself (e.g. in a test harness) it now needs that field; code that merely *receives* `ctx` in a callback is unaffected.

- New `step(..., { settleUntil })` option (`'networkidle' | 'load' | 'domcontentloaded'`): wait on a real page load-state signal after the action instead of guessing a `settleMs` — e.g. `'networkidle'` to let a `router.refresh()`'s fetches quiesce. Best-effort and bounded (~5s), so a never-idle page (websockets/polling) logs and proceeds rather than hanging; composes with `settleMs`. Docs add a waitFor-vs-settleUntil-vs-settleMs mental model (#14).
- Tutorials can now declare their own `setup`/`teardown` that **compose with** the adapter's, so two tutorials sharing one adapter can start from different state. Run order is adapter.setup → tutorial.setup in, and step thunks (LIFO) → tutorial.teardown → adapter.teardown out. Existing single-adapter tutorials are unaffected (#8).
- New `ctx.onTeardown(fn)` in step (and adapter/tutorial) callbacks: register cleanup for data a step creates mid-tutorial, torn down deterministically in reverse order — no more "(demo)"-naming + purge-helper hacks for orphaned rows. Teardown (step thunks + tutorial.teardown + adapter.teardown) runs on **both** the success and failure paths, so data created before a failing step is still cleaned up. `preview` runs only the step thunks (it reaches partial, mid-tutorial state, so it skips the tutorial/adapter teardown those hooks assume a full run) (#8).
- Cursor choreography now **smooth-scrolls the target into the center of the frame** before every instrumented action (`click`, `fill`, `selectOption`, `check`, …) when it isn't already visible. Below-the-fold fills/selects/clicks now play on-screen with the cursor and callout ring on the right element — no more hand-written `scrollIntoView` + `waitForTimeout` (#10).
- New `step(..., { focus })` option: return a locator to anchor the cursor on at the start of a step (smooth-scroll + cursor move), so narration about "this control" has a visual focus even on pure-narration steps or when the action is elsewhere. Decorative; failures are logged and skipped (#10).
- New `tutorial-forge preview <step>` command: render a single step to a PNG in seconds. It replays `adapter.setup()` + every prior step's `run()` to reach state, then runs just the target step (by 1-based index or step id) and screenshots it — no TTS, no video assembly. Lets you validate one step's selectors/framing without re-recording the whole tutorial (#11).
- New `--contact-sheet` flag (and `contactSheet: true` in config): after a render, keeps a settled screenshot per step and emits a labeled grid PNG next to the video (`<name>-contact-sheet.png`). A passing render only proves selectors resolved; the contact sheet lets an author confirm every step framed the right thing at a glance (#9).
- `doctor` now probes that the app at your adapter's `baseURL` is reachable when run from a project, turning the most common render failure (forgot to start the dev server) into a clear up-front ✗ instead of a Playwright navigation timeout deep in a render. Accepts `--config <path>`; skips cleanly when no config is found (#12).
- `idleSpeedup` now logs a one-line summary even when it compresses nothing (`post: idle speed-up — no spans over 2000ms`), so it's observable that it ran (#13).

## 0.8.0 — screencast recorder

- New `recorder: 'screencast'` (CLI `--recorder screencast`): captures CDP frames with explicit per-frame timestamps instead of Playwright's `recordVideo`. The raw video is clock-aligned by construction — no calibration flash — and frames arrive only when content changes. `'video'` remains the default. Chromium-only (as is the whole pipeline).
- The manifest records how capture happened (`capture: { recorder, rawFile, width, height, clockAligned }`).
- Known limitation, documented on issue #5: Chromium delivers screencast frames at CSS-viewport size regardless of `deviceScaleFactor`, so this does not provide 2x/4K capture.

## 0.7.0 — GIF export

- `--gif` (or `gif: true | { widthPx, fps, captions, steps }`) writes an optimized animated GIF next to the MP4: two-pass palette, fps-downsampled (default 10), default 720px wide, narration captions burned in (GIFs are silent).
- `--gif-steps open-modal..create-event` excerpts a step range, resolved from the timing manifest and remapped through idle speed-up when both are active. Single id = single-step excerpt.
- `RenderResult.gifPath` reports the file.

## 0.6.0 — burned-in captions on every ffmpeg build

- `subtitles: 'burn'` no longer needs libass (Homebrew's ffmpeg 8 dropped it). Each cue renders as a transparent caption pill in the Playwright browser and is composited with ffmpeg's built-in `overlay` filter — identical output on every machine.
- Style with `captionStyle: { fontSizePx, maxWidthPx, bottomMarginPx }` in config.
- Captions composite after scale/zoom, so `--zoom` never distorts them; cue timing shares the SRT pipeline (localization and idle speed-up apply automatically).
- Burn mode no longer writes a sidecar `.srt`.

## 0.5.0 — idle speed-up

- `--idle-speedup` (or `idleSpeedup: true | { maxIdleMs: 2000, speed: 3 }`) fast-forwards narration-free spans: spinners, slow loads, long silent steps.
- Guarantees: narration playback and click choreography always run at 1x; compressed spans keep 0.5s of 1x at each edge; audio offsets, SRT cues, and zoom windows remap through the same time map.

## 0.4.0 — failure diagnostics

- Step failures throw `StepError` with `artifacts`: a failure screenshot and the recent browser console/pageerror/failed-request log (always captured). The error message lists the paths.
- `--debug`: records a Playwright trace (`trace.zip`, open with `npx playwright show-trace`), writes the full console log, captures before/after screenshots per step under `.forge/<id>/steps/`, and always keeps the work dir.

## 0.3.0 — zoom-on-callout

- `--zoom` (or `zoom: true | { factor }`, default factor 1.35) smoothly zooms toward each click target and back out: the camera leads the click by a beat, holds through what it reveals, then releases. Composited in post from manifest callout data — adds nothing to recording time. Rapid-fire clicks don't ping-pong (overlapping windows are skipped).

## 0.2.1 — fix: calibration flash leak

- With a fast adapter `setup()`, magenta calibration-flash frames could survive into the final video (and become its thumbnail). The trim point now always clears the flash, and the video opens on the settled app. The e2e suite asserts the output contains no flash.

## 0.2.0 — localization

- Render any tutorial in any language from one spec. Translations live in sidecar files next to the tutorial (`getting-started.tutorial.es.json`, keyed by step id) or inline via `Tutorial.translations`.
- `--lang es,fr` or `languages: ['es','fr']` in config; outputs `<id>.<lang>.mp4` + `.srt`. Each language is a full pipeline run — pacing re-derives from that language's actual speech duration.
- Per-language voices via `ttsByLang: { es: ElevenLabs({ voiceId }) }`; `defaultLang` (default `'en'`) marks the language the spec is written in.
- Adapter and step callbacks receive `ctx.lang` for localized apps (locale-aware setup and selectors). Give steps explicit ids — translation tables are keyed by them.
- `tutorial-forge list` shows available languages.

## 0.1.1 — fix: callout ring timing

- The click-highlight ring now plays out fully *before* the click fires. Previously it lingered over whatever the click revealed (e.g. floating above a modal backdrop) for ~800ms.

## 0.1.0 — initial release

- Three-phase pipeline (TTS → record → post), narration-driven pacing, ElevenLabs/OpenAI/Piper/Silent providers with content-hash caching, animated cursor + click callouts, SRT subtitles, timing manifest, `tutorial-forge render/list/doctor/clean` CLI (alias `tforge`), `.env` auto-loading.
