# Pedagogy review — tutorial-forge (2026-06-13)

Reviewer: instructional-designer (advisory). Scope: do the docs and authoring model help
authors produce tutorials that *teach*, and where should the tool go next to make the
*tutorials it produces* more effective at training people on complex software? Video craft
and factual accuracy are out of scope (audited separately). Recommendations go to the
product-manager; no issues filed.

Reviewed: README.md, docs/getting-started.md, docs/writing-tutorials.md, docs/adapters.md,
packages/example-app/tutorials/getting-started.tutorial.ts, tutorial-forge-spec.md (context).

Evaluated against established multimedia-learning and cognitive-load principles
(Mayer's segmenting, signaling, modality, redundancy, coherence, pre-training,
temporal-contiguity; Sweller's intrinsic/extraneous/germane load; Merrill's
worked-example→practice progression).

---

## Headline

tutorial-forge is **engineering-excellent and pedagogy-silent.** The *machine* embodies
several of the strongest evidence-based learning principles almost by accident of good
engineering — but the *documentation* teaches authors only how to drive the machine, not
how to write something that teaches. The result: the tool makes it easy to produce a
technically-correct video and gives almost no help producing an *instructionally* good one.
The single biggest lever is that step boundaries are already first-class in the timing
manifest, so most high-impact pedagogy features are cheap additions, not rewrites.

---

## Part 1 — Pedagogy review of the docs

### What the architecture gets right (credit where due)

- **Narration-first pacing honors temporal contiguity and coherence.**
  writing-tutorials.md:59-61 — narration is synthesized and measured first, and each step
  holds on screen at least as long as its line. Audio and the corresponding visual
  co-occur (temporal-contiguity principle), and there's no dead air or rushed-past visual.
  This is a genuinely strong pedagogical foundation that most screen-recording tools get
  wrong (they retime voiceover onto a fixed recording).
- **Signaling is first-class and well-built.** Fake cursor, click callouts, `--zoom`
  toward targets, and `opts.focus` to anchor attention (writing-tutorials.md:30, 44-54;
  getting-started.md:85) are a textbook implementation of the signaling/cueing principle —
  directing the learner's eye to the essential element and suppressing everything else.
- **Extraneous load reduction.** `--idle-speedup` (getting-started.md:89) removes dead
  waiting; pre-roll trimming removes setup. Both cut extraneous cognitive load.
- **Modality principle honored (silently).** Narration is audio, not on-screen prose, so
  the visual channel isn't competing with on-screen text. Good — but unstated, so an author
  who starts pasting paragraphs of on-screen text wouldn't know they're breaking it.
- **Localization respects speech-rate differences** (writing-tutorials.md:155): each
  language re-derives pacing from its actual narration duration. Equity *and* correctness.
- **Determinism / seeded state** (adapters.md:119) gives consistent, repeatable worked
  examples — the same demo every time.

### Where the docs steer authors away from teaching (the gaps)

1. **Narration guidance is one sentence — the highest-leverage teaching surface is
   undocumented.** writing-tutorials.md:29 defines narration as "the line spoken over this
   step. Plain text (no SSML). May be `''`." That's it. There is no guidance on *how to
   write a line that teaches*: explain the *why* not just the *what*, one idea per step,
   use signaling language ("notice…", "here…"), write for the ear (short sentences), not
   for reading. Ironically the example models this well —
   "Give the event a descriptive name. **This is what attendees will see on their
   invitations**" (getting-started.tutorial.ts:30) explains *why* — but the docs never
   extract that as a principle, so it's luck, not guidance.

2. **No guidance on step granularity / segmenting** — the single most impactful
   multimedia principle. The docs treat a "step" as a purely mechanical unit (a narration
   line + an action) and never tell authors how much one step should carry. The example
   shows the inconsistency this produces: "open the Events page" is one click
   (getting-started.tutorial.ts:14-20) while the Settings step does nav + heading-wait +
   checkbox in a single step/line (getting-started.tutorial.ts:60-67). Segmenting theory
   says one conceptual chunk per segment, learner able to absorb before the next. Authors
   get no help chunking a complex procedure.

