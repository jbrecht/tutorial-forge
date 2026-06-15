# tutorial-forge agents

Seven project subagents for tutorial-forge — the TypeScript ESM monorepo (pnpm) that
renders narrated tutorial videos by driving an app with Playwright and stitching the
result with ffmpeg. Two **generative** roles decide what to build — one for product
priority, one for pedagogical direction; five **reactive** reviewers critique work along
different axes — *is it correct*, *is it well-tested*, *does it watch well*, *is it fast*,
*is it safe to ship*. Reach for them at these moments:

## Generative (decide what to build)

| Agent | Reach for it when… | It produces |
|---|---|---|
| **product-manager** | grooming the backlog, planning a release, or deciding what to build next. | a prioritized backlog (Now/Next/Later/propose-close) verified against the code + CHANGELOG, newly filed gap issues, and a maintainer report of product decisions that block work. Files issues; never closes/edits them. |
| **instructional-designer** | steering a new feature toward sound teaching, or evaluating whether the project's approach actually helps people learn complex software. | a pedagogy verdict tying TF's features (callouts/cursor/zoom = signaling, steps = segmenting, narration↔action sync = temporal contiguity, captions = redundancy tension, idle-speedup = coherence) to named instructional-design principles and learner outcomes, plus feature proposals for the gaps. Advisory — recommends to the product-manager; doesn't file issues or write code. |

## Reactive (review what exists)

| Agent | Reach for it when… | It produces |
|---|---|---|
| **code-reviewer** | after implementing a feature/fix, before John commits. | severity-ranked findings on the uncommitted diff — timing math, the calibration-flash/sync path, ffmpeg arg/filter builders, async/process cleanup, public-API/semver, ESM hygiene. Read-only. |
| **qa-engineer** | after a feature lands, or to audit a feature area's coverage. | a prioritized test-gap report across the render pipeline's author journeys (timing regimes, filtergraph composition, i18n, TTS, recording, GIF windowing); picks vitest vs. e2e per gap. Writes tests when asked. |
| **designer** | after changing anything that affects how a render looks or reads, or to audit how a tutorial watches to a human. | critique of the **output experience** — video pacing, callout/cursor/zoom placement, caption legibility + the `.srt`, GIF exports, and CLI ergonomics (`doctor`, progress, `StepError`). Watches a real render; doesn't read just the code. |
| **performance-engineer** | auditing render speed / resource use, before a large batch regeneration (e.g. umami's set), or when a render feels slow. | a prioritized, **measured** optimization report — a per-phase time/CPU/memory budget (cold vs warm cache, single vs batch), findings ranked by quantified saving × confidence, separating safe wins from output trade-offs. Advisory; measures and recommends, doesn't change behavior or file issues. |
| **release-reviewer** | before `pnpm publish` of a new version. | release-hygiene findings — version-bump consistency across the three places, semver of the public surface, the packed tarball surface, no leaked secrets/stray files, CHANGELOG + docs. Read-only. **This replaces a security-reviewer role** — TF has no server/auth/payment surface; its risk is shipping a broken or leaky npm package. |

## How they divide the work

The five reviewers are deliberately **different axes on the same render**, not redundant:

- **code-reviewer** asks *is it correct* — does the timing math, the flash/sync path, and
  the filtergraph wiring do the right thing, and is the public API change semver-honest.
- **qa-engineer** asks *is it proven* — is there a test pinning each author journey, at
  the right layer (a pure helper as a vitest unit, the full pipeline only when the
  assertion genuinely needs real artifacts). A behavior the code handles but no test pins
  is still a gap.
- **designer** asks *does it watch well* — correctness the others prove (drift, cue count,
  flash) is necessary but not sufficient; the designer judges pacing, attention-direction,
  and legibility that no assertion captures.
- **performance-engineer** asks *is it fast* — same output, fewer seconds and cycles:
  where wall-clock actually goes (TTS / record / post), encode + filtergraph efficiency,
  cache hit-rate, and parallelism across a batch. It measures first and never trades
  correctness, A/V sync, or watchability for speed.
- **release-reviewer** asks *is it safe to ship* — independent of whether the feature is
  good, will the published `tutorial-forge` / `tutorial-forge-cli` packages be correctly
  versioned, completely packed, and leak-free.

## How they hand off

- The **designer** finds experience problems that are really *bugs* (a caption out of sync
  because a cue is mis-computed, a callout firing on the wrong step) and hands those to the
  **code-reviewer** / **qa-engineer** rather than treating them as taste. The reverse also
  holds: a correct-but-unwatchable render is the designer's call, not the code-reviewer's.
- The **performance-engineer** and **code-reviewer** share the ffmpeg arg/filter builders:
  the code-reviewer asks *is it correct*, the performance-engineer asks *is it as fast as it
  can be without changing a byte of output*. A speedup that risks sync or correctness goes
  back to the **code-reviewer**; one that would change what the viewer sees or hears is a
  **designer** watchability call or a **product-manager** trade-off — never an optimization
  the performance-engineer applies on its own.
- The **instructional-designer** and the **designer** share a seam on the attention
  features (callouts/cursor/zoom, pacing, captions): the designer asks *is it crafted well*
  (jarring zoom, unreadable caption), the instructional-designer asks *does the learner
  learn* (the zoom cues the wrong element; narrating identical on-screen text adds load).
  Polish goes to the designer; learning outcomes stay with the instructional-designer.
- The **instructional-designer** sets pedagogical *direction*; the **product-manager** owns
  *priority and filing*. The instructional-designer produces the learning rationale and the
  argument for a feature; the PM weighs it against everything else and turns it into issues.
- The **product-manager** consumes the others' findings as backlog input (a qa coverage
  gap, a designer critique, or an instructional-designer recommendation can become a filed
  issue) but owns *what/when*, not *how* — it files new issues and recommends closures; it
  never edits existing ones.
- The **release-reviewer** is the last gate before publish; the **code-reviewer**'s
  public-API/semver findings feed directly into its version-bump check.

## Note on the missing security-reviewer

Sibling projects in this family (pilot-forge, umami) carry a `security-reviewer`. TF
intentionally does **not** — see the `release-reviewer` frontmatter. There's no runtime
attack surface to audit here (no server, auth, or payment path); the real pre-ship risk is
package hygiene, which the release-reviewer owns. If a future feature adds a genuine
runtime trust boundary (e.g. fetching remote specs/assets), revisit that decision rather
than stretching the release-reviewer to cover it.
