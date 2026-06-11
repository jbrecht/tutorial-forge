import type { Page } from 'playwright';

/**
 * Ring buffer of browser console output, page errors, and failed requests.
 * Always attached during recording (cheap); flushed to disk on step failure
 * and, in debug mode, in full at the end of the run.
 */
export class ConsoleCapture {
  private lines: string[] = [];

  constructor(private readonly maxLines = 1000) {}

  attach(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning' || type === 'log' || type === 'info' || type === 'debug') {
        this.push(`[console.${type}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => this.push(`[pageerror] ${err.message}`));
    page.on('requestfailed', (req) =>
      this.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`),
    );
  }

  /** Mark a step boundary so the log reads in step context. */
  mark(label: string): void {
    this.push(`——— ${label} ———`);
  }

  private push(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > this.maxLines) this.lines.shift();
  }

  recent(n = 80): string[] {
    return this.lines.slice(-n);
  }

  all(): string[] {
    return [...this.lines];
  }
}
