export type { TTSProvider } from '../types.js';

/**
 * Fallback duration estimator: average speech runs ~160 wpm; 380ms/word with a
 * 1.2s floor. Also the deterministic duration used by SilentProvider.
 */
export function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1200, words * 380);
}
