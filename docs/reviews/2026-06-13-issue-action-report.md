# tutorial-forge — Issue Action Report

_Prepared 2026-06-13 against `main` (v0.9.0 → v0.10.0). Author: maintainer review._

Issues #15–#21 came out of a second real-world dogfooding session: authoring the umami
"steward how-to" tutorials (`run-an-event`, `send-a-broadcast`) on **v0.9.0**, the release
that added per-tutorial setup/teardown (#8). #22–#23 are gaps filed during this review.
(The prior round — #8–#14, the authoring inner loop — shipped in 0.9.0; this report
supersedes that one.)

---

## Executive summary

The dominant theme: **the setup/teardown lifecycle #8 introduced has a correctness hole
and an ergonomic hole.** Six of seven issues cluster there.

- **Correctness:** teardown didn't run on the setup-failure path (#15) or fully on the
  `preview` path (#16), so a shared test DB silently accumulated leaked rows.
- **Ergonomics:** there was no first-class channel for `tutorial.setup`/steps to read what
  `adapter.setup` established, forcing a module-global + `!` handoff (#17).
- Plus a settling foot-gun in the standard Next.js mutation pattern (#18), a doctor blind
  spot (#19), a missing failure-time diagnostic (#20), and a type papercut (#21).

All shipped together as **0.10.0** (a minor: it includes additive API — `ctx.state`,
`probeAdapterSetup`, `doctor --setup`). Bug fixes + additive API in one release was simpler
than the originally-proposed 0.9.1/0.10.0 split and matches how the work actually landed.

---

## Per-issue disposition

| # | Title | Disposition | Where |
|---|---|---|---|
| #15 | Setup-phase failures skip teardown | **Fixed** — setup wrapped; full chain runs then rethrows | `record.ts` |
| #16 | preview leaks the adapter seed | **Fixed** — preview runs full teardown chain on every exit | `preview.ts` |
| #17 | adapter→tutorial state channel | **Implemented** — typed `ctx.state`; adapter return lands on it | `types.ts`, `step-hooks.ts` |
| #18 | networkidle races startTransition | **Docs done (18a)**; React-idle settle **deferred (18b)** | `writing-tutorials.md`, `types.ts` |
| #19 | doctor validates adapter.setup | **Implemented** — `doctor --setup` / `probeAdapterSetup` | `preflight.ts`, `doctor.ts` |
| #20 | partial contact sheet on failure | **Fixed** — emitted from the failure path | `render.ts` |
| #21 | widen onTeardown return type | **Fixed** — `() => unknown \| Promise<unknown>` | `types.ts`, `step-hooks.ts` |
| #22 | e2e assert teardown coverage | **Done** — new e2e + unit coverage | `e2e.ts`, `step-hooks.test.ts` |
| #23 | document teardown matrix | **Done** — matrix + ctx.state section | `adapters.md` |

## Decisions taken (PM recommendations, all adopted)

- **D1 (#15):** On a setup throw, run the **full** teardown chain. Safe because every hook
  is guarded (`safeTeardown`), so teardown against half-built state logs rather than masks.
  Contract documented: teardown hooks must tolerate partial setup.
- **D2 (#16):** `preview` runs **full teardown by default** (a `--keep` opt-out can come
  later if it proves slow). A quick-iterate tool must not dirty a shared DB.
- **D3 (#17):** Typed, returned **`ctx.state`** via `TutorialAdapter<S>` → `StepContext<S>`
  (parallel-safe; cleanest to type end-to-end). Defaults to `{}` so steps can always stash.
- **D4 (#18):** **Docs only** for now; the React-aware settle (18b) is deferred — the
  principled answer is `waitFor` on committed UI, and a generic settle can't observe
  React's transition queue without a heuristic that may trade one race for another.
- **D5 (#20):** Partial sheet emitted **next to the intended output** (survives like the
  success path) with the failure frame appended as the last cell.

## Shared design note

#15, #16, and #19 all needed "run the teardown chain safely," so that logic was extracted
once into `runTeardownChain()` in `pipeline/step-hooks.ts` and is now the single entry point
for record, preview, and the doctor probe.

## Follow-ups / deferred

- **#18b** (filed) — a React-idle `settleUntil` variant. Design-gated; revisit only if the
  `waitFor` guidance proves insufficient in practice.
- **`preview --keep`** — opt-out of preview teardown, only if full teardown proves too slow.

## Verification

`pnpm typecheck` (core, cli, example-app) clean · `pnpm test` (97 unit tests) green ·
`pnpm e2e` green, including new assertions for setup-failure teardown, preview teardown,
`ctx.state` handoff, `probeAdapterSetup` (success + failure-still-tears-down), and the
partial failure contact sheet.
