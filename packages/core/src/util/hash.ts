import { createHash } from 'node:crypto';

export function sha256(...parts: string[]): string {
  const h = createHash('sha256');
  h.update(parts.join('\0'));
  return h.digest('hex');
}
