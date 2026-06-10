# tutorial-forge-cli

CLI for [`tutorial-forge`](https://www.npmjs.com/package/tutorial-forge) — render scripted Playwright walkthroughs into narrated tutorial videos.

```sh
pnpm add -D tutorial-forge tutorial-forge-cli playwright

tutorial-forge render          # render every *.tutorial.ts per forge.config.ts
tutorial-forge list            # discovered tutorials
tutorial-forge doctor          # check node / ffmpeg / playwright / TTS env
tutorial-forge clean --cache   # remove work dirs and the TTS cache
```

Installed as `tutorial-forge` with a shorter `tforge` alias.

**Full documentation: [github.com/jbrecht/tutorial-forge](https://github.com/jbrecht/tutorial-forge)**
