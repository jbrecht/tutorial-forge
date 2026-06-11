import { defineConfig, SilentProvider, ElevenLabs, OpenAITTS, type TTSProvider, type TutorialAdapter } from 'tutorial-forge';

const baseURL = process.env.APP_URL ?? 'http://localhost:4173';

export const adapter: TutorialAdapter = {
  baseURL,
  async setup(page) {
    await page.goto(baseURL);
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },
};

function pickTTS(): TTSProvider {
  switch (process.env.FORGE_TTS) {
    case 'elevenlabs':
      return ElevenLabs({ voiceId: process.env.ELEVENLABS_VOICE_ID ?? 'onwK4e9ZLuTAKqWW03F9' });
    case 'openai':
      return OpenAITTS({ voice: 'nova' });
    default:
      return SilentProvider();
  }
}

/**
 * Per-language voices from env: ELEVENLABS_VOICE_ID_ES=<id> → Spanish voice.
 * Use underscores for region tags (ELEVENLABS_VOICE_ID_PT_BR → pt-BR).
 * Languages without an entry fall back to the main tts provider.
 */
function pickTTSByLang(): Record<string, TTSProvider> | undefined {
  if (process.env.FORGE_TTS !== 'elevenlabs') return undefined;
  const prefix = 'ELEVENLABS_VOICE_ID_';
  const entries = Object.entries(process.env)
    .filter(([key, value]) => key.startsWith(prefix) && value)
    .map(([key, value]) => [
      key.slice(prefix.length).toLowerCase().replace(/_/g, '-'),
      ElevenLabs({ voiceId: value! }),
    ] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export default defineConfig({
  adapter,
  tts: pickTTS(),
  ttsByLang: pickTTSByLang(),
  outDir: 'tutorials/dist',
  tutorials: ['tutorials/**/*.tutorial.ts'],
  viewport: { width: 1920, height: 1080 },
});
