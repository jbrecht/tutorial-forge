import type { Locator, Page } from 'playwright';

/**
 * Passed to adapter and step callbacks; lets app code react to the render
 * language and share per-render state. Generic in the shape of `state` (S),
 * which `adapter.setup`'s return value populates — see {@link TutorialAdapter}.
 */
export interface StepContext<S = unknown> {
  /** The language being rendered (from RenderOptions.lang / --lang), if any. */
  lang?: string;
  /**
   * Per-render state bag, scoped to one render (never shared across renders, so
   * it's safe even if renders run in parallel). The value `adapter.setup`
   * returns lands here, so `tutorial.setup` and steps can read what the adapter
   * established (the signed-in identity, seeded ids) without a module-global
   * handoff — and steps can stash a live-created id on it for their own
   * `onTeardown`. Defaults to `{}` when the adapter returns nothing.
   */
  state: S;
  /**
   * Register a cleanup callback for data this step creates. Thunks run after
   * recording in reverse (LIFO) order — before the tutorial's and adapter's
   * teardown — so mid-tutorial state is cleaned up deterministically without
   * the adapter needing to know about it. The return value is awaited and
   * discarded, so `() => Promise.all([...])` works directly. Failures are
   * logged, not fatal.
   */
  onTeardown(fn: () => unknown | Promise<unknown>): void;
}

/** Gets the target app into a known, recordable state. The only app-specific code. */
export interface TutorialAdapter<S = unknown> {
  /** Base URL of the running app, e.g. http://localhost:3000 */
  baseURL: string;
  /**
   * Auth, seeding, navigation to a starting screen. Runs after page creation,
   * before step 1. Excluded from the final video by default. Anything it
   * returns lands on `ctx.state` for `tutorial.setup` and steps to read.
   */
  setup(page: Page, ctx: StepContext<S>): Promise<S | void>;
  /** Optional cleanup after recording (delete seeded data, logout). Never recorded. */
  teardown?(page: Page, ctx: StepContext<S>): Promise<void>;
}

export interface Step<S = unknown> {
  /** Stable id, auto-derived from index if omitted. Used in manifest, cache keys, logs, translation tables. */
  id?: string;
  /** The narration line spoken over this step, in the source language. Plain text; may be ''. */
  narration: string;
  /** The action. Receives the raw Playwright Page. May be a no-op for pure-narration steps. */
  run: (page: Page, ctx: StepContext<S>) => Promise<void>;
  /** Optional readiness hook awaited after run(); use when auto-waiting isn't enough. */
  waitFor?: (page: Page, ctx: StepContext<S>) => Promise<void>;
  /**
   * Anchor the cursor on a control at the start of the step — smooth-scrolls it
   * into frame and moves the fake cursor there — so narration about "this
   * control" has a visual focus even when the step's action is elsewhere or it
   * is pure narration. Return the locator to anchor on (may be async).
   * Decorative: a failure here is logged and skipped, never failing the render.
   */
  focus?: (page: Page, ctx: StepContext<S>) => Locator | Promise<Locator>;
  /**
   * Wait for a real page load-state signal after run()/waitFor() instead of
   * guessing a settleMs — e.g. 'networkidle' to let a router.refresh()'s
   * fetches quiesce. Best-effort and bounded (~5s): a page that never reaches
   * the state (websockets, polling) logs and proceeds rather than failing.
   * Composes with settleMs (which still adds its on-screen hold afterward).
   *
   * Caveat: 'networkidle' can resolve in the gap *before* a React
   * `startTransition`-deferred Server Action dispatches its request, settling on
   * the pre-mutation UI. For the standard `startTransition` + Server Action +
   * `router.refresh()` pattern, prefer `waitFor` on the committed UI (the value
   * flipping, a toast appearing) — see the "Settling" guide:
   * https://github.com/jbrecht/tutorial-forge/blob/main/docs/writing-tutorials.md#settling-waitfor-vs-settleuntil-vs-settlems
   */
  settleUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Extra hold time (ms) after both narration and action complete. Default 400. */
  settleMs?: number;
  /**
   * Opt this step out of the load-time pedagogy lints (see {@link LintOptions})
   * — for an intentionally long narration or a deliberately multi-action step.
   * Lints are warnings only and never fail a render; this just silences them.
   */
  lint?: false;
}

