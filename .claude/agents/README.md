# tutorial-forge agents

Five project subagents for tutorial-forge — the TypeScript ESM monorepo (pnpm) that
renders narrated tutorial videos by driving an app with Playwright and stitching the
result with ffmpeg. One **generative** role grooms what to build; four **reactive**
reviewers critique work along different axes — *is it correct*, *is it well-tested*, *does
it watch well*, *is it safe to ship*. Reach for them at these moments:

## Generative (decide what to build)

| Agent | Reach for it when… | It produces |
|---|---|---|
| **product-manager** | grooming the backlog, planning a release, or deciding what to build next. | a prioritized backlog (Now/Next/Later/propose-close) verified against the code + CHANGELOG, newly filed gap issues, and a maintainer report of product decisions that block work. Files issues; never closes/edits them. |

## Reactive (review what exists)

| Agent | Reach for it when… | It produces |
|---|---|---|
| **code-reviewer** | after implementing a feature/fix, before John commits. | severity-ranked findings on the uncommitted diff — timing math, the calibration-flash/sync path, ffmpeg arg/filter builders, async/process cleanup, public-API/semver, ESM hygiene. Read-only. |
| **qa-engineer** | after a feature lands, or to audit a feature area's coverage. | a prioritized test-gap report across the render pipeline's author journeys (timing regimes, filtergraph composition, i18n, TTS, recording, GIF windowing); picks vitest vs. e2e per gap. Writes tests when asked. |
| **designer** | after changing anything that affects how a render looks or reads, or to audit how a tutorial watches to a human. | critique of the **output experience** — video pacing, callout/cursor/zoom placement, caption legibility + the `.srt`, GIF exports, and CLI ergonomics (`doctor`, progress, `StepError`). Watches a real render; doesn't read just the code. |
| **release-reviewer** | before `pnpm publish` of a new version. | release-hygiene findings — version-bump consistency across the three places, semver of the public surface, the packed tarball surface, no leaked secrets/stray files, CHANGELOG + docs. Read-only. **This replaces a security-reviewer role** — TF has no server/auth/payment surface; its risk is shipping a broken or leaky npm package. |

## How they divide the work

The four reviewers are deliberately **different axes on the same render**, not redundant:

- **code-reviewer** asks *is it correct* — does the timing math, the flash/sync path, and
  the filtergraph wiring do the right thing, and is the public API change semver-honest.
- **qa-engineer** asks *is it proven* — is there a test pinning each author journey, at
  the right layer (a pure helper as a vitest unit, the full pipeline only when the
  assertion genuinely needs real artifacts). A behavior the code handles but no test pins
  is still a gap.
- **designer** asks *does it watch well* — correctness the others prove (drift, cue count,
  flash) is necessary but not sufficient; the designer judges pacing, attention-direction,
  and legibility that no assertion captures.
- **release-reviewer** asks *is it safe to ship* — independent of whether the feature is
  good, will the published `tutorial-forge` / `tutorial-forge-cli` packages be correctly
  versioned, completely packed, and leak-free.

## How they hand off

- The **designer** finds experience problems that are really *bugs* (a caption out of sync
  because a cue is mis-computed, a callout firing on the wrong step) and hands those to the
  **code-reviewer** / **qa-engineer** rather than treating them as taste. The reverse also
  holds: a correct-but-unwatchable render is the designer's call, not the code-reviewer's.
- The **product-manager** consumes the others' findings as backlog input (a qa coverage
  gap or a designer critique can become a filed issue) but owns *what/when*, not *how* —
  it files new issues and recommends closures; it never edits existing ones.
- The **release-reviewer** is the last gate before publish; the **code-reviewer**'s
  public-API/semver findings feed directly into its version-bump check.

## Note on the missing security-reviewer

Sibling projects in this family (pilot-forge, umami) carry a `security-reviewer`. TF
intentionally does **not** — see the `release-reviewer` frontmatter. There's no runtime
attack surface to audit here (no server, auth, or payment path); the real pre-ship risk is
package hygiene, which the release-reviewer owns. If a future feature adds a genuine
runtime trust boundary (e.g. fetching remote specs/assets), revisit that decision rather
than stretching the release-reviewer to cover it.
