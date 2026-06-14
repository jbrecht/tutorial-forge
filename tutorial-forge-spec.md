# tutorial-forge — Specification

> **⚠️ Historical design document.** This is the pre-v0.1 design spec, kept for context on *why* the system is shaped the way it is. It is **not** current user documentation and some details have since changed (final package names, the full CLI flag set, the dropped Umami framing). For authoritative, up-to-date guidance see **[README.md](README.md)**, the **[docs/](docs/)** guides (`getting-started`, `writing-tutorials`, `adapters`), and **[CHANGELOG.md](CHANGELOG.md)**. Where this document and those disagree, those win.
>
> **Names as shipped:** library `tutorial-forge`, CLI package `tutorial-forge-cli`, binary `tutorial-forge` (alias `tforge`). The original spec used a `forge` binary throughout; read the `forge <cmd>` examples below as `tutorial-forge <cmd>`.

## 1. What this is

`tutorial-forge` is a standalone, app-agnostic TypeScript library + CLI that turns scripted Playwright walkthroughs into finished, narrated tutorial videos (MP4). A consuming application (first consumer: **Umami**, an event-management app) installs it as a dev dependency, supplies (a) a small **adapter** that gets the app into a known state and (b) one or more **tutorial specs** (ordered steps, each pairing a narration line with a Playwright action). The library does everything else: TTS narration, browser driving, screen recording, timing synchronization, subtitles, cursor/callout rendering, and the final FFmpeg merge.

The core value proposition: **tutorials are source code.** When the app's UI changes, you re-run the pipeline instead of re-recording. Tutorials live in the consuming app's repo, are reviewed in PRs, and can regenerate in CI.

### 1.1 Design principles

1. **App-agnostic core.** The library never imports from, links against, or assumes anything about a consuming app. All app knowledge arrives through the `TutorialAdapter` and the tutorial specs.
2. **Raw Playwright in steps.** Step callbacks receive the real Playwright `Page`. We do not wrap or re-invent Playwright's API. The `step()` wrapper exists only to mark step boundaries for timing, subtitles, and callouts.
3. **Narration drives pacing.** TTS audio is generated and measured *first*; the browser then holds each step on screen at least as long as its narration clip. Never the reverse.
4. **Deterministic and CI-friendly.** Headless by default, fixed viewport, seeded state via the adapter, content-hashed TTS caching. Same inputs → same video (modulo TTS provider nondeterminism, which caching also mitigates).
5. **Every stage inspectable.** Intermediate artifacts (per-step audio, raw webm, timing manifest JSON, SRT) are written to a work directory and kept on failure.

### 1.2 Non-goals (v1)

