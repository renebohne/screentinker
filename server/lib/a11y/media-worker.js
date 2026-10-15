'use strict';

/*
 * Worker-thread host for the video/GIF checks (lib/a11y/media.js is the only caller).
 *
 * ffmpeg does the decoding in its own process; this thread does the per-frame arithmetic, so neither
 * the decode nor the counting ever runs on the event loop that answers device heartbeats. One job per
 * message, one reply per job, errors as replies (an undecodable upload must not kill the thread and
 * the jobs queued behind it).
 *
 * ⚠️ BOUNDED THREE WAYS, because the input is an upload: ffmpeg is told to stop after `maxSec` of
 * output, this thread kills ffmpeg at `timeoutMs` whatever it is doing, and stdout is capped at
 * exactly the bytes `maxSec` of frames can produce. lib/a11y/media.js adds a backstop that terminates
 * this whole thread if it stops answering.
 */

const { parentPort } = require('worker_threads');
const { spawn, execFile } = require('child_process');
const { FlashDetector, GRID_W, GRID_H, FRAME_BYTES } = require('./flash');

function probe(file, timeoutMs) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: Math.min(timeoutMs, 20000), maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const info = JSON.parse(stdout);
          const streams = Array.isArray(info.streams) ? info.streams : [];
          const subs = streams.filter((s) => s.codec_type === 'subtitle');
          resolve({
            has_video: streams.some((s) => s.codec_type === 'video'),
            has_audio: streams.some((s) => s.codec_type === 'audio'),
            embedded_subtitles: subs.length,
            duration: Number(info.format && info.format.duration) || null,
          });
        } catch { resolve(null); }
      });
  });
}

function flashes(file, { fps, maxSec, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const det = new FlashDetector(fps);
    const args = ['-v', 'error', '-nostdin', '-i', file, '-an', '-sn', '-t', String(maxSec),
      '-vf', `fps=${fps},scale=${GRID_W}:${GRID_H}:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = FRAME_BYTES * (Math.ceil(fps * maxSec) + 2);
    let pending = Buffer.alloc(0);
    let total = 0;
    let errText = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { ff.kill('SIGKILL'); finish(reject, Object.assign(new Error('analysis timed out'), { code: 'TIMEOUT' })); }, timeoutMs);
    ff.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > cap) { ff.kill('SIGKILL'); return; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      while (pending.length - off >= FRAME_BYTES) { det.push(pending.subarray(off, off + FRAME_BYTES)); off += FRAME_BYTES; }
      pending = off ? Buffer.from(pending.subarray(off)) : pending;
    });
    ff.stderr.on('data', (c) => { if (errText.length < 2000) errText += c.toString(); });
    ff.on('error', (e) => finish(reject, e));
    ff.on('close', (code) => {
      if (det.frame === 0) return finish(reject, new Error(`ffmpeg produced no frames${code ? ` (exit ${code})` : ''}: ${errText.trim().slice(0, 200)}`));
      finish(resolve, det.result());
    });
  });
}

parentPort.on('message', async (job) => {
  try {
    if (job.op !== 'video') throw new Error(`unknown media op: ${job.op}`);
    const info = await probe(job.path, job.timeoutMs);
    if (!info) throw new Error('ffprobe could not read the file');
    const result = { ...info, flash: null, analysed_sec: 0, truncated: false };
    if (info.has_video) {
      const f = await flashes(job.path, job);
      result.flash = { general: f.general, red: f.red };
      result.analysed_sec = f.seconds;
      result.truncated = !!(info.duration && info.duration > job.maxSec + 0.5);
    }
    parentPort.postMessage({ id: job.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: job.id, ok: false, error: err && err.message ? err.message : String(err), code: err && err.code });
  }
});
