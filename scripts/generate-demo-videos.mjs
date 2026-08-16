#!/usr/bin/env node
/**
 * Regenerate the two synthetic demo MP4s for modules/installable/demo-video.
 * Development-only helper; requires ffmpeg on PATH.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'modules', 'installable', 'demo-video', 'data', 'videos');

const jobs = [
  { file: 'camera_001.mp4', filter: null },
  { file: 'camera_002.mp4', filter: 'hue=h=120' },
];

for (const job of jobs) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=60',
    ...(job.filter ? ['-vf', job.filter] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', path.join(outDir, job.file),
  ];
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${job.file}`);
  console.log(`generated ${job.file}`);
}
