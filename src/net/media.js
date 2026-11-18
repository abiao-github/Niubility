'use strict';

// ffmpeg 辅助：HLS 的 TS 分片、DASH 的 video/audio 分离轨道都需要封装一下。
// 没有 ffmpeg 时降级：保留拼接后的原始文件（.ts / video-only .mp4）。

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = null;
let probed = false;

function findFfmpeg() {
  if (probed) return ffmpegPath;
  probed = true;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { ffmpegPath = c; return ffmpegPath; } } catch { /* ignore */ }
  }
  const envPath = (process.env.PATH || '').split(path.delimiter);
  for (const dir of envPath) {
    const c = path.join(dir, exe);
    try { if (fs.existsSync(c)) { ffmpegPath = c; return ffmpegPath; } } catch { /* ignore */ }
  }
  return null;
}

function runFfmpeg(args, { timeout = 120000 } = {}) {
  const bin = findFfmpeg();
  if (!bin) return Promise.reject(new Error('未找到 ffmpeg'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').split('\n').filter(Boolean).slice(-3).join(' / ');
        return reject(new Error('ffmpeg 失败: ' + tail.split('\n')[0]));
      }
      resolve(stdout);
    });
  });
}

/** 单个文件重新封装（TS → MP4，音轨需要 aac_adtstoasc） */
async function remuxFile(input, output) {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    output
  ]);
  return output;
}

/** 视频轨 + 音频轨合成一个 MP4 */
async function muxTracks(videoInput, audioInput, output) {
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoInput,
    '-i', audioInput,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    output
  ]);
  return output;
}

/** 用 ffprobe/ffmpeg 读时长（用于日志与测试） */
async function mediaInfo(file) {
  const bin = findFfmpeg();
  if (!bin) return null;
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-i', file], { timeout: 30000 }, (_err, _out, stderr) => {
      const text = String(stderr || '');
      const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text);
      const video = /Stream #\d+:\d+.*: Video:/.test(text);
      const audio = /Stream #\d+:\d+.*: Audio:/.test(text);
      const seconds = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0;
      resolve({ seconds, video, audio });
    });
  });
}

module.exports = { findFfmpeg, runFfmpeg, remuxFile, muxTracks, mediaInfo };
