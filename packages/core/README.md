# tutorial-forge

Turn scripted Playwright walkthroughs into narrated tutorial videos (MP4).

**Tutorials are source code.** Each tutorial pairs narration lines with raw Playwright actions; the pipeline handles TTS narration (ElevenLabs, OpenAI, Piper, or silent), screen recording, narration-driven pacing, an animated cursor, click callouts, SRT subtitles, and the FFmpeg merge. When your UI changes, re-render instead of re-recording.

```ts
import { tutorial, step } from 'tutorial-forge';

export default tutorial('Getting started', [
  step('Open the Events page from the navigation bar.', async (page) => {
    await page.getByRole('link', { name: 'Events' }).click();
  }),
]);
```

This package is the library (types, spec builders, pipeline, TTS providers). Most users also want [`tutorial-forge-cli`](https://www.npmjs.com/package/tutorial-forge-cli) for the `tutorial-forge` command.

**Full documentation: [github.com/jbrecht/tutorial-forge](https://github.com/jbrecht/tutorial-forge)**
