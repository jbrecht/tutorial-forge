import { execa } from 'execa';
import type { TTSProvider } from '../types.js';

export interface PiperOptions {
  /** Path to a piper voice .onnx model. */
  model: string;
  /** Piper binary, default "piper" on PATH. */
  binary?: string;
  speakerId?: number;
}

/** Local/offline TTS via the piper CLI (https://github.com/rhasspy/piper). */
export function Piper(opts: PiperOptions): TTSProvider {
  const binary = opts.binary ?? 'piper';
  return {
    cacheKey: `piper:${opts.model}:${opts.speakerId ?? 0}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      const args = ['--model', opts.model, '--output_file', outPath];
      if (opts.speakerId !== undefined) args.push('--speaker', String(opts.speakerId));
      try {
        await execa(binary, args, { input: text });
      } catch (err) {
        throw new Error(
          `Piper synthesis failed (is "${binary}" installed and the model path valid?): ${
            (err as { shortMessage?: string }).shortMessage ?? err
          }`,
        );
      }
    },
  };
}
