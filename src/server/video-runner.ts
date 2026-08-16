const { execFile } = require('node:child_process');
const fs = require('node:fs');

import type { ChildProcess } from 'node:child_process';
import type { Executable, VideoExecutables } from './runtime-resolver.js';
import { signalProcessTree } from './process-tree.js';

export type VideoProbeResult = { durationSeconds: number; width: number; height: number };

export type VideoRunOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

/**
 * Controlled ffmpeg/ffprobe executor. All invocations use fixed argument
 * arrays built by the Video Service — the Agent can never inject arbitrary
 * flags, inputs or outputs.
 */
export class VideoRunner {
  private children = new Set<ChildProcess>();

  constructor(private executables: VideoExecutables) {}

  private run(executable: Executable, args: string[], opts: VideoRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = execFile(
        executable.command,
        [...executable.args, ...args],
        {
          encoding: 'utf8',
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_CAPTURE_BYTES,
          signal: opts.signal,
          detached: process.platform !== 'win32',
          env: { ...process.env },
        },
        (error: Error | null, stdout: string, stderr: string) => {
          this.children.delete(child);
          if (error) {
            const detail = String(stderr || '').trim().split('\n').slice(-3).join(' ');
            const wrapped = new Error(detail || error.message) as Error & { stderr?: string };
            wrapped.stderr = stderr;
            reject(wrapped);
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
      this.children.add(child);
    });
  }

  async probe(filePath: string, opts: VideoRunOptions = {}): Promise<VideoProbeResult> {
    const { stdout } = await this.run(this.executables.ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '--', filePath,
    ], { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 });
    let parsed: { format?: { duration?: unknown }; streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown }> };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('ffprobe returned unreadable output');
    }
    const durationSeconds = Number(parsed.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('ffprobe could not determine the video duration');
    const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
    const width = Number(videoStream?.width) || 0;
    const height = Number(videoStream?.height) || 0;
    return { durationSeconds, width, height };
  }

  /** Extract one JPEG frame at a relative offset (seconds) from input. */
  async snapshot(input: { inputPath: string; offsetSeconds: number; outputPath: string; maxWidth?: number }, opts: VideoRunOptions = {}) {
    const maxWidth = input.maxWidth ?? 1280;
    await this.run(this.executables.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', input.offsetSeconds.toFixed(3),
      '-i', input.inputPath,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', '3',
      '-y', input.outputPath,
    ], { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 });
    assertOutput(input.outputPath, 'snapshot');
  }

  /**
   * Frame-accurate clip: always re-encodes to the Phase 0 Input Spec
   * (MP4 / H.264 yuv420p / AAC / faststart). Stream copy is not allowed.
   */
  async clip(input: { inputPath: string; startSeconds: number; durationSeconds: number; outputPath: string }, opts: VideoRunOptions = {}) {
    await this.run(this.executables.ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', input.startSeconds.toFixed(3),
      '-i', input.inputPath,
      '-t', input.durationSeconds.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', input.outputPath,
    ], { ...opts, timeoutMs: opts.timeoutMs ?? 300_000 });
    assertOutput(input.outputPath, 'clip');
  }

  terminateAll() {
    for (const child of this.children) signalProcessTree(child, 'SIGTERM');
    this.children.clear();
  }
}

function assertOutput(outputPath: string, label: string) {
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size === 0) {
    throw new Error(`ffmpeg did not produce a valid ${label} output`);
  }
}
