import { z } from 'zod';
import type { TutorialAdapter, TTSProvider } from './types.js';

/** Shape of forge.config.ts in a consumer repo. CLI flags override these; these override defaults. */
export interface ForgeConfig {
  adapter: TutorialAdapter;
  tts: TTSProvider;
  /** Where final videos land. Default: tutorials/dist */
  outDir?: string;
  /** Globs for tutorial discovery. Default: ["**\/*.tutorial.ts"] */
  tutorials?: string[];
  viewport?: { width: number; height: number };
  headless?: boolean;
  cursor?: boolean;
  callouts?: boolean;
  subtitles?: 'burn' | 'sidecar' | 'off';
  leadInMs?: number;
  keepWorkDir?: boolean;
  ttsCacheDir?: string;
  ttsConcurrency?: number;
  /** Languages rendered by default (overridable with --lang). Omit for source-language only. */
  languages?: string[];
  /** The language tutorial narration is written in. Default 'en'. */
  defaultLang?: string;
  /** Per-language TTS provider override (e.g. a different voice per language). Falls back to tts. */
  ttsByLang?: Record<string, TTSProvider>;
  /** Zoom toward click targets in post. true → factor 1.35. Default off. */
  zoom?: boolean | { factor?: number };
  /** Compress narration-free spans (spinners, slow loads). true → { maxIdleMs: 2000, speed: 3 }. */
  idleSpeedup?: boolean | { maxIdleMs?: number; speed?: number };
  /** Styling for burned-in captions (subtitles: 'burn'). */
  captionStyle?: { fontSizePx?: number; maxWidthPx?: number; bottomMarginPx?: number };
  /** Also export an animated GIF per tutorial (captioned by default). */
  gif?: boolean | { widthPx?: number; fps?: number; captions?: boolean; steps?: string };
  /** Capture implementation: 'video' (default) or 'screencast' (exact clock alignment). */
  recorder?: 'video' | 'screencast';
  /** Emit a per-step contact sheet next to each video for authoring verification (#9). Default off. */
  contactSheet?: boolean;
}

const configSchema = z.object({
  adapter: z.object({
    baseURL: z.string().url(),
    setup: z.function(),
    teardown: z.function().optional(),
  }),
  tts: z.object({
    cacheKey: z.string().min(1),
    synthesize: z.function(),
  }),
  outDir: z.string().optional(),
  tutorials: z.array(z.string()).optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  headless: z.boolean().optional(),
  cursor: z.boolean().optional(),
  callouts: z.boolean().optional(),
  subtitles: z.enum(['burn', 'sidecar', 'off']).optional(),
  leadInMs: z.number().nonnegative().optional(),
  keepWorkDir: z.boolean().optional(),
  ttsCacheDir: z.string().optional(),
  ttsConcurrency: z.number().int().positive().optional(),
  languages: z.array(z.string().min(2)).optional(),
  defaultLang: z.string().min(2).optional(),
  ttsByLang: z
    .record(z.object({ cacheKey: z.string().min(1), synthesize: z.function() }))
    .optional(),
  zoom: z
    .union([z.boolean(), z.object({ factor: z.number().min(1).max(3).optional() })])
    .optional(),
  idleSpeedup: z
    .union([
      z.boolean(),
      z.object({
        maxIdleMs: z.number().positive().optional(),
        speed: z.number().min(1.5).max(10).optional(),
      }),
    ])
    .optional(),
  captionStyle: z
    .object({
      fontSizePx: z.number().positive().optional(),
      maxWidthPx: z.number().positive().optional(),
      bottomMarginPx: z.number().nonnegative().optional(),
    })
    .optional(),
  gif: z
    .union([
      z.boolean(),
      z.object({
        widthPx: z.number().int().positive().optional(),
        fps: z.number().positive().max(30).optional(),
        captions: z.boolean().optional(),
        steps: z.string().optional(),
      }),
    ])
    .optional(),
  recorder: z.enum(['video', 'screencast']).optional(),
  contactSheet: z.boolean().optional(),
});

export function defineConfig(config: ForgeConfig): ForgeConfig {
  return config;
}

/** Validate a loaded config object (e.g. from forge.config.ts). Throws with a readable message. */
export function validateConfig(config: unknown): ForgeConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid forge config:\n${issues.join('\n')}`);
  }
  return config as ForgeConfig;
}
