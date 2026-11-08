# tutorial-forge

A pnpm TypeScript ESM monorepo that turns scripted Playwright walkthroughs into narrated tutorial videos. `packages/core` (npm `tutorial-forge`) is the engine, three phases in `src/pipeline/`: tts → record → post. `packages/cli` (npm `tutorial-forge-cli`) is the `render / preview / list / doctor / clean` CLI over it. `packages/example-app` is the fixture app ("Lumen Events") plus the e2e render harness; it isn't published. `README.md` and `docs/` describe the product, `CHANGELOG.md` what shipped. The two packages are versioned and published in lockstep under the PolyForm Small Business license.

## Commands

```bash
pnpm -r build          # tsc for core and cli
pnpm -r typecheck
pnpm -r test           # vitest units in packages/core/test and packages/cli/test (cache.test.ts needs ffmpeg)
pnpm e2e               # the integration gate: boots the example app, renders real tutorials, asserts on the artifacts (2–3 min)
cd packages/example-app && pnpm serve                       # the fixture app on http://localhost:3700
cd packages/example-app && pnpm forge render --only getting-started --keep-work   # a real render; work dir in .forge/<id>/
```

Only one render or e2e run at a time on this machine; the harness picks a free port, but concurrent renders fight for CPU and skew timing.

## Agents

The shared agents come from kit (`kit@jbrecht`, enabled in `.claude/settings.json`); tutorial-forge's specifics for each are in `.claude/kit/agents/<name>.md`. `kit:review` recommends reviewers by the routing table in `.claude/kit/skills/review.md`, and you choose which run. They report; implementation stays in the main thread.

| Agent | Reach for it | It produces |
|---|---|---|
| `kit:code-reviewer` | before committing anything beyond docs: timing math, the flash/sync path, ffmpeg builders, process cleanup, the public API | Blocker / Should fix / Nit findings and a verdict |
| `kit:qa-engineer` | after a feature lands, on a diff that adds behavior, or to audit an area's coverage; it walks the render as an author (timing regimes, composition, i18n, TTS, recording, environment) | a P0 / P1 / P2 gap report; writes tests when asked |
| `kit:designer` | anything that changes how a render looks or reads, or how the CLI talks to an author; it watches a real render | findings on the output experience, quick wins apart from design decisions |
| `kit:product-manager` | grooming, deciding what's next, shaping an idea into issues | Now / Next / Later, draft issues (John approves before anything is filed), the decisions that block work |
| `instructional-designer` | steering a feature toward sound teaching, or judging whether the output teaches | a pedagogy verdict tied to named principles; it recommends to the product-manager and files nothing |
| `performance-engineer` | render speed or resource use, before a batch regeneration | a measured per-phase budget and ranked safe wins versus trade-offs; advisory |
| `publish-reviewer` | before `pnpm publish` | version consistency, the packed surface, semver, secrets |

The last three are tutorial-forge's own, in `.claude/agents/`; performance-engineer and publish-reviewer move to kit in jbrecht/kit#13. A feature-sized pipeline change runs `kit:code-reviewer`, `kit:qa-engineer` and `performance-engineer` together before it's called ready. There is no security-reviewer: the project has no server, auth or payment surface, so the pre-ship risk is package hygiene, which publish-reviewer owns. Revisit that if a feature adds a runtime trust boundary, such as fetching remote specs or assets.

## Roadmap

The roadmap is GitHub issues, managed with the `kit:roadmap` skill. Each kind of decision lives in exactly one place:
- **Labels** say what kind of work: `bug`/`enhancement` plus areas `tts`, `recording`, `post`, `cli` and `documentation`. Never priority.
- **Milestones** are goals worked through in order: Trustworthy text → Documentation stills → Teaching-first. No milestone means backlog.
- **Owner:** John, who sets Priority and milestones and approves new issues.
- **The "tutorial-forge Roadmap" Project** (https://github.com/users/jbrecht/projects/10) holds **Priority** (Now/Next/Later) and **Status** (Todo/In Progress/Done). Card order within a column is the sequence.
- **Blocked-by links** record real dependencies. Big issues split into sub-issues.
- **Why** a decision was made goes in the issue, as a "Decision (John, date)" line or a comment.

New work becomes an issue first (labels, milestone, Status Todo); John sets Priority. Starting work on an issue: set its Status to In Progress, and put `Fixes #N` in the PR (`Part of #N` while a criterion can only be checked after merge; `kit:do-issue` step 7 has the rule). Change Priority or milestones only with John's approval.

## Releasing

Both versions move together, and `CHANGELOG.md`'s `## Unreleased` becomes `## <version> — <theme>`. Run `publish-reviewer` first. Publish core before cli, each with `pnpm --filter <package> publish`, never `npm publish`: pnpm rewrites the cli's `"tutorial-forge": "workspace:*"` to the exact version, and npm ships it literally, which broke every install of cli@0.11.1. The cli pins core's exact version, so core has to be on the registry first. npm's 2FA needs an interactive one-time code, so John runs the two publish commands himself. Afterwards: `npm view tutorial-forge-cli@<version> dependencies.tutorial-forge` must not read `workspace:*`; then tag `v<version>`, push the tag, and create a GitHub Release from the CHANGELOG section.
