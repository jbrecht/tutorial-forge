type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.FORGE_LOG ?? 'info') as Level;
  return LEVELS[env] ?? 20;
}

function emit(level: Level, msg: string): void {
  if (LEVELS[level] < threshold()) return;
  const line = `[forge] ${level === 'info' ? '' : level + ': '}${msg}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg: string) => emit('debug', msg),
  info: (msg: string) => emit('info', msg),
  warn: (msg: string) => emit('warn', msg),
  error: (msg: string) => emit('error', msg),
};
