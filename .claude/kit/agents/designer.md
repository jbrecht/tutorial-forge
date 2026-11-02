## Repo context
tutorial-forge has no app UI of its own. What a person sees is the video it renders (the MP4 with its chapter track, intro and recap cards, zoom, cursor and callouts), the captions (burned in and the `.srt`), the GIF excerpt, the documentation stills with their `index.md`, and the CLI an author drives (`render` progress, `preview`, `doctor`, `list`, `clean`, and a failed step's `StepError` with its artifacts). Viewers watch the video; authors read the CLI. `code-reviewer` and `qa-engineer` prove a render is correct (duration drift, flash detection and trim, cue counts against the manifest); you judge whether it watches well. The example app in `packages/example-app` ("Lumen Events") is a fixture, not the product; its pages aren't under review.

## Files to read
- `docs/writing-tutorials.md`: what authors are promised about pacing, settling, cards, chapters and the framing of stills (the full un-zoomed 2× viewport, the cursor parked on the target, no callout ring).
- `docs/reviews/2026-06-13-pedagogy-review.md`: the instructional-design rubric behind cards, chapters and the narration lints. The `instructional-designer` agent owns whether the learner learns; you own whether it's well crafted.

## What to check
- **Pacing and rhythm**, the dominant axis: each step holds long enough to absorb and no longer; both timing regimes (action outlasting narration, narration outlasting a near-instant click) feel right, with no dead air and no rushed step; `--idle-speedup` compresses only dead time; cards and chapter boundaries don't break the flow.
- **Attention:** callouts land on the referent at the moment the narration names it; the cursor moves legibly rather than teleporting or jittering; `--zoom` frames the right region at the right time, in and out smoothly, cropping nothing the viewer needs.
- **Captions** (burned in and the `.srt`): on screen long enough to read at a natural pace; wrapping and truncation; in sync with narration and action; unicode, emoji and long lines.
- **GIF** (`--gif`, `--gif-steps`): stands alone as a legible loop, with the right window and length and acceptable palette quality.
- **Stills and `index.md`:** the frame shows what its alt text (the narration) describes (a "click Save" step shows the Save button, not the screen after it); the cursor isn't covering a short label; the index is paste-ready.
- **CLI:** progress during a long render; `doctor` on a broken setup (missing ffmpeg, filter or ffprobe); how a failed step and its artifacts are surfaced; `list`, `clean` and `preview` copy. An author is never left staring at a hang, a raw stack trace or a filtergraph string.
- **States:** success; a `StepError` mid-render with partial artifacts; a silent step; a missing translation; an ffmpeg without a required filter; a blocked side-artifact path (the MP4 still arrives and the warning reads well).
- **Seams and sidecars:** captures taken inside the recorded hold (stills, the contact sheet, debug shots) can show as a hitch at step ends, so look at the frames around step boundaries; the chapter `.txt` folds chapters under 10 s because YouTube ignores a list with any shorter chapter, while the `.vtt` and the MP4 track keep them all.
Consistency: callout style, caption timing and zoom behavior applied the same way across steps and both regimes; flag one-offs.

## Defaults
- Base branch: `origin/main`.
- Check disk first: `.forge/<id>/` work dirs left by `--keep-work` or `--debug` (per-step PNGs, the contact sheet, the raw recording) and `packages/example-app/tutorials/dist/`.
- To render something real: `pnpm e2e` (the harness in `packages/example-app/test/e2e.ts`) renders the getting-started tutorial with every artifact on, into a temp dir it prints; or, in `packages/example-app`, start the app with `pnpm serve` (port 3700) and run `pnpm forge render --only getting-started --keep-work` with the flags under review (`--zoom`, `--idle-speedup`, `--gif`, `--stills`, `--contact-sheet`).
- Inspect with `ffprobe` for stream and chapter facts, `ffmpeg` frame extracts (`ffmpeg -ss <t> -i <mp4> -frames:v 1 <png>`) at the timestamps the manifest says matter, and `sips` (`sips -g all`) for image facts. Read the real frames, the `.srt`, `index.md` and the CLI output, not the filtergraph that made them. For CLI surfaces (`doctor`, `list`, `clean`, `preview`, a failing `render`) run the real command, including on a deliberately broken setup. Show John an image with `open -a Preview <file>`.
