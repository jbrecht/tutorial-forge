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

## Guidelines

- **End setup on the screen step 1 expects.** The video starts (minus `leadInMs`) right where setup leaves off — wait for that screen to be fully rendered before returning.
- **Seed deterministic state.** Same inputs should produce the same video. Create fixture data with fixed names/dates; avoid "3 minutes ago"-style relative content where you can.
- **Run your app yourself.** The pipeline does not start your dev server; do that before `forge render` (or in your CI job before the render step).
- **Keep secrets in env vars.** The adapter is plain code in your repo; read credentials from the environment, as in any e2e test.
- **Teardown failures are non-fatal.** They log a warning and the render still succeeds — teardown runs after the manifest is final.
