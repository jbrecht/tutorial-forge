# tutorial-forge

[![npm](https://img.shields.io/npm/v/tutorial-forge)](https://www.npmjs.com/package/tutorial-forge)
[![CI](https://github.com/jbrecht/tutorial-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/jbrecht/tutorial-forge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/tutorial-forge)](LICENSE)

Turn scripted Playwright walkthroughs into finished, narrated tutorial videos (MP4).

![demo: forge renders a narrated walkthrough of an example app](docs/assets/demo.gif)

*Excerpt from the example app's generated tutorial — fake cursor, click highlights, and pacing all derive from the script below. [Watch the full video with narration](https://github.com/jbrecht/tutorial-forge/blob/main/docs/assets/getting-started.mp4).*

**Tutorials are source code.** Each tutorial is a TypeScript file pairing narration lines with raw Playwright actions. When your app's UI changes, you re-run the pipeline instead of re-recording. Tutorials live in your repo, get reviewed in PRs, and regenerate in CI.

```ts
import { tutorial, step } from 'tutorial-forge';

export default tutorial('Getting started', [
  step('Welcome! Let us create your first event.', async () => {}),
  step('Open the Events page from the navigation bar.', async (page) => {
    await page.getByRole('link', { name: 'Events' }).click();
  }),
  step('Click New event and fill in the details.', async (page) => {
    await page.getByRole('button', { name: 'New event' }).click();
    await page.getByLabel('Event name').fill('Summer Kickoff');
  }),
]);
```

```
$ tutorial-forge render
▶ getting-started — Getting started (3 steps)
✓ tutorials/dist/getting-started.mp4 (32.1s)
  subtitles: tutorials/dist/getting-started.srt
```

The pipeline handles everything else: TTS narration (ElevenLabs, OpenAI, Piper, or silent), browser driving, screen recording, narration-driven pacing, an animated fake cursor, click-highlight callouts, SRT subtitles, and the final FFmpeg merge.

## How it works

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   1. TTS    │ ───▶ │  2. RECORD  │ ───▶ │   3. POST   │
└─────────────┘      └─────────────┘      └─────────────┘
  audio files          raw .webm +          final .mp4
  + durations          manifest.json        (+ .srt)
```

1. **TTS** — every narration line is synthesized and measured first (content-hash cached, so unchanged lines are never re-synthesized).
2. **Record** — Chromium is driven through your steps while Playwright records video. Each step holds on screen at least as long as its narration clip: narration drives pacing, never the reverse.
3. **Post** — one FFmpeg invocation trims setup pre-roll, lays each narration clip at its measured offset, downscales, and transcodes to H.264/AAC.

Every stage writes inspectable artifacts to a work directory (`.forge/<id>/`), kept on failure. Phases re-run independently: `tutorial-forge render --phase post` re-merges without re-recording.

## Requirements

- Node ≥ 20, `ffmpeg`/`ffprobe` ≥ 6 on PATH, Playwright Chromium (`npx playwright install chromium`)
- Check your environment with `tutorial-forge doctor`

## Packages

| Package | What |
|---|---|
| `packages/core` (`tutorial-forge`) | The library: types, spec builders, pipeline, TTS providers |
| `packages/cli` (`tutorial-forge-cli`) | `tutorial-forge render / list / doctor / clean` (alias: `tforge`) |
| `packages/example-app` | Self-contained demo app + tutorial; the dev/CI target |

## Quick start (this repo)

```sh
pnpm install
pnpm --filter tutorial-forge build
cd packages/example-app
pnpm exec playwright install chromium
pnpm serve &          # demo app on :4173
pnpm forge render     # → tutorials/dist/getting-started.mp4
```

By default the example renders with silent placeholder narration. For real voices, copy `.env.example` to `.env` in `packages/example-app`, set `FORGE_TTS=elevenlabs` (with `ELEVENLABS_API_KEY`) or `FORGE_TTS=openai` (with `OPENAI_API_KEY`), and re-run. The CLI loads `.env` from the directory you run it in; `.env` is gitignored. See [getting started](docs/getting-started.md#tts-providers-and-api-keys) for creating a minimally-scoped ElevenLabs key (only "Text to Speech" access is needed).

Docs: [getting started](docs/getting-started.md) · [writing tutorials](docs/writing-tutorials.md) · [adapters](docs/adapters.md)
