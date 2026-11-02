## Routing table
| The diff touches… | Add |
|---|---|
| the render pipeline or its tests (`packages/core/src/pipeline/`, `src/post/`, `src/browser/`, `src/tts/`, `packages/example-app/test/e2e.ts`), or adds behavior without tests | `kit:qa-engineer` |
| anything a viewer or author sees: rendered output (cards, chapters, captions, zoom, cursor, callouts, gif, stills and `index.md`), CLI output and messages, `doctor` | `kit:designer` |
| ffmpeg arguments or encoding, the record phase's waits, concurrency, caching | `performance-engineer` (tutorial-forge's own copy in `.claude/agents/`, until jbrecht/kit#13) |
| `package.json` versions, `files` or dependencies, a `CHANGELOG.md` release entry, anything about to be published | `publish-reviewer` (tutorial-forge's own copy in `.claude/agents/`) |

## Tier changes
A feature-sized change to the render pipeline is risky: run `kit:code-reviewer`, `kit:qa-engineer` and `performance-engineer` together, and wait for all three before calling the change ready. On #72 only code-reviewer ran before the merge; qa-engineer then found six defects that needed a second PR (#73).