- No interactive/HTML demos (Arcade/Supademo style) — output is video files.
- No AI *generation* of tutorial flows or narration text. (Narration text is authored — possibly by an LLM — but outside this tool. The spec format should be trivially LLM-writable, which it is: it's TypeScript.)
- No video editor UI. The pipeline is code/CLI only.
- No mobile/native app capture. Web apps via Playwright only.
- No music beds, intro/outro animations, or branding overlays (design the post stage so these can be added later without rework).
- No talking-head/avatar generation.

## 2. Repository layout

Standalone repo, pnpm workspace so the library, CLI, and example app stay separate packages with enforced import boundaries. Consumers install `tutorial-forge` from npm or via `pnpm link` / git dependency during development.

```
tutorial-forge/
├── package.json                  # workspace root, private
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .github/workflows/ci.yml     # typecheck, lint, unit tests, e2e render against example app
├── packages/
│   ├── core/                    # the library: "tutorial-forge"
│   │   ├── src/
│   │   │   ├── index.ts          # public API surface (re-exports only)
│   │   │   ├── types.ts          # Tutorial, Step, TutorialAdapter, RenderOptions, TimingManifest
│   │   │   ├── spec.ts           # tutorial(), step() builders + validation
│   │   │   ├── pipeline/
│   │   │   │   ├── render.ts     # orchestrator: tts → record → post
│   │   │   │   ├── tts.ts        # narration synthesis phase
│   │   │   │   ├── record.ts     # Playwright driving + video capture phase
│   │   │   │   └── post.ts       # ffmpeg merge, subtitles, transcode phase
│   │   │   ├── tts/
│   │   │   │   ├── provider.ts   # TTSProvider interface
│   │   │   │   ├── elevenlabs.ts
│   │   │   │   ├── openai.ts
│   │   │   │   ├── piper.ts      # local/offline, used by CI and the example
│   │   │   │   ├── silent.ts     # generates silence of estimated duration; for tests
│   │   │   │   └── cache.ts      # content-hash audio cache
│   │   │   ├── browser/
│   │   │   │   ├── cursor.ts     # injected fake-cursor overlay (init script)
│   │   │   │   ├── callout.ts    # click-highlight overlay
│   │   │   │   └── timing.ts     # recording clock, step boundary capture
│   │   │   ├── post/
│   │   │   │   ├── ffmpeg.ts     # thin typed wrapper over ffmpeg/ffprobe invocations
│   │   │   │   └── subtitles.ts  # SRT generation from manifest
│   │   │   └── util/             # logger, fs helpers, hashing
│   │   └── test/                 # unit tests (timing math, SRT, cache, validation)
│   ├── cli/                      # "tutorial-forge-cli", bin: `forge`
│   │   └── src/
│   │       ├── main.ts           # arg parsing (commander or citty)
│   │       ├── render.ts         # `forge render <globs>`
│   │       ├── list.ts           # `forge list`
│   │       └── doctor.ts         # `forge doctor` — env checks (ffmpeg, playwright browsers)
│   └── example-app/              # tiny self-contained web app + tutorials; the dev/test target
│       ├── src/server.ts         # express static server, a 3-screen demo app w/ forms & nav
│       ├── tutorials/
│       │   └── getting-started.tutorial.ts
│       └── forge.config.ts
├── docs/
│   ├── getting-started.md
│   ├── writing-tutorials.md
│   └── adapters.md
└── README.md
```

**Why the example app is in-repo:** the library must be developable and CI-testable with zero knowledge of Umami. The example app is the contract test: if a tutorial renders correctly against it, the library works. Umami consumes the published/linked package and contributes nothing back but bug reports.

## 3. Domain model

All types live in `packages/core/src/types.ts` and are exported from the package root.

```ts
import type { Page } from 'playwright';

/** Gets the target app into a known, recordable state. The only app-specific code. */
export interface TutorialAdapter {
  /** Base URL of the running app, e.g. http://localhost:3000 */
  baseURL: string;
  /** Auth, seeding, navigation to a starting screen. Runs after page creation, before step 1. Excluded from the final video by default. */
  setup(page: Page): Promise<void>;
  /** Optional cleanup after recording (delete seeded data, logout). Never recorded. */
  teardown?(page: Page): Promise<void>;
}

export interface Step {
  /** Stable id, auto-derived from index if omitted. Used in manifest, cache keys, logs. */
  id?: string;
  /** The narration line spoken over this step. Plain text; may be ''. */
  narration: string;
  /** The action. Receives the raw Playwright Page. May be a no-op for pure-narration steps. */
  run: (page: Page) => Promise<void>;
  /** Optional readiness hook awaited after run(); use when auto-waiting isn't enough. */
  waitFor?: (page: Page) => Promise<void>;
  /** Extra hold time (ms) after both narration and action complete. Default 400. */
  settleMs?: number;
}

export interface Tutorial {
  id: string;             // slug, used for output filenames
  title: string;
  description?: string;
  steps: Step[];
}

export interface RenderOptions {
  tts: TTSProvider;
  output: string;                          // path to final .mp4
  workDir?: string;                        // default: .forge/<tutorial-id>/
  viewport?: { width: number; height: number };  // default 1920x1080
  headless?: boolean;                      // default true
  cursor?: boolean;                        // inject fake cursor, default true
  callouts?: boolean;                      // highlight clicked elements, default true
  subtitles?: 'burn' | 'sidecar' | 'off';  // default 'sidecar' (writes .srt next to mp4)
  leadInMs?: number;                       // silence before step narration starts, default 300
  keepWorkDir?: boolean;                   // default false on success, true on failure
}

export interface TTSProvider {
  /** Unique key for cache partitioning, e.g. "elevenlabs:daniel:eleven_turbo_v2" */
  cacheKey: string;
  /** Synthesize one narration line to a WAV/MP3 file; return its path. Duration is measured by the pipeline via ffprobe, not trusted from the provider. */
  synthesize(text: string, outPath: string): Promise<void>;
}

/** Written to workDir as manifest.json; the contract between record and post phases. */
export interface TimingManifest {
  tutorialId: string;
  fps: number;
  recordingStartEpochMs: number;
  steps: Array<{
    id: string;
    narration: string;
    audioFile: string | null;
    audioDurationMs: number;        // 0 for silent steps
    startMs: number;                // offset from video start
    actionStartMs: number;          // when run() began
    actionEndMs: number;            // when run()+waitFor resolved
    endMs: number;                  // when the step's hold completed
    callouts: Array<{ atMs: number; x: number; y: number; w: number; h: number }>;
  }>;
  totalDurationMs: number;
}
```

### 3.1 Spec builders

```ts
export function tutorial(idOrTitle: string, steps: Step[], meta?: Partial<Tutorial>): Tutorial;
export function step(narration: string, run: Step['run'], opts?: Partial<Step>): Step;
```

`tutorial()` validates: non-empty steps, unique step ids, narration strings free of SSML/control chars (warn, don't fail). Validation errors are thrown synchronously at spec-load time with the step index in the message — fail fast, before any browser launches.

A tutorial file is any TS/JS module whose default export is a `Tutorial` or `Tutorial[]`. The CLI discovers them by glob (default `**/*.tutorial.ts`).

## 4. The rendering pipeline

`render(tutorial, adapter, options)` runs three phases in order. Each phase reads/writes the work directory and the timing manifest; phases are independently re-runnable for debugging (`forge render --phase post` re-merges without re-recording).

```
┌─────────┐     ┌──────────┐     ┌──────────┐
│ 1. TTS  │ ──▶ │ 2. RECORD │ ──▶ │ 3. POST  │
└─────────┘     └──────────┘     └──────────┘
 audio files     raw .webm +      final .mp4
 + durations     manifest.json    (+ .srt)
```

### 4.1 Phase 1 — TTS (narration first)

For each step with non-empty narration:

1. Compute cache key: `sha256(provider.cacheKey + '\0' + narration)`.
2. On cache hit (`~/.cache/tutorial-forge/tts/<hash>.wav` or project-local `.forge/tts-cache/`, configurable), reuse.
3. On miss, call `provider.synthesize(text, path)`.
4. Measure exact duration with `ffprobe -show_entries format=duration`. **Always measure; never trust provider metadata.**

Output: `workDir/audio/step-<id>.wav` + durations recorded into a draft manifest. Steps with empty narration get `audioDurationMs: 0`.

This phase has no browser dependency and is fully parallelizable (bounded concurrency, default 4; ElevenLabs rate limits apply).

### 4.2 Phase 2 — Record

1. Launch Chromium (headless default), new context with `recordVideo: { dir, size: viewport }`, fixed viewport, `deviceScaleFactor: 2` for crisp text (downscale in post).
2. If `cursor: true`, register an init script that renders a fake cursor (a positioned `<div>` with a high z-index and CSS transition) and monkey-patches nothing — instead the pipeline moves it explicitly: before each `click`/`hover`-like interaction, the library exposes `forgeCursor.moveTo(x,y)` via `page.evaluate`, animated over ~350ms. (Playwright fires real input events but renders no cursor; this is the standard workaround.)
3. **Clock zero:** `recordingStartEpochMs = Date.now()` captured immediately *after* `context.newPage()` resolves and a first dummy frame is painted (navigate to `about:blank`, `page.waitForTimeout(250)`). All manifest offsets are relative to this. Known risk: Playwright's video begins at context creation, not at clock-zero capture; see §7 Risks for the calibration strategy.
4. Run `adapter.setup(page)`. Setup time is recorded on video but the manifest marks it as pre-roll; post phase trims everything before step 1's `startMs` (minus `leadInMs`).
5. For each step, sequentially:
   a. Record `startMs`.
   b. Start a timer for `audioDurationMs + leadInMs` ("narration budget").
   c. After `leadInMs`, run `step.run(page)` — recording `actionStartMs`. If the step performs a click and `callouts: true`, the click target's bounding box is captured (see §5.2) and appended to the manifest's callout list.
   d. Await `run()`, then `step.waitFor?.(page)`, then Playwright default settling. Record `actionEndMs`.
   e. Hold until **max(narration budget, action completion) + settleMs**. Record `endMs`.
6. After the last step: hold 1s, run `adapter.teardown?.()`, close context (flushes the .webm), save final `manifest.json`.

Action errors: a step failure aborts recording, screenshots the failure state to `workDir/failure-<stepId>.png`, keeps the partial webm + manifest, and throws a `StepError { tutorialId, stepId, cause }`.

### 4.3 Phase 3 — Post (FFmpeg)

Inputs: raw `.webm`, `manifest.json`, `audio/*.wav`. All FFmpeg work happens in (ideally) a single filter-graph invocation; the `ffmpeg.ts` wrapper builds the arg list and shells out (`execa`). Require ffmpeg ≥ 6 on PATH; `forge doctor` verifies.

1. **Audio track assembly:** place each step's clip at its manifest `startMs + leadInMs` using `adelay`, then `amix`/`concat` over a silent base track of `totalDurationMs`. Narration clips never overlap by construction (the record phase held each step for its narration budget).
2. **Trim pre-roll:** cut video before `steps[0].startMs - leadInMs`.
3. **Subtitles:** generate SRT from manifest (one cue per step: text = narration, range = `startMs+leadInMs → startMs+leadInMs+audioDurationMs`, wrapped at ~42 chars/line). `burn` → `subtitles=` filter; `sidecar` → write `.srt` beside output; `off` → skip.
4. **Transcode:** H.264 (`libx264, crf 18, preset slow, yuv420p`), AAC 192k, downscale 2x→1x viewport, `-movflags +faststart`. Output to `options.output`.

Deferred-but-designed-for (the filter graph builder should keep these as composable stages, each `(inputLabel) → (outputLabel)`): idle speed-up (retiming via manifest gaps), zoom-on-callout, intro/outro cards.

## 5. Browser presentation details

### 5.1 Fake cursor

A single injected element: 24px SVG arrow, subtle drop shadow, `transition: transform 350ms cubic-bezier(.25,.1,.25,1)`. On click: a 300ms radial pulse animation at the click point. Implemented purely in injected CSS/JS (`browser/cursor.ts`), namespaced (`#__forge_cursor__`), `pointer-events: none`, excluded from screenshots-based assertions (not our concern, but documented). The library intercepts its *own* high-level helpers only — since steps use raw Playwright, cursor movement is driven by instrumenting `page` via a Proxy that wraps `Locator.click/hover/fill/check/selectOption` to (1) resolve the target's bounding box, (2) animate the cursor there, (3) emit a callout record, then (4) delegate to the real method. If the Proxy fails to wrap an exotic call path, the action still works — cursor just doesn't move. **Graceful degradation, never interference.**

### 5.2 Callouts

When an instrumented interaction resolves its target's bounding box, the record phase appends `{atMs, x, y, w, h}` to the manifest. Default rendering happens **live in the browser** (a brief 600ms rounded-rect highlight ring injected around the target just before the click) so the raw webm already contains it — this avoids post-phase compositing in v1. The manifest data still exists so a later version can move callout rendering to post (sharper, retimable).

## 6. CLI

```
forge render [globs...]      # default **/*.tutorial.ts; --only <id>, --phase tts|record|post|all,
                             # --headed, --keep-work, --out-dir, --concurrency
forge list                   # discovered tutorials: id, title, step count
forge doctor                 # checks: node version, ffmpeg/ffprobe on PATH + version,
                             # playwright browsers installed, TTS provider env vars present
forge clean                  # removes .forge/ work dirs and optionally tts cache
```

Configuration via `forge.config.ts` in the consumer repo (loaded with `jiti`/`tsx`):

```ts
import { defineConfig, ElevenLabs } from 'tutorial-forge';
import { umamiAdapter } from './e2e/umami-adapter';

export default defineConfig({
  adapter: umamiAdapter,
  tts: ElevenLabs({ voiceId: 'daniel', apiKey: process.env.ELEVENLABS_API_KEY }),
  outDir: 'tutorials/dist',
  tutorials: ['tutorials/**/*.tutorial.ts'],
  viewport: { width: 1920, height: 1080 },
});
```

CLI flags override config; config overrides defaults. `render()` remains directly importable for programmatic use (CI scripts) — the CLI is a thin shell over it.

## 7. Risks & explicit engineering notes

1. **Video clock alignment (the #1 known hard problem).** Playwright's `recordVideo` starts capturing at context creation and its first-frame timestamp is not exposed. Mitigation, in order of preference: (a) **calibration flash** — at clock-zero, paint a single magenta frame via `about:blank` body background for 100ms; the post phase scans the first 2s of the webm with ffmpeg's `blackdetect`-style approach (a tiny `signalstats` scan) to find the flash and derive the true offset; (b) if (a) proves flaky, switch capture to `page.screencast()` (Playwright ≥ 1.59) where frame timestamps are explicit, assembling video in post from frames. Build (a) first; isolate capture behind an interface (`Recorder`) so (b) is a swap, not a rewrite.
2. **TTS variability.** Provider latency/rate limits → bounded concurrency + cache. Provider audio formats vary → normalize everything to 48kHz mono WAV immediately after synthesis.
3. **App readiness leaks.** Playwright auto-waiting covers most cases; the `waitFor` hook is the escape hatch. Document the pattern: prefer `expect(locator).toBeVisible()`-style waits inside `run`/`waitFor` over timeouts.
4. **Headless rendering differences.** Use `chromium` new headless (`channel: 'chromium'`); fonts in CI containers must include a sane default set — document installing `fonts-liberation` + `fonts-noto-color-emoji` in CI.
5. **Long tutorials & memory.** Webm recording of 5+ minutes is fine; per-step audio is small. No special handling needed in v1; note `forge render --only` for iterating on one tutorial.

## 8. Testing strategy

- **Unit (vitest):** timing math (budget/hold computation), SRT generation from fixture manifests, cache key hashing, spec validation, ffmpeg arg-list builder (assert on generated args, don't run ffmpeg).
- **Integration:** TTS phase against `SilentProvider` (deterministic durations from a word-count heuristic: `max(1200, words * 380)` ms — also the fallback duration estimator).
- **E2E (CI):** boot `example-app`, render `getting-started.tutorial.ts` headless with `SilentProvider` + Piper (if available), assert: exit 0, output mp4 exists, duration within ±5% of manifest `totalDurationMs`, srt cue count == narrated step count. Golden-file test on the manifest (timestamps fuzzy-matched).
- The example app intentionally exercises: navigation, form fill, select, modal open/close, a slow async operation (to test `waitFor`), and a pure-narration step.

## 9. Build order (suggested milestones for Claude Code)

1. **M1 — Skeleton + silent video.** Workspace scaffolding, types, spec builders + validation, record phase with manifest, example app, `forge render` producing an un-narrated mp4 (post phase = trim + transcode only). E2E test green in CI.
2. **M2 — Narration.** TTS provider interface, Silent + Piper + ElevenLabs providers, cache, audio assembly in post, narration-budget pacing in record. SRT sidecar.
3. **M3 — Presentation.** Fake cursor + click pulse, live callout ring, calibration flash + offset detection, `deviceScaleFactor: 2` pipeline.
4. **M4 — DX.** `forge doctor`, `forge list`, `--phase` re-runs, failure screenshots, docs (`getting-started`, `writing-tutorials`, `adapters`), publish dry-run.
5. **M5 — Stretch.** Idle speed-up, burn-in subtitles styling, zoom-on-callout, `Recorder` swap to `page.screencast()` if calibration is unreliable.

Each milestone must leave `pnpm test` and the CI e2e green. Do not start M3 until M2's e2e renders a narrated video of the example app.

## 10. Dependencies (core)

playwright (^1.59, peer), execa, zod (config/spec validation), commander or citty (cli), jiti or tsx (config loading), vitest (dev). **No ffmpeg npm wrapper** — shell out to system ffmpeg; wrappers lag and obscure filter graphs. Node ≥ 20. ESM-only.

## 11. Acceptance criteria for v1

Running `pnpm forge render` inside `packages/example-app` with no flags produces, in under 3 minutes on a laptop, a 1080p MP4 with: synchronized AI narration for every narrated step, a visible animated cursor, click highlights, a sidecar SRT whose cues match the narration, and a manifest.json that fully describes the timeline — using zero example-app-specific code inside `packages/core`.
