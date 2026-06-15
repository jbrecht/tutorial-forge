# Getting started

## Install

```sh
pnpm add -D tutorial-forge tutorial-forge-cli playwright
npx playwright install chromium
```

You also need `ffmpeg` and `ffprobe` (≥ 6) on PATH. Verify everything with:

```sh
pnpm exec tutorial-forge doctor
```

Run this from your project directory so `doctor` can read `forge.config.ts` and probe that the app at your adapter's `baseURL` is up — the most common render failure is simply forgetting to start the dev server. Add `--setup` (`tutorial-forge doctor --setup`) to go one step further and actually run `adapter.setup` once, tearing it down afterward — this catches a reachable-but-mispointed server (e.g. the dev server on the wrong database) that would otherwise pass reachability and then fail every render at sign-in.

> **pnpm note:** if `pnpm exec tutorial-forge …` trips pnpm's ignored-builds pre-check, invoke the bin directly (`./node_modules/.bin/tutorial-forge …`) or approve the build with `pnpm approve-builds`.

The binary is also installed under the shorter alias `tforge`.

## Configure

Create `forge.config.ts` at your repo root (or wherever you run `tutorial-forge`):

```ts
import { defineConfig, ElevenLabs } from 'tutorial-forge';
import { myAdapter } from './e2e/my-adapter';

export default defineConfig({
  adapter: myAdapter,                       // gets your app into a known state — see adapters.md
  tts: ElevenLabs({ voiceId: 'daniel' }),   // or OpenAITTS(), Piper(), SilentProvider()
  outDir: 'tutorials/dist',
  tutorials: ['tutorials/**/*.tutorial.ts'],
  viewport: { width: 1920, height: 1080 },
});
```

CLI flags override config; config overrides built-in defaults.

## TTS providers and API keys

The `forge` CLI automatically loads a `.env` file from the directory you run it in (variables already set in your shell take precedence). Put provider credentials there and keep it out of version control — this repo's `.gitignore` already excludes `.env`.

```sh
# .env
ELEVENLABS_API_KEY=sk_...
# or
OPENAI_API_KEY=sk-...
```

| Provider | Config | Credentials | Notes |
|---|---|---|---|
| `ElevenLabs({ voiceId })` | required `voiceId` | `ELEVENLABS_API_KEY` (or `apiKey` option) | Best quality; see key setup below |
| `OpenAITTS({ voice })` | optional voice, default `alloy` | `OPENAI_API_KEY` (or `apiKey` option) | |
| `Piper({ model })` | path to a `.onnx` voice model | none | Local/offline; needs the `piper` CLI installed |
| `SilentProvider()` | — | none | Deterministic silence; for tests and CI |

Narration audio is cached by content hash of provider + voice + text (`~/.cache/tutorial-forge/tts` by default), so each narration line is synthesized exactly once — re-renders and UI-only changes never hit the TTS API.

### Creating an ElevenLabs key with minimal access

In the ElevenLabs dashboard, go to **Settings → API Keys → Create API Key**:

1. Name it after your project (e.g. `tutorial-forge`).
2. Enable **Restrict Key**.
3. Under Endpoints, set **Text to Speech → Access** — leave everything else at **No Access**. The pipeline only ever calls `POST /v1/text-to-speech/{voiceId}`; it does not need Voices, History, or any other endpoint (you pass the voice ID in `forge.config.ts`).
4. Optionally set a per-period credit limit as a spending cap; thanks to the cache, steady-state usage is only the lines you change.

To pick a voice, copy its ID from the ElevenLabs voice library and pass it as `ElevenLabs({ voiceId: '...' })`.

## Render

```sh
tutorial-forge list                      # discovered tutorials: id, title, step count
tutorial-forge render                    # render everything
tutorial-forge render --only my-id      # iterate on one tutorial
tutorial-forge render --headed          # watch the browser while recording
tutorial-forge render --phase post      # re-merge without re-recording (uses .forge/<id>/)
tutorial-forge render --out-dir dist    # override config.outDir for this run
tutorial-forge render --concurrency 2   # cap parallel TTS synthesis (overrides config.ttsConcurrency)
tutorial-forge clean --cache            # remove work dirs and the TTS cache
```

Output: `<outDir>/<tutorial-id>.mp4` plus a sidecar `.srt` (set `subtitles: 'burn'` to burn them in, `'off'` to skip). Burned captions are rendered by the browser and composited with ffmpeg's built-in overlay filter — no libass needed, works on any ffmpeg build, and styles via `captionStyle: { fontSizePx, maxWidthPx, bottomMarginPx }` in config.

**Zoom-on-callout:** pass `--zoom` (or set `zoom: true` / `zoom: { factor: 1.5 }` in config) to smoothly zoom toward each click target and back out — the camera leads the click, holds through what it reveals, then releases. Composited in post from the timing manifest, so it adds nothing to recording time.

