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

## Unreleased

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
