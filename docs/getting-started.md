# Getting started

## Install

```sh
pnpm add -D tutorial-forge tutorial-forge-cli playwright
npx playwright install chromium
```

You also need `ffmpeg` and `ffprobe` (≥ 6) on PATH. Verify everything with:

```sh
pnpm exec forge doctor
```

## Configure

Create `forge.config.ts` at your repo root (or wherever you run `forge`):

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

## Render

```sh
forge list                      # discovered tutorials: id, title, step count
forge render                    # render everything
forge render --only my-id      # iterate on one tutorial
forge render --headed          # watch the browser while recording
forge render --phase post      # re-merge without re-recording (uses .forge/<id>/)
forge clean --cache            # remove work dirs and the TTS cache
```

Output: `<outDir>/<tutorial-id>.mp4` plus a sidecar `.srt` (set `subtitles: 'burn'` to burn them in, `'off'` to skip).

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