**GIF export:** pass `--gif` to also write an animated GIF next to the MP4 — fps-downsampled, palette-optimized, with narration captions burned in (GIFs are silent). Excerpt a step range with `--gif-steps open-modal..create-event`, or configure via `gif: { widthPx, fps, captions, steps }`. Perfect for READMEs and social posts.

**Idle speed-up:** pass `--idle-speedup` (or `idleSpeedup: true` / `{ maxIdleMs: 2000, speed: 3 }`) to fast-forward narration-free waits — spinners, slow loads, long silent steps. Narration playback and click choreography always stay at 1x; audio offsets and subtitle cues are remapped to the shortened timeline automatically.

**Chapters:** every render embeds chapter markers so learners can self-pace and jump between segments — the strongest, cheapest learning win a tutorial video gets. You get three things at no extra recording cost, derived from the per-step timeline:

- an **MP4 chapter track** (readable in QuickTime, VLC, and most players),
- a **`<id>.chapters.vtt`** sidecar for web players, and
- a **`<id>.chapters.txt`** YouTube-style timestamp list to paste into a video description.

One chapter per narrated step; silent steps fold into the chapter before them, and the title is the first sentence of the step's narration, capped at 50 characters (so write a clear, short opening line). Chapters are on by default; disable with `--no-chapters` or `chapters: false` in config.

**Getting chapters onto YouTube and Vimeo.** Neither platform reads the embedded MP4 chapter track — each consumes one of the sidecars instead:

- **YouTube** — paste `<id>.chapters.txt` into the video description. YouTube activates the list only when it has **at least three** chapters, the first is at **0:00**, and **every chapter is ≥ 10 seconds long** — and it silently ignores the *entire* list otherwise. tutorial-forge guarantees the 0:00 start and folds any sub-10s chapter into its neighbor in the `.txt`, so the list stays valid; a tutorial that ends up with fewer than three chapters simply won't show them on YouTube.
- **Vimeo** — upload `<id>.chapters.vtt` under Settings → Interactive → Chapters. Titles are limited to 50 characters (which is why that's the default cap) and a video allows up to 80 chapters; chapters appear only in the Vimeo player, not when the video is embedded elsewhere.

The MP4 chapter track is for desktop players (QuickTime, VLC) and keeps the full per-step granularity.

> Per-step is the first cut. Author-defined section grouping — chapters that span several steps and map to named concepts — is a planned follow-up ([#35](https://github.com/jbrecht/tutorial-forge/issues/35)).

**Intro & recap cards:** a tutorial that declares `objectives` and/or a `summary` gets a title/objective card composited before the first step and a recap card after the last — opening by telling learners what they'll be able to do and closing by consolidating it. Card durations fold into the timeline (subtitles, chapters, and GIF excerpts stay aligned; the chapter track gains **Objectives** and **Recap** chapters). On by default when present; disable with `--no-cards` or `cards: false`. See [Writing tutorials → Intro & recap cards](writing-tutorials.md#intro--recap-cards).

## Recorders

Two capture implementations, selected with `--recorder` or `recorder:` in config:

- **`video`** (default) — Playwright's `recordVideo`. The recording clock is aligned in post by detecting a calibration flash painted at the start.
- **`screencast`** — CDP frame capture with explicit per-frame timestamps: exact clock alignment by construction (no flash), and frames only arrive when content changes. Chromium-only (which the pipeline already is).

Output should be visually identical; screencast is the more precise mechanism and the likely future default.

## Debugging a failing tutorial

When a step fails, the render throws a `StepError` naming the tutorial and step, the work dir is kept, and two artifacts are always written: a screenshot of the page at failure and the recent browser console/pageerror/requestfailed log.

For real investigation, re-run with `--debug`:

```sh
tutorial-forge render --only my-tutorial --debug
```

Debug mode additionally records a full Playwright trace (`trace.zip` — open with `npx playwright show-trace`), writes the complete console log, and captures before/after screenshots for every step under `.forge/<id>/steps/`. Debug renders are slower and not for production output.

## CI

The TTS cache (`~/.cache/tutorial-forge/tts` by default, configurable via `ttsCacheDir`) is content-hashed by provider + narration text — cache it in CI and unchanged narration lines never hit the TTS API. Headless rendering needs a sane font set in containers: install `fonts-liberation` and `fonts-noto-color-emoji`.

## Programmatic use

The CLI is a thin shell over the library:

```ts
import { render, SilentProvider } from 'tutorial-forge';
import myTutorial from './tutorials/my.tutorial';

const result = await render(myTutorial, myAdapter, {
  tts: SilentProvider(),
  output: 'dist/my.mp4',
});
console.log(result.outputDurationMs, result.manifest);
```
