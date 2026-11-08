## Repo context
tutorial-forge is a source-available (PolyForm Small Business) TypeScript library and CLI, published to npm as `tutorial-forge` and `tutorial-forge-cli` in lockstep, that renders narrated tutorial videos from code-defined specs: Playwright drives the app, a TTS provider narrates, ffmpeg assembles. Its users are tutorial authors who install it (umami, John's community app, is the dogfooding consumer; its tutorials live in the umami repo) and the maintainer, John, who ships it. Think in author journeys (authoring a tutorial, rendering, fixing timing, localizing, exporting a GIF or documentation stills, publishing the video), in output quality (does the video watch well and teach) and in setup friction (`doctor`, ffmpeg, adapters). The decisions report is for the maintainer deciding direction: product terms, no internals.

## Files to read
- `CHANGELOG.md`: what shipped and in which version. The project ships small versions often, so issues go stale quickly.
- `packages/cli/src/main.ts` (commands and flags) and `packages/core/src/index.ts` (exports): the source of truth for what exists. Cite the file, version or PR when reclassifying an issue as done.
- `docs/reviews/2026-06-13-pedagogy-review.md`: the pedagogical direction. The `instructional-designer` agent recommends; you weigh its recommendations against everything else and turn them into issues.

## What to check
- Settled decisions, besides the Decision lines in the issues: the license stays PolyForm Small Business (since 0.11.1); rendering is serial by default, with concurrency opt-in under the adapter contract in `docs/adapters.md`; `--stills` was parked and removed from `main` after two umami trials, and its redesign is #82's sub-issues (#88 → #89 → #90), whose Decision lines settle the release, default frame, video fidelity and crop control; a filenames option and `capture: 'both'` stay out of scope.
- Where new issues come from: umami's dogfooding, the reviewers' reports (qa-engineer, performance-engineer, designer), the instructional-designer's recommendations, and launch feedback.

## Defaults
- The roadmap is the "tutorial-forge Roadmap" Project, set up 2026-11-08 (CLAUDE.md › Roadmap). Read it with `roadmap.sh plan` and `roadmap.sh milestones`.
