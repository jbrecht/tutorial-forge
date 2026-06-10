import { writeFile } from 'node:fs/promises';
import type { TTSProvider } from '../types.js';

export interface ElevenLabsOptions {
  voiceId: string;
  apiKey?: string;
  modelId?: string;
  /** 0..1, provider default 0.5 */
  stability?: number;
  /** 0..1, provider default 0.75 */
  similarityBoost?: number;
}

export function ElevenLabs(opts: ElevenLabsOptions): TTSProvider {
  const apiKey = opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
  const modelId = opts.modelId ?? 'eleven_turbo_v2_5';
  return {
    cacheKey: `elevenlabs:${opts.voiceId}:${modelId}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      if (!apiKey) throw new Error('ElevenLabs: missing apiKey (set ELEVENLABS_API_KEY)');
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
              stability: opts.stability ?? 0.5,
              similarity_boost: opts.similarityBoost ?? 0.75,
            },
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`ElevenLabs: HTTP ${res.status} ${await safeBody(res)}`);
      }
      await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    },
  };
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
