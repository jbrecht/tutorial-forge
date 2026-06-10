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
tutorial-forge clean --cache            # remove work dirs and the TTS cache
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
