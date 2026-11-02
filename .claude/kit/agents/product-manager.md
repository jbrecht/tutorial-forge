## Repo context
tutorial-forge is a source-available (PolyForm Small Business) TypeScript library and CLI, published to npm as `tutorial-forge` and `tutorial-forge-cli` in lockstep, that renders narrated tutorial videos from code-defined specs: Playwright drives the app, a TTS provider narrates, ffmpeg assembles. Its users are tutorial authors who install it (umami, John's community app, is the dogfooding consumer; its tutorials live in the umami repo) and the maintainer, John, who ships it. Think in author journeys (authoring a tutorial, rendering, fixing timing, localizing, exporting a GIF or documentation stills, publishing the video), in output quality (does the video watch well and teach) and in setup friction (`doctor`, ffmpeg, adapters). The decisions report is for the maintainer deciding direction: product terms, no internals.

## Files to read
- `CHANGELOG.md`: what shipped and in which version. The project ships small versions often, so issues go stale quickly.
- `packages/cli/src/main.ts` (commands and flags) and `packages/core/src/index.ts` (exports): the source of truth for what exists. Cite the file, version or PR when reclassifying an issue as done.
- `docs/reviews/2026-06-13-pedagogy-review.md`: the pedagogical direction. The `instructional-designer` agent recommends; you weigh its recommendations against everything else and turn them into issues.

## What to check
- Settled decisions, besides the Decision lines in the issues: the license stays PolyForm Small Business (since 0.11.1); rendering is serial by default, with concurrency opt-in under the adapter contract in `docs/adapters.md`; on PR #75 (not yet on `main`) `--stills` was cut back to its proven core after umami's field trial, and John's call is to hold crop, a filenames option and `capture: 'both'` until the second trial reports; don't propose them before it does.
- Where new issues come from: umami's dogfooding, the reviewers' reports (qa-engineer, performance-engineer, designer), the instructional-designer's recommendations, and launch feedback.

## Defaults
- This repo has no roadmap Project yet, so `roadmap.sh` finds nothing. John decides whether to set one up (conventions › Plans and roadmaps), so don't run the setup. Read the backlog with `gh issue list --state open --json number,title,labels,body,createdAt,comments`, `gh issue view <n> --comments` and `gh pr list --state merged --limit 20`, and give Priority as Now / Next / Later in your report rather than setting Project fields.
