# tutorial-forge — Issue Action Report

_Prepared 2026-06-13 against `main` (v0.8.0). Author: maintainer review._

All eight open issues except #1 came out of a single real-world authoring session:
building the umami "steward how-to" tutorials (`run-an-event`, `send-a-broadcast`) on
v0.8.0. They are field notes from someone actually authoring a non-trivial tutorial, which
makes them unusually high-signal. #1 predates that session and is a feature proposal.

---

## Executive summary

The umami session exposed one dominant theme: **the authoring inner loop is slow and
blind.** An author writes steps, runs a full render, and then cannot easily tell whether
the result is correct without scrubbing video or hand-extracting frames with ffmpeg.
Concretely, the pain clusters into three groups:

1. **Slow, blind iteration (the core pain).** Re-recording all steps to tune step 11 of 13
   (#11), no way to see per-step output without ffmpeg (#9), and no feedback that a feature
   (idleSpeedup) even did anything (#13). These are about closing the edit→verify loop.

2. **Choreography gaps on non-click interactions (the most visible output-quality bug).**
   `selectOption` / `fill` / `check` on off-screen or native controls produce "visually
   dead frames" — narration talking about a control the camera never moves to or scrolls
   into view (#10). This directly degrades the rendered video, which is the product.

3. **Setup/teardown and readiness ergonomics (workarounds the author had to invent).**
   A single global adapter forced state hacks and data leaks across tutorials (#8); fixed
   `settleMs` magic numbers stood in for a real "wait until settled" signal (#14); and
   `doctor` didn't catch the single most common failure — the app not running (#12).

`forge publish` (#1) is a separate, forward-looking distribution feature, not session
friction.

A notable finding from reading the code: **#10 and #13 are already partly built**, which
changes their effort and framing (details below). #13 is essentially a one-line fix.

---

## Per-issue assessment

Importance: Critical / High / Medium / Low. Effort: S (hours) / M (a day or two) / L (multi-day).

| # | Title (restated) | Importance | Effort | Notes / dependencies |
|---|---|---|---|---|
| 13 | Log idleSpeedup even when it compresses nothing | Medium | **S** | One-line fix; already 90% there. Quick win. |
| 12 | `doctor` probes adapter `baseURL` reachability | High | S–M | Needs doctor to load config (it currently doesn't). Big friction-per-effort. |
| 9 | Keep per-step screenshots on success + contact sheet | High | M | Reuses existing `--debug` screenshot path. Core to the verify loop. |
| 10 | Cursor/callout/auto-scroll for fill/select/check | High | M | **Partly done already** — see below. Real gap is auto-scroll. Output quality. |
| 11 | Render a step range / single-step preview | High | M–L | Hardest of the loop trio (state deps). Biggest time saver if solved. |
| 14 | Docs: settleMs vs waitFor + a network-idle settle | Medium | S (docs) / M (helper) | Split: docs are S; `settleUntil` helper is M. |
| 8 | Per-tutorial setup/teardown hooks + step teardown | High | M | Type + pipeline change; backward-compatible. Removes real workarounds. |
| 1 | `forge publish` to hosting (Vimeo first) | Low (now) | L | Net-new surface, external API auth, well-specced but premature. |

### #13 — idleSpeedup logs nothing on a no-op  · Medium · S
**Verified in code.** `packages/core/src/pipeline/post.ts` lines 85–98 only log inside
`if (segments.length > 0)`. When idleSpeedup runs but finds no span over the threshold, it
emits nothing — exactly the reported symptom. By contrast zoom always logs (line 132). Fix
is to add an `else` branch (`idle: no spans over <maxIdleMs>ms`) and, ideally, normalize the
existing line to the issue's suggested phrasing. Trivial, high-confidence, no risk. **Best
first quick win.**

### #12 — `doctor` doesn't check the app is up  · High · S–M
**Verified.** `packages/cli/src/doctor.ts` checks node/ffmpeg/ffprobe/chromium/TTS env vars
but never loads the config or touches `adapter.baseURL`. "Forgot to start the dev server" is
the single most common real failure and currently surfaces as a Playwright navigation
timeout deep inside a render. Effort is S–M only because `doctor` must now load
`forge.config.ts` (the render path already does this via `cli/src/load.ts`, so it's
reusable). Keep it best-effort: skip cleanly if no config is resolvable, so `doctor` stays
useful outside a project. The issue's pnpm aside (`pnpm exec ... doctor` fails on an
ignored-builds pre-check) is a real, separate docs nit worth a one-liner.

### #9 — Keep success screenshots + contact sheet  · High · M
**Verified gap.** Screenshots are written only on failure (`captureFailure`) or in
`--debug` (`debugScreenshot`, `packages/core/src/pipeline/record.ts`). The infrastructure
already exists — the work is (a) optionally keep an end-of-step screenshot on success, and
(b) assemble a labeled contact-sheet PNG (ffmpeg `tile` or montage of the per-step shots).
This is the cheapest direct answer to "a passing render doesn't prove the right thing
rendered," which the author called their *entire verification loop*. Recommend `--contact-
sheet` opt-in (default-on risks slowing every render). Pairs naturally with #11.

### #10 — Choreography for non-click interactions  · High · M (reduced)
**Partially implemented already — re-scope before building.** In
`packages/core/src/browser/instrument.ts`: `ACTION_METHODS` already includes `fill`,
`check`, `uncheck`, `selectOption`, so the **cursor already travels** to those targets; and
`CLICK_METHODS` already includes `selectOption`/`check`/`uncheck`, so they **already get the
ring + pulse**. So the issue is partly stale. The genuine remaining gaps:
  - **No auto-scroll-into-view anywhere.** `presentAction` reads `boundingBox()` but never
    scrolls the element into frame — this is the actual umami `<select>` "off-screen,
    visually dead" complaint and the reason the author hand-wrote `scrollIntoView`. This is
    the highest-value part.
  - **`fill` gets a cursor move but no ring** (it's in `ACTION_METHODS`, not
    `CLICK_METHODS`) — arguably correct (typing isn't a click), but worth a deliberate
    decision.
  - **Optional `step(..., { focus: locator })`** as an explicit anchor for narration about a
    control not directly acted on.

Reframe the issue around auto-scroll + the explicit `focus` anchor; the cursor/ring part is
mostly done. This is the most visible *output-quality* win.

### #11 — Step-range / single-step preview  · High · M–L
**Verified gap.** No `--steps` flag in `cli/src/main.ts`; `runRecordPhase` always loops all
steps. The biggest time saver in the loop-pain cluster, and the hardest because of inter-step
state dependencies. The issue's own framing is the right one: don't promise arbitrary ranges
first. Ship the **single-step preview** (run `adapter.setup()` + prior steps' `run()` to
reach state, then execute just the target step and dump a screenshot — no encode) before any
true range render. Depends on #9's screenshot machinery; build #9 first, then #11 reuses it.

### #14 — settleMs vs waitFor docs + network-idle settle  · Medium · S (docs) / M (helper)
**Verified.** `docs/writing-tutorials.md` mentions `settleMs` and `waitFor` (lines ~32–44)
but has no "which tool when / avoid magic numbers" mental-model section. The author tuned
600/800/1200/1500 by trial-and-render because there's no DOM signal after a `router.refresh()`
repaint. **Split this:** the docs section is an S quick win and should ship immediately; the
`settleUntil: 'networkidle'` helper is a separate M enhancement (real product surface — a new
step option) that can wait.

### #8 — Per-tutorial setup/teardown hooks  · High · M
**Verified.** The `Tutorial` type (`packages/core/src/types.ts`) exposes only
`id/title/description/steps/translations`; `runRecordPhase` only ever calls
`adapter.setup`/`adapter.teardown`. Two tutorials needing different starting states is
unsolvable today, which forced the author into a "(demo)" naming convention + a purge helper
and caused data to leak between renders. The proposal is clean and backward-compatible:
optional `setup?`/`teardown?` on the tutorial spec composing with the adapter, plus
`ctx.onTeardown(fn)` so a step can register deterministic cleanup for data it creates. This
removes a genuine workaround and unblocks multi-tutorial repos (umami being exactly that).

### #1 — `forge publish` to Vimeo  · Low now · L
**Verified net-new.** No `publish` command in `cli/src/main.ts`; no `PublishTarget` in
`core/src/index.ts`. The design is thorough (provider interface, `published.json` mapping,
content-hash idempotency, Vimeo replace-in-place). But it's a large surface with external API
auth/review, and it doesn't address any session friction — you can't publish a video you're
struggling to author correctly. **Defer until the authoring loop is solid.** Keep the issue
open as the agreed design; don't start it this cycle.

---

## What's most important to fix

Ranked by author value per unit effort, grounded in "this is what made the umami session
painful":

1. **#13 (S)** — one-line observability fix; do it immediately.
2. **#12 (S–M)** — kills the most common confusing failure at the front door.
3. **#9 (M)** — gives authors a way to *verify* output without ffmpeg; foundational for #11.
4. **#10 auto-scroll (M)** — the most visible defect in the rendered video itself; partly
   done, so cheaper than it looks.
5. **#11 single-step preview (M–L)** — the biggest raw time-saver; build on #9.
6. **#8 (M)** — unblocks real multi-tutorial repos and removes a data-leak workaround.

#9 → #11 is the one hard dependency to respect (preview reuses the per-step screenshot
machinery). #14-docs and the #10-rescope are essentially free clarifying wins to fold in.

---

## Plan of action (phased)

**Phase 0 — Quick wins (ship as a 0.8.x patch, ~1 day total).**
- #13 idleSpeedup no-op log line (one-line change in `post.ts`).
- #14 *docs only*: add the settleMs-vs-waitFor mental-model section to
  `writing-tutorials.md`; add the pnpm `doctor` note from #12's aside.
- #10 *triage*: edit the issue to reflect that cursor+ring already cover select/check and
  rescope it to auto-scroll + `focus` anchor (do this before estimating the build).

**Phase 1 — Close the authoring loop (a 0.9.0 "authoring DX" release).**
- #12 doctor reachability probe (load config, probe `baseURL`).
- #9 success screenshots + `--contact-sheet`.
- #11 single-step preview (reuses #9 screenshot path). Defer arbitrary `--steps` ranges.

**Phase 2 — Output quality + state model (0.10.0).**
- #10 auto-scroll-into-view in `presentAction`; optional `step({ focus })`.
- #8 per-tutorial `setup`/`teardown` + `ctx.onTeardown`.
- #14 *helper*: `settleUntil: 'networkidle'` step option.

**Phase 3 — Distribution (later, own release).**
- #1 `forge publish` (Vimeo first), only once authoring is solid.

Quick wins: #13, #14-docs, #12. Larger efforts: #11, #8, #1.

---

## Can be disregarded / deferred

- **#1 `forge publish` — defer (not disregard).** Well-designed but premature: it's a large
  external-API surface that solves distribution, while every other open issue says authoring
  itself is still rough. Revisit after Phase 1–2. Keep the issue as the design of record.
- **#10 cursor/ring portion — already shipped.** Don't rebuild cursor travel or the
  click ring for select/check; only auto-scroll and the `focus` anchor remain. Rescope, don't
  re-implement.
- **#14 network-idle helper — split out and defer** behind the (free) docs section. The docs
  resolve most of the friction; the helper is a nice-to-have new surface.
- **#11 arbitrary `--steps from..to` ranges — defer within the issue.** State dependencies
  make true ranges unreliable; ship single-step preview only and don't over-promise ranges.

---

## Recommended issue housekeeping (no edits made)

- **#10**: add a comment/relabel noting cursor + ring already cover `selectOption`/`check`
  (`instrument.ts` `ACTION_METHODS`/`CLICK_METHODS`) and rescoping to auto-scroll + `focus`.
- **#14**: consider splitting into a `documentation` issue (mental model, ready now) and an
  `enhancement` issue (`settleUntil` helper).
- **#12**: capture the pnpm `doctor` ignored-builds docs note as its own `good first issue`.

## Possible gap not yet tracked (noted, not filed)

No open issue covers **multi-tutorial UX more broadly** — the render summary, `list`, and
output naming are all single-tutorial-shaped, and the umami session was inherently
multi-tutorial (it surfaced via #8's shared-adapter problem). Worth watching as #8 lands; not
yet worth its own issue.
