import { writeFile } from 'node:fs/promises';
import type { TTSProvider } from '../types.js';
import { estimateDurationMs } from './provider.js';

const SAMPLE_RATE = 48000;

/**
 * Generates silence whose duration follows the word-count heuristic.
 * Deterministic, offline, no ffmpeg needed — for tests and CI.
 */
export function SilentProvider(): TTSProvider {
  return {
    cacheKey: 'silent:v1',
    async synthesize(text: string, outPath: string): Promise<void> {
      const ms = estimateDurationMs(text);
      await writeFile(outPath, silentWav(ms));
    },
  };
}

/** Minimal 16-bit mono PCM WAV of the given duration. */
export function silentWav(durationMs: number, sampleRate = SAMPLE_RATE): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