3. **No learning-objective / advance-organizer pattern.** The example opens with a decent
   advance organizer in narration ("In this short tour, we will create your first event and
   adjust a workspace setting," getting-started.tutorial.ts:5) and closes with a recap
   ("Your event is drafted, your workspace is configured…", :70). Both are good practice —
   and both are invisible to the docs. There's no `Tutorial.objectives`, no documented
   "open with what they'll be able to do, close with a recap" pattern. Pre-training and
   advance-organizer effects go unsupported.

4. **Captions are framed purely as subtitles, with no redundancy nuance.**
   getting-started.md:83 — captions are verbatim narration, burn or sidecar. For
   accessibility this is correct and should stay the default. But the docs present no
   awareness that verbatim captions + identical audio is the *redundancy* condition (can
   add load for sound-on learners), and offer no alternative (e.g. key-term captions). The
   tension between the redundancy principle and accessibility is real and worth naming.

5. **The README frames the value proposition as maintenance, not learning.** "How it
   compares" (README.md:62-67) and the whole pitch center on *freshness* — tutorials-as-
   code, regenerate in CI, never go stale. That's a real and excellent DevEx win, but it
   reveals the project's center of gravity: "keep the video from going stale," not "make a
   video that teaches well." Nothing here is wrong; it's the strategic gap that Part 2
   addresses. A maintained-but-mediocre tutorial is still mediocre.

### Inherent limit (not a doc bug, but the ceiling)

The output is a linear MP4: a **worked example** the learner *watches*. There is no
practice, no retrieval, no learner pacing within the video, no faded guidance — all of
which the evidence says drive durable skill acquisition for procedural software tasks.
This is the natural ceiling of "video," and it's where the most ambitious Part 2 ideas aim.

---

## Part 2 — New directions (prioritized by pedagogical impact)

Architecture in play: narration-first pipeline; a **timing manifest** with first-class
per-step boundaries, action windows, audio durations, and callout boxes; a post-stage
ffmpeg filter graph; the adapter model. Step boundaries already being in the manifest is
the key lever — several high-impact features are new *consumers* of data that already
exists.

| # | Direction | Impact | Feasibility | Why it teaches |
|---|---|---|---|---|
| 1 | **Chapters / segmenting** | High | High | Segmenting principle — the strongest, cheapest win |
| 2 | **Teaching-narration guidance + germane lints** | High | High | Multiplies quality of every tutorial authored |
| 3 | **Objective + recap cards (first-class)** | High | Medium | Advance-organizer, pre-training, summary |
| 4 | **Interactive HTML output w/ knowledge checks** | High | Low | Retrieval practice / generative learning — highest ceiling |
| 5 | **Caption modes (verbatim vs key-term)** | Medium | High | Resolves redundancy vs accessibility |
| 6 | **Accessibility-as-pedagogy pass** | Medium | Medium | Universal design helps all learners |
| 7 | **Effectiveness instrumentation** | Medium | Low (core) | Closes the loop: did it actually teach? |
| 8 | **Faded-practice "your turn" mode** | High | Low | Watch→do; the spec is already the checker |

### 1. Chapters / segmenting — *do this first*
The manifest already has per-step start/end. Emit **MP4 chapter markers** (ffmpeg metadata
/ chapter file) and/or a **WebVTT chapters track** plus a YouTube-style timestamp list in
output. Optionally let authors group steps into named sections (a `section?: string` on
step, or a `chapter('name', [...steps])` grouping). This gives learners navigation and
self-pacing *within* a single video — the segmenting effect, one of the largest and most
reliable in the literature — at near-zero cost. Highest impact-to-effort ratio in the list.

### 2. Teaching-narration guidance + germane lints
Add a "Writing narration that teaches" section to writing-tutorials.md (right after the
one-line narration bullet at :29): one idea per step; explain *why*, not only *what*; use
signaling language; open with an objective, close with a recap; write for the ear. Then
back the most objective of these with **optional load-time warnings** — the validation
infra already runs at spec load (writing-tutorials.md:182-183): warn on over-long
narration per step (overload), steps bundling multiple unrelated actions (segmenting), and
a missing intro/recap step. Cheap; multiplies the quality of every tutorial anyone authors.

### 3. Objective + recap cards as first-class artifacts
Add `objectives?: string[]` (and/or `summary?`) to the `Tutorial` type and render an
optional **title/objective card** at the start and a **recap card** at the end. The spec
already lists intro/outro cards as a "deferred-but-designed-for" post stage
(tutorial-forge-spec.md:223), and the caption system already renders browser HTML →
composited frames, so the rendering path exists. Serves the advance-organizer,
pre-training, and summary principles, and makes the good practice the example already
models (getting-started.tutorial.ts:5, :70) explicit and reusable rather than incidental.

### 4. Interactive HTML output with knowledge checks — *the high-ceiling bet*
A pure MP4 can't do retrieval practice, the single biggest driver of durable learning. A
new **HTML output target** that wraps the rendered video with chapter navigation (from #1)
and authored **knowledge-check questions between chapters** would add generative/retrieval
activity — the thing video structurally can't. The v1 spec explicitly excluded HTML demos
(tutorial-forge-spec.md:21); this is the right time to revisit that as a *complement*, not
a replacement. Biggest architectural lift here, so frame it as a longer-term initiative —
but the timing manifest makes the chaptered player itself very feasible; the questions are
the new authoring surface.

### 5. Caption modes: verbatim vs. key-term
Offer `captions: 'full' | 'keyterms' | 'off'` (today it's effectively full-or-off,
getting-started.md:83). `keyterms` surfaces only signaled labels/vocabulary instead of the
full sentence — reducing redundancy load for sound-on learners while still teaching the
vocabulary (a pre-training flavor), with `full` remaining the accessible default. Feasible:
caption text is already per-step.

### 6. Accessibility-as-pedagogy pass
Guidance + light defaults: never narrate "click here" — name *what* and *where* (also
serves sound-off and low-vision learners); legible caption defaults (styling already
exists via `captionStyle`); flag steps whose narration is purely deictic. Universal-design
moves measurably help *all* learners, not only those who need them.

### 7. Effectiveness instrumentation
The project today optimizes "the video doesn't go stale" but can't answer "did it teach?"
If output ships with chapter markers (#1) and an analytics-friendly player (#4), consumers
can measure per-chapter drop-off, replays, and completion — turning segment boundaries into
a learning signal. Out of scope for the core MP4 encoder, but the natural strategic
destination: close the loop from *maintained* to *effective*.

### 8. Faded-practice "your turn" mode — *the striking architectural synergy*
Procedural skill comes from watch→do, not watch alone. Because a tutorial is *already an
executable Playwright spec*, the same spec could generate a **guided-practice mode**: run
the real app, prompt the learner to perform each step themselves, and validate with the
same locators the demo uses. The spec is simultaneously the demonstration *and* the checker
— a synergy no recording-based tool can match. Big lift, research-grade, but the highest
learning ceiling in this list, paired with #4.

---

## Recommendation to the product-manager

- **Now / cheap / high-impact:** #1 (chapters) and #2 (narration guidance + lints). Both
  are small, ride existing infrastructure (manifest, load-time validation, docs), and lift
  every tutorial. Recommend filing these as near-term issues.
- **Next:** #3 (objective/recap cards) and #5 (caption modes) — modest post-stage and
  config work, clear pedagogical payoff.
- **Strategic bets (RFC / spike first):** #4 (interactive HTML + knowledge checks),
  #8 (faded-practice mode), #7 (instrumentation). These move the product from "videos that
  don't go stale" to "training that demonstrably works," and #4/#8 are where the largest
  learning gains live. They warrant a design doc before committing.

The throughline: the engine already does the hard, load-bearing pedagogy (pacing,
signaling, coherence). The cheapest wins are teaching authors to use it well (#2) and
surfacing the structure the manifest already knows (#1, #3). The biggest wins are adding
the one thing video fundamentally lacks — learner activity (#4, #8).
