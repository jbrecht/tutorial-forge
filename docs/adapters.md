# Adapters

The adapter is the **only app-specific code** in the system. The core library never imports from or assumes anything about your app; everything it needs arrives through this interface:

```ts
import type { TutorialAdapter } from 'tutorial-forge';

export const myAdapter: TutorialAdapter = {
  /** Base URL of the running app. */
  baseURL: 'http://localhost:3000',

  /**
   * Auth, seeding, navigation to the starting screen.
   * Runs after page creation, before step 1.
   * Recorded, but trimmed from the final video (pre-roll).
   */
  async setup(page) {
    await page.goto('http://localhost:3000/login');
    await page.getByLabel('Email').fill('demo@example.com');
    await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },

  /** Optional cleanup (delete seeded data, logout). Never in the video. */
  async teardown(page) {
    await page.goto('http://localhost:3000/logout');
  },
};
```

## Per-tutorial setup/teardown

The adapter is the **shared** auth/seed baseline — every tutorial runs through it. When one tutorial needs a different starting state than another (a clean "create your first event" narrative vs. a fully-seeded one), declare per-tutorial hooks that **compose with** the adapter:

```ts
export default tutorial('Create your first event', steps, {
  // Runs after adapter.setup(), before step 1 — per-video state on top of the baseline.
  async setup(page, ctx) {
    await deleteAllEvents(); // this tutorial wants an empty list
  },
  // Runs after recording (after step thunks, before adapter.teardown()).
  async teardown(page, ctx) {
    await deleteAllEvents();
  },
});
```

Run order is **adapter.setup → tutorial.setup** going in, and **step `onTeardown` thunks (LIFO) → tutorial.teardown → adapter.teardown** coming out. Tutorials without hooks keep working through the adapter alone.

The teardown chain runs on **every** exit path of a render — clean finish, a step failure, *and* a failure inside `adapter.setup`/`tutorial.setup` — so data created (and any `ctx.onTeardown` registered) before a throw is always cleaned up, never leaked into a shared test DB. Each hook is guarded: a teardown that runs against half-built state (e.g. after a setup failure) logs a warning instead of masking the original error. Because of this, **write teardown hooks to tolerate partial setup** (null-check what you delete).

### Sharing state between the adapter and a tutorial

`tutorial.setup` and steps usually need what `adapter.setup` established — the signed-in identity, a seeded id. Return it from `adapter.setup` and it lands on **`ctx.state`**, a per-render bag (scoped to one render, so it's parallel-safe). No module-global handoff, no `!` assertions:

```ts
interface Seed { steward: Person }

export const adapter: TutorialAdapter<Seed> = {
  baseURL: 'http://localhost:3000',
  async setup(page) {
    const steward = await seedSteward();
    await signIn(page, steward);
    return { steward }; // → ctx.state
  },
  async teardown(page, ctx) {
    await deletePerson(ctx.state.steward.id);
  },
};

// Read it in the tutorial — typed via tutorial<Seed>/step<Seed>:
export default tutorial<Seed>('Send a broadcast', [
  step<Seed>('Create an event.', async (page, ctx) => {
    await createEvent(page, ctx.state.steward);
    const id = new URL(page.url()).pathname.split('/').pop()!;
    ctx.state.eventId = id;               // steps can stash live-created ids…
    ctx.onTeardown(() => deleteEvent(id)); // …for their own cleanup
  }),
], {
  async setup(page, ctx) {
    await seedEventFor(ctx.state.steward); // reads what the adapter established
  },
});
```

A teardown thunk's return value is awaited and discarded, so value-returning one-liners work directly: `ctx.onTeardown(() => Promise.all(people.map((p) => deletePerson(p.id))))`.

### Teardown coverage matrix

Which hooks run on each path:

| Path | step `onTeardown` | `tutorial.teardown` | `adapter.teardown` |
|---|---|---|---|
| Render — clean finish | ✓ | ✓ | ✓ |
| Render — a step fails | ✓ (for completed steps) | ✓ | ✓ |
| Render — `adapter.setup`/`tutorial.setup` throws | ✓ (registered before the throw) | ✓ | ✓ |
| `preview <step>` (any outcome) | ✓ | ✓ | ✓ |
| `doctor --setup` | ✓ | n/a (no tutorial) | ✓ |

`preview` reaches partial, mid-tutorial state yet still runs the full chain — it's run repeatedly while tuning a step, so leaving the adapter seed behind would quietly fill the DB. (This is why teardown hooks must tolerate partial setup.)

For data a *step* creates mid-tutorial, register cleanup inline with `ctx.onTeardown()` instead of tracking it in the adapter:

```ts
step('Create an event.', async (page, ctx) => {
  await page.getByRole('button', { name: 'New event' }).click();
  await page.getByLabel('Name').fill('Launch Party');
  await page.getByRole('button', { name: 'Create' }).click();
  ctx.onTeardown(() => deleteEventByName('Launch Party')); // torn down deterministically
});
```

Thunks run in reverse registration order, so the last thing created is the first cleaned up. Like teardown, `onTeardown` failures log a warning and never fail the render.

## Guidelines

- **End setup on the screen step 1 expects.** The video starts (minus `leadInMs`) right where setup leaves off — wait for that screen to be fully rendered before returning.
- **Seed deterministic state.** Same inputs should produce the same video. Create fixture data with fixed names/dates; avoid "3 minutes ago"-style relative content where you can.
- **Run your app yourself.** The pipeline does not start your dev server; do that before `tutorial-forge render` (or in your CI job before the render step).
- **Keep secrets in env vars.** The adapter is plain code in your repo; read credentials from the environment, as in any e2e test.
- **Teardown failures are non-fatal, and must tolerate partial setup.** They log a warning and the render still succeeds — teardown runs after the manifest is final, and also after a *failed* setup, so null-check what you delete.
- **Verify setup before a full render.** `tutorial-forge doctor` checks the app is reachable; add `--setup` to actually run `adapter.setup` once and tear it down. It catches the "reachable but pointed at the wrong database" case — a green reachability check followed by a guaranteed sign-in failure — before you wait out a whole render.

## Parallel rendering

By default the CLI renders one tutorial × language at a time. Because the record phase mostly *waits* (each step holds in real time for its narration), the machine is near-idle during it — so rendering a **set** of tutorials is much faster in parallel. Opt in with `--render-concurrency <n>` (or `renderConcurrency` in `forge.config.ts`); the default is `1` (serial).

Concurrency > 1 only works if **your adapter is parallel-safe**, because each concurrent render runs its own `setup`/`teardown` against your app at the same time. The contract:

- **Isolate seed data per render.** Concurrent `setup` calls must not collide on shared state. Give each render its own namespace — a per-worker database/schema, a unique tenant or account, or seed records keyed so they can't clash — rather than seeding into one shared space. If two renders seed and tear down the same rows, they'll corrupt each other.
- **Don't assume a single live browser/page.** Each render drives its own browser; adapters that reach for a module-global page or client will break. Use `ctx.state` (see above) for per-render handoff, never a shared singleton.
- **Make teardown idempotent and scoped.** It already must tolerate partial setup; under concurrency it must also only remove *its own* render's data.

If you're not sure your adapter meets this, leave concurrency at `1` — it's the safe default. (TTS synthesis is already safely parallelized within a render via `ttsConcurrency`, independent of this.)
