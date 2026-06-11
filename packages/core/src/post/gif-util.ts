import type { TimingManifest } from '../types.js';

export function stepIndexById(manifest: TimingManifest, id: string): number {
  const index = manifest.steps.findIndex((s) => s.id === id);
  if (index === -1) {
    throw new Error(
      `No step "${id}" in tutorial "${manifest.tutorialId}" (steps: ${manifest.steps.map((s) => s.id).join(', ')})`,
    );
  }
  return index;
}
