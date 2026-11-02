## Repo context
tutorial-forge renders narrated tutorial videos from TypeScript specs: Playwright drives the app under test, a TTS provider narrates, and one ffmpeg pass assembles the MP4 plus its sidecars (`.srt`, chapters, cards, gif, documentation stills). The users are tutorial authors driving the library (`tutorial`, `step`, `StepContext`, `TutorialAdapter`, `defineConfig`, the TTS providers) and the CLI (`render`, `preview`, `list`, `doctor`, `clean`). There are no roles; the variation lives in the content (the tutorial) and the environment (ffmpeg, Playwright, the app under test). Two tiers:
- **vitest units**, in `packages/core/test/` and `packages/cli/test/`: they pin the pure helpers (timing, the ffmpeg, zoom, retime and gif arg builders, subtitle, caption, card and chapter logic, the stills index, i18n, caching, `mapLimit`, the CLI resolvers). Fast, deterministic, no browser; `cache.test.ts` needs ffmpeg on `PATH`.
- **the e2e render harness**, `packages/example-app/test/e2e.ts` (`pnpm e2e`, about three minutes): boots the example app on a free port, renders real tutorials headless with `SilentProvider`, and asserts on the artifacts: the mp4 exists, duration within ±5% of the manifest, srt cue count matches narrated steps, callouts captured, the calibration flash detected then trimmed, chapters, cards, stills, preview, teardown order and the failure path. It is the integration gate, and it imports some internal modules by source path.
Most corner cases reduce to a pure helper; an e2e addition must earn its runtime.

## Files to read
- `packages/core/src/index.ts` and `packages/cli/src/main.ts`: the author-facing surface.
- `docs/writing-tutorials.md` and `docs/adapters.md`: what authors are promised, including the parallel-rendering adapter contract.

## What to check
Walk the render as an author would:
- **Timing regimes:** action faster than narration; action far longer than narration; a silent (zero-audio) step; back-to-back steps with no settle; seconds of narration over a near-instant click. `--idle-speedup` must compress dead time only, never the narration.
- **Composition:** zoom + idle-speedup + burned-in captions + cards + chapters + gif + stills + contact sheet on one render: each pair, then all together; the filtergraph has to compose.
- **i18n:** a language whose narration is much longer or shorter than the source; a missing translation; step ids and stills filenames stable across languages.
- **TTS:** provider failure or timeout; empty or whitespace narration; cache hit vs miss; `SilentProvider` through the whole pipeline; unicode and emoji; very long narration; two renders synthesizing the same line at once.
- **Recording:** the flash not detected (`null`) versus detected at offset `0`, which is valid; the flash not trimmed; `--recorder video` vs `screencast` parity; a callout or cursor target that never appears; the app throwing or hanging mid-step (`StepError`, failure artifacts, teardown still runs); a work dir (`.forge/<id>/`) reused from an earlier run, so stale `steps/` frames; `--render-concurrency` above 1 with one job failing or duplicate languages.
- **Side artifacts:** a blocked or unwritable stills, gif or contact-sheet path still yields the MP4 and a readable warning; a re-export merges with what's there and prunes only files it wrote (an author's `03-save-annotated.png` survives); unsafe step ids (`save draft`, `../escaped`); a selection that matches nothing fails loudly.
- **Environment:** ffmpeg missing or lacking a filter (the `ffmpegHasFilter` fallback); ffprobe missing; `doctor` and `doctor --setup` on a broken setup; output dir not writable; work-dir collision between jobs; `--keep-work`/`--debug` artifact contents.
- **Windowing** (`--gif-steps`, `--stills-steps`): a single id, a `from..to` range, an unknown id, a reversed range, a range spanning a sped-up idle segment, `a..b..c`.
- **Boundaries:** one step; no narrated steps; many callouts; drift right at the ±5% threshold; a 12k-node page (capture cost tracks page weight, and a step with no hold slack is lengthened).
P0 here means a render that silently ships a wrong video (drift, a wrong frame or caption), publishes stale frames, deletes an author's files, or loses the MP4.
A test proves the fix only if it runs the changed line: with the fix reverted it must go red. Behavior verified live against the example app gets folded into `e2e.ts` as a durable assertion; throwaway scripts and rendered artifacts are deleted.
Writing tests: match the style in `packages/core/test/` (vitest `describe/it`, helpers imported from `../src/*.js`). An e2e addition extends `packages/example-app/test/e2e.ts`'s assert-based style, renders headless with `SilentProvider`, and removes its temp work dir.

## Defaults
- Base branch: `origin/main`.
- Unit tests: `pnpm --filter tutorial-forge test` (append a file name to narrow it) and `pnpm --filter tutorial-forge-cli test`. End to end: `pnpm e2e`; don't start it while another render is running on this machine.
- No coverage tool is installed: map coverage by grepping the tests against the source.
