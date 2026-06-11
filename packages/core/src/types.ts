import type { Page } from 'playwright';

/** Passed to adapter and step callbacks; lets app code react to the render language. */
export interface StepContext {
  /** The language being rendered (from RenderOptions.lang / --lang), if any. */
  lang?: string;
}

/** Gets the target app into a known, recordable state. The only app-specific code. */
export interface TutorialAdapter {
  /** Base URL of the running app, e.g. http://localhost:3000 */
  baseURL: string;
  /** Auth, seeding, navigation to a starting screen. Runs after page creation, before step 1. Excluded from the final video by default. */
  setup(page: Page, ctx: StepContext): Promise<void>;
  /** Optional cleanup after recording (delete seeded data, logout). Never recorded. */
  teardown?(page: Page, ctx: StepContext): Promise<void>;
}

export interface Step {
  /** Stable id, auto-derived from index if omitted. Used in manifest, cache keys, logs, translation tables. */
  id?: string;
  /** The narration line spoken over this step, in the source language. Plain text; may be ''. */
  narration: string;
  /** The action. Receives the raw Playwright Page. May be a no-op for pure-narration steps. */
  run: (page: Page, ctx: StepContext) => Promise<void>;
  /** Optional readiness hook awaited after run(); use when auto-waiting isn't enough. */
  waitFor?: (page: Page, ctx: StepContext) => Promise<void>;
  /** Extra hold time (ms) after both narration and action complete. Default 400. */
  settleMs?: number;
}

export interface Tutorial {
  /** Slug, used for output filenames. */
  id: string;
  title: string;
  description?: string;
  steps: Step[];
  /**
   * Per-language narration overrides: lang → (step id → translated line).
   * Usually loaded from sidecar files (<tutorial-file>.<lang>.json) by the CLI.
   */
  translations?: Record<string, Record<string, string>>;
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
