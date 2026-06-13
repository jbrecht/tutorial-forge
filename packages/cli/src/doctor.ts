import { existsSync } from 'node:fs';
import { ffmpegVersion } from 'tutorial-forge';
import { loadConfig } from './load.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Quick GET against the app's baseURL. Any HTTP response — including 4xx/5xx —
 * means the server is up; only a transport error (connection refused, DNS
 * failure, timeout) counts as unreachable.
 */
async function probeReachable(baseURL: string, timeoutMs = 3000): Promise<Check> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseURL, { method: 'GET', signal: controller.signal, redirect: 'manual' });
    return { name: 'app reachable', ok: true, detail: `${baseURL} (HTTP ${res.status})` };
  } catch (err) {
    // Node wraps the transport error (ECONNREFUSED, ENOTFOUND, …) in err.cause;
    // surface that over the generic "fetch failed".
    const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
    const reason = controller.signal.aborted
      ? `no response within ${timeoutMs}ms`
      : cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    return {
      name: 'app reachable',
      ok: false,
      detail: `${baseURL} — ${reason} (is the dev server running?)`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function doctorCommand(opts: { config?: string } = {}): Promise<void> {
  const checks: Check[] = [];

  const nodeMajor = parseInt(process.versions.node.split('.')[0]!, 10);
  checks.push({
    name: 'node',
    ok: nodeMajor >= 20,
    detail: `v${process.versions.node}${nodeMajor >= 20 ? '' : ' (need >= 20)'}`,
  });

  const ffmpeg = await ffmpegVersion('ffmpeg');
  const ffmpegMajor = ffmpeg ? parseInt(ffmpeg, 10) : 0;
  checks.push({
    name: 'ffmpeg',
    ok: !!ffmpeg && (Number.isNaN(ffmpegMajor) || ffmpegMajor >= 6),
    detail: ffmpeg ? `version ${ffmpeg}${!Number.isNaN(ffmpegMajor) && ffmpegMajor < 6 ? ' (need >= 6)' : ''}` : 'not found on PATH',
  });
  const ffprobe = await ffmpegVersion('ffprobe');
  checks.push({ name: 'ffprobe', ok: !!ffprobe, detail: ffprobe ? `version ${ffprobe}` : 'not found on PATH' });


  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    const installed = !!exe && existsSync(exe);
    checks.push({
      name: 'playwright chromium',
      ok: installed,
      detail: installed ? exe : 'not installed — run: npx playwright install chromium',
    });
  } catch {
    checks.push({ name: 'playwright chromium', ok: false, detail: 'playwright not installed' });
  }

  for (const env of ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY']) {
    checks.push({
      name: env,
      ok: true, // informational: only needed if that provider is configured
      detail: process.env[env] ? 'set' : 'not set (only needed for that provider)',
    });
  }

  // App reachability: only when we can resolve a baseURL from the config.
  // A missing/broken config is the render command's problem to report, not
  // doctor's — here it just means we skip the probe rather than fail.
  try {
    const config = await loadConfig(process.cwd(), opts.config);
    checks.push(await probeReachable(config.adapter.baseURL));
  } catch {
    checks.push({
      name: 'app reachable',
      ok: true,
      detail: 'skipped (no forge.config found — run from a project to probe baseURL)',
    });
  }

  let failed = false;
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}
