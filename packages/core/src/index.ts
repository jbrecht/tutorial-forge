// Public API surface — re-exports only.

export type {
  Tutorial,
  Step,
  StepContext,
  TutorialAdapter,
  TTSProvider,
  RenderOptions,
  TimingManifest,
  ManifestStep,
  CalloutRecord,
} from './types.js';
export { StepError, type FailureArtifacts } from './types.js';

export { tutorial, step, validateTutorial, stepId } from './spec.js';
export { localizeTutorial, availableLanguages } from './i18n.js';
export { defineConfig, validateConfig, type ForgeConfig } from './config.js';

export { render, type RenderResult } from './pipeline/render.js';
export { runTTSPhase, loadTTSResult } from './pipeline/tts.js';
export { runRecordPhase, loadManifest, RAW_VIDEO_FILE, MANIFEST_FILE } from './pipeline/record.js';
export {
  createRecorder,
  buildConcatList,
  buildAssembleArgs,
  type Recorder,
  type RecorderKind,
  type CaptureInfo,
} from './pipeline/recorder.js';
export { runPostPhase } from './pipeline/post.js';
export {
  renderContactSheet,
  contactSheetHtml,
  contactSheetEntries,
  contactSheetPath,
  DEFAULT_CONTACT_SHEET_STYLE,
  type ContactSheetEntry,
  type ContactSheetStyle,
} from './pipeline/contact-sheet.js';
export { previewStep, type PreviewOptions, type PreviewResult } from './pipeline/preview.js';

export { SilentProvider } from './tts/silent.js';
export { Piper, type PiperOptions } from './tts/piper.js';
export { ElevenLabs, type ElevenLabsOptions } from './tts/elevenlabs.js';
export { OpenAITTS, type OpenAITTSOptions } from './tts/openai.js';
export { estimateDurationMs } from './tts/provider.js';
export { defaultCacheDir, synthesizeCached } from './tts/cache.js';

export { generateSrt, computeCues, srtTime, wrapText, type Cue } from './post/subtitles.js';
export { captionHtml, renderCaptionImages, DEFAULT_CAPTION_STYLE, type CaptionStyle } from './post/captions.js';
export { buildGifArgs, resolveGifWindow, DEFAULT_GIF, type GifConfig, type GifWindow } from './post/gif.js';
export {
  buildMergeArgs,
  probeDurationMs,
  detectFlashOffsetMs,
  parseFlashFromMetadata,
  normalizeToWav,
  ffmpegVersion,
  ffmpegHasFilter,
  type MergeArgsInput,
} from './post/ffmpeg.js';
export { stepHoldUntilMs } from './browser/timing.js';
export { computeZoomWindows, buildZoomFilter, DEFAULT_ZOOM_FACTOR, type ZoomWindow } from './post/zoom.js';
export {
  computeIdleSegments,
  buildTimeMap,
  buildRetimeFilter,
  DEFAULT_IDLE_SPEEDUP,
  type SpeedSegment,
  type TimeMap,
} from './post/retime.js';