/**
 * Tunes the load-time pedagogy lints in {@link validateTutorial}. These are
 * advisory warnings about narration that demonstrates without teaching; they
 * are *never* fatal and never change the rendered video. Set `Tutorial.lint`
 * to `false` to turn them all off, or pass an object to tune them.
 */
export interface LintOptions {
  /**
   * Warn when a step's narration runs longer than this many words — a single
   * step should carry one idea (the segmenting principle). Default 60. Set to 0
   * to disable just this lint while keeping the others.
   */
  maxNarrationWords?: number;
  /**
   * Enable lower-confidence heuristic lints that are off by default because they
   * can misfire on intentional authoring choices: a step bundling several
   * instrumented actions (segmenting), and a tutorial whose first/last step
   * doesn't open with an objective or close with a recap (advance-organizer /
   * summary). Default false.
   */
  strict?: boolean;
}

export interface Tutorial<S = unknown> {
  /** Slug, used for output filenames. */
  id: string;
  title: string;
  description?: string;
  /**
   * Learning objectives — what the viewer will be able to do by the end. When
   * present, an intro card listing them is composited before the first step
   * (advance-organizer / pre-training). Localized via the `__objectives__`
   * reserved key in `translations` (newline-separated, one per line). Visual
   * only — to *speak* the objectives, put them in step-1 narration as usual.
   */
  objectives?: string[];
  /**
   * Closing recap — what the viewer accomplished. When present, a recap card is
   * composited after the final step (summary principle). Localized via the
   * `__summary__` reserved key in `translations`. Visual only.
   */
  summary?: string;
  steps: Step<S>[];
  /**
   * Per-language narration overrides: lang → (step id → translated line).
   * Usually loaded from sidecar files (<tutorial-file>.<lang>.json) by the CLI.
   */
  translations?: Record<string, Record<string, string>>;
  /**
   * Per-tutorial setup, run after the adapter's setup() and before step 1 (not
   * recorded). The adapter is the shared auth/seed baseline; this is per-video
   * state — e.g. seed an event for this tutorial only. Optional; tutorials
   * without it keep working through the adapter alone. Reads what the adapter
   * established via `ctx.state`.
   */
  setup?(page: Page, ctx: StepContext<S>): Promise<void>;
  /**
   * Per-tutorial cleanup, run after recording (not recorded) — after any
   * step-registered onTeardown thunks and before the adapter's teardown().
   * Failures are logged, not fatal.
   */
  teardown?(page: Page, ctx: StepContext<S>): Promise<void>;
  /**
   * Tune or disable the load-time pedagogy lints (see {@link LintOptions}).
   * Omitted → defaults on (over-long-narration only). `false` → all off.
   */
  lint?: LintOptions | false;
}

export interface TTSProvider {
  /** Unique key for cache partitioning, e.g. "elevenlabs:daniel:eleven_turbo_v2" */
  cacheKey: string;
  /** Synthesize one narration line to a WAV/MP3 file at outPath. Duration is measured by the pipeline via ffprobe, not trusted from the provider. */
  synthesize(text: string, outPath: string): Promise<void>;
}

