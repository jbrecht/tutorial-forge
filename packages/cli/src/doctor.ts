import { existsSync } from 'node:fs';
import { ffmpegVersion } from 'tutorial-forge';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctorCommand(): Promise<void> {
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

  let failed = false;
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}
