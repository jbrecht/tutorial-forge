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

export default defineConfig({
  adapter,
  tts: pickTTS(),
  outDir: 'tutorials/dist',
  tutorials: ['tutorials/**/*.tutorial.ts'],
  viewport: { width: 1920, height: 1080 },
});