export interface RenderOptions {
  tts: TTSProvider;
  /** Path to final .mp4 */
  output: string;
  /** Default: .forge/<tutorial-id>/ */
  workDir?: string;
  /** Default 1920x1080 */
  viewport?: { width: number; height: number };
  /** Default true */
  headless?: boolean;
  /** Inject fake cursor, default true */
  cursor?: boolean;
  /** Highlight clicked elements, default true */
  callouts?: boolean;
  /** Default 'sidecar' (writes .srt next to mp4). 'burn' composites browser-rendered caption pills. */
  subtitles?: 'burn' | 'sidecar' | 'off';
  /** Styling for burned-in captions. */
  captionStyle?: { fontSizePx?: number; maxWidthPx?: number; bottomMarginPx?: number };
  /**
   * Also export an animated GIF next to the MP4 (captions burned in by
   * default — GIFs are silent). Configure width/fps/step excerpt via object.
   */
  gif?: boolean | { widthPx?: number; fps?: number; captions?: boolean; steps?: string };
  /** Silence before step narration starts, default 300 */
  leadInMs?: number;
  /** Default false on success, true on failure */
  keepWorkDir?: boolean;
  /** Directory for the content-hashed TTS cache. Default: ~/.cache/tutorial-forge/tts */
  ttsCacheDir?: string;
  /** TTS synthesis concurrency, default 4 */
  ttsConcurrency?: number;
  /** Which phases to run. Default 'all'. */
  phase?: 'tts' | 'record' | 'post' | 'all';
  /** Render this language: narration comes from tutorial.translations[lang] and ctx.lang is set. */
  lang?: string;
  /** The language the spec's narration strings are written in. Default 'en'. */
  defaultLang?: string;
  /** Zoom toward click targets in post. true → factor 1.35. Default off. */
  zoom?: boolean | { factor?: number };
  /**
   * Compress narration-free spans longer than maxIdleMs at the given speed
   * (spinners, slow loads). Narration and click choreography always play at
   * 1x. true → { maxIdleMs: 2000, speed: 3 }. Default off.
   */
  idleSpeedup?: boolean | { maxIdleMs?: number; speed?: number };
  /**
   * Capture implementation. 'video' (default) uses Playwright recordVideo
   * with flash-based clock calibration; 'screencast' captures CDP frames with
   * explicit timestamps (exact clock alignment, VFR-aware). Chromium only.
   */
  recorder?: 'video' | 'screencast';
  /**
   * Debug mode: keep the work dir, record a Playwright trace (trace.zip),
   * write the full browser console log, and capture before/after screenshots
   * per step. Adds time per step; not for production renders.
   */
  debug?: boolean;
  /**
   * Authoring verification (#9): keep a settled screenshot per step and emit
   * a labeled contact-sheet PNG next to the video, so an author can confirm
   * every step framed the right thing without scrubbing the video. Default off.
   */
  contactSheet?: boolean;
  /**
   * Emit chapter markers (#35): an MP4 chapter track plus `.chapters.vtt` and
   * `.chapters.txt` sidecars, derived from per-step boundaries, so learners can
   * self-pace and jump between segments. One chapter per narrated step; silent
   * steps fold into the prior chapter. Default true.
   */
  chapters?: boolean;
  /**
   * Render the intro/recap cards from `Tutorial.objectives` / `Tutorial.summary`
   * (#37) and composite them into the MP4. Default true; set false to suppress
   * the cards for a render without editing the tutorial. No effect on a tutorial
   * that declares neither.
   */
  cards?: boolean;
}

export interface CalloutRecord {
  atMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ManifestStep {
  id: string;
  narration: string;
  audioFile: string | null;
  /** 0 for silent steps */
  audioDurationMs: number;
  /** Offset from video start */
  startMs: number;
  /** When run() began */
  actionStartMs: number;
  /** When run()+waitFor resolved */
  actionEndMs: number;
  /** When the step's hold completed */
  endMs: number;
  callouts: CalloutRecord[];
}

/** Written to workDir as manifest.json; the contract between record and post phases. */
export interface TimingManifest {
  tutorialId: string;
  /** Language this render used, if localized. */
  lang?: string;
  /** How the raw video was captured. Absent in pre-0.8 manifests (recordVideo). */
  capture?: {
    recorder: 'video' | 'screencast';
    rawFile: string;
    width: number;
    height: number;
    /** t=0 of the raw file IS the recording clock's zero (no flash detection needed). */
    clockAligned: boolean;
  };
  fps: number;
  recordingStartEpochMs: number;
  /** Offset (ms) into the raw webm where the recording clock's zero falls, derived from the calibration flash. 0 if undetected. */
  videoClockOffsetMs?: number;
  steps: ManifestStep[];
  totalDurationMs: number;
}

/** Diagnostic artifacts written when a step fails; all paths inside the kept work dir. */
export interface FailureArtifacts {
  /** Screenshot of the page at failure. */
  screenshot: string | null;
  /** Recent browser console + pageerror lines leading up to the failure. */
  consoleLog: string | null;
  /** Playwright trace (debug mode only) — open with `npx playwright show-trace`. */
  trace: string | null;
  workDir: string;
}

/** Thrown when a step's run()/waitFor() rejects during recording. */
export class StepError extends Error {
  constructor(
    public readonly tutorialId: string,
    public readonly stepId: string,
    public override readonly cause: unknown,
    public readonly artifacts?: FailureArtifacts,
  ) {
    const lines = [
      `Step "${stepId}" of tutorial "${tutorialId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
    if (artifacts?.screenshot) lines.push(`  screenshot: ${artifacts.screenshot}`);
    if (artifacts?.consoleLog) lines.push(`  console:    ${artifacts.consoleLog}`);
    if (artifacts?.trace) lines.push(`  trace:      ${artifacts.trace} (npx playwright show-trace)`);
    super(lines.join('\n'));
    this.name = 'StepError';
  }
}
