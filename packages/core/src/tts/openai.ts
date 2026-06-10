import { writeFile } from 'node:fs/promises';
import type { TTSProvider } from '../types.js';

export interface OpenAITTSOptions {
  voice?: string;
  apiKey?: string;
  model?: string;
  /** 0.25..4.0, default 1.0 */
  speed?: number;
}

export function OpenAITTS(opts: OpenAITTSOptions = {}): TTSProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? 'gpt-4o-mini-tts';
  const voice = opts.voice ?? 'alloy';
  return {
    cacheKey: `openai:${voice}:${model}:${opts.speed ?? 1}`,
    async synthesize(text: string, outPath: string): Promise<void> {
      if (!apiKey) throw new Error('OpenAI TTS: missing apiKey (set OPENAI_API_KEY)');
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          speed: opts.speed ?? 1,
          response_format: 'wav',
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI TTS: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    },
  };
}
