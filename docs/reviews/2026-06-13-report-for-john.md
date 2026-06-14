# Report for John — docs cleanup, pedagogy review & backlog triage

**Date:** 2026-06-13
**Prepared by:** Claude Code, with the product-manager and instructional-designer agents

This session ran end-to-end: a documentation audit → fixes → an instructional-design
review of the docs → backlog triage of the resulting ideas. Here's everything that
happened and where it leaves you.

---

## 1. Documentation audit & fixes

A product-manager audit found the **user-facing docs are current and accurate** with the
shipped 0.10.0 surface (README, the three `docs/` guides, package READMEs, CHANGELOG,
agents README — no drift). Two stray, non-user-facing artifacts were the only real gaps,
both now fixed:

| Fix | What changed | Issue |
|---|---|---|
| Historical-spec banner | Added a prominent "Historical design document" banner to `tutorial-forge-spec.md` — marks it pre-v0.1, settles final names (`tutorial-forge` / `tutorial-forge-cli` / bin `tutorial-forge`+`tforge`), points to README/docs/CHANGELOG as authoritative | #33 (closed) |
| Stray review report moved | `ISSUE-ACTION-REPORT.md` → `docs/reviews/2026-06-13-issue-action-report.md` | #34 (closed) |
| Render-flag coverage | Documented `--out-dir` and `--concurrency` in `docs/getting-started.md` (verified against `render.ts`) | — |

Repo root is now clean: `README.md`, `CHANGELOG.md`, `tutorial-forge-spec.md`.
**These changes are in the working tree, uncommitted.**

---

## 2. Pedagogy review (instructional-designer)

Full review: [`docs/reviews/2026-06-13-pedagogy-review.md`](2026-06-13-pedagogy-review.md).

**Headline: the engine is pedagogy-strong; the docs are pedagogy-silent.** The pipeline
already embodies several of the strongest evidence-based learning principles by good
engineering — but the documentation teaches authors how to drive the machine, not how to
write something that *teaches*.

**Already right (credit):** narration-first pacing (temporal contiguity + coherence);
cursor/callouts/zoom/focus (signaling); idle-speedup + pre-roll trim (extraneous-load
reduction); per-language pacing (equity).

**Gaps:**
1. Narration guidance is *one sentence* — the highest-leverage teaching surface is
   undocumented.
2. No guidance on **step granularity / segmenting** (the most impactful principle); the
   example tutorial is itself inconsistent.
3. No **objective / recap** pattern documented (the example models both but never names
   them).
4. Captions framed purely as verbatim subtitles — no redundancy-vs-accessibility nuance.
5. The README pitch centers on *freshness/maintenance*, not *learning* — the strategic gap.

**Inherent ceiling:** the output is a linear MP4 — a worked example you *watch*. No
practice, no retrieval, no learner pacing. That ceiling is where the boldest ideas aim.

---

## 3. Backlog triage (product-manager)

The PM spot-checked the review's feasibility claims against the code (all three held: the
manifest carries per-step boundaries `types.ts:188-203`; load-time validation exists
`spec.ts:21-60`; intro/outro cards are pre-designed `spec.md:223` + the card-render path
exists in `post/captions.ts`) and **filed 5 issues**:

| # | Title | Bucket | Labels |
|---|---|---|---|
| **#35** | Chapters / segmenting from per-step manifest | **Now** | enhancement |
| **#36** | Teaching-narration guidance + germane load-time lints | **Now** | documentation, enhancement |
| **#37** | Objective + recap cards as first-class artifacts | **Next** | enhancement |
| **#38** | Caption modes: verbatim vs. key-term | **Next** | enhancement |
| **#39** | RFC / roadmap: from "maintained" to "effective" | **Later** | enhancement, question |

**PM judgment calls:**
- The three strategic bets (interactive HTML output, faded-practice mode, effectiveness
  instrumentation) were **merged into one RFC/roadmap issue (#39)** — they're
  interdependent (all presuppose a shared chaptered web player), not parallel, and reduce
  to one upstream decision: *does the project expand beyond video?*
- Accessibility-as-pedagogy (#6 in the review) was **folded into #36** rather than filed
  separately (heavy overlap; `captionStyle` already exists). Can be split out if you want
  it tracked as its own audit workstream.
- An API correction was baked into the issues: the review said `captions:`; the real field
  is `subtitles: 'burn' | 'sidecar' | 'off'` (`types.ts:130`).

**Recommended sequencing:** #35 chapters first (it's the substrate for #37 card timing,
#39's HTML player, and #39's analytics) → #36 narration docs+lints in parallel (no code
dependency) → #37 cards → #38 caption modes → #39 only after a design doc.

---

## 4. Decisions needed from you (these block work)

1. **Does tutorial-forge's scope expand beyond video?** Gates #39. An HTML player and a
   live practice runner both reverse the explicit v1 non-goal "No interactive/HTML demos"
   (`spec.md:21`). Product-identity call — nothing in #39 starts until you decide.
2. **Lint default-on vs. opt-in** (#36). PM rec: over-long-narration on by default
   (objective, high signal); missing-intro/recap behind opt-in strict mode (heuristic,
   noisier).
3. **Caption-modes API shape** (#38). PM rec: a new orthogonal option
   (`captionText: 'verbatim' | 'keyterms'`) keeping delivery (`subtitles`) separate from
   content, vs. overloading the `subtitles` enum.
4. **Cards: visual-only or narrated?** (#37). PM rec: visual-only in v1 — authors already
   speak the organizer in step-1 narration, so narrating cards too would manufacture the
   redundancy the review warns against.

---

## Suggested next step

If you're happy with the direction, the cheapest high-impact move is to greenlight
**#35 (chapters)** and **#36 (narration guidance + lints)** — both ride existing
infrastructure and lift every tutorial. #39 is parked behind decision #1.

Also pending: the documentation fixes in §1 are **uncommitted** — say the word and I'll
commit them (and these review/report files).
