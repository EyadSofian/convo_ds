import { spawn } from 'node:child_process';
import { ApiHttpError } from '../http-error.js';

/** Bounded, local-only conversion from browser recordings to WhatsApp Opus. */
export function convertVoice(input: unknown): Promise<Buffer> {
  if (typeof input !== 'string' || input.length === 0 || input.length > 470000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new ApiHttpError(422, 'voice_invalid', 'Record a voice message of up to 90 seconds.');
  }
  const bytes = Buffer.from(input, 'base64');
  if (bytes.length > 350000 || bytes.toString('base64') !== input) {
    throw new ApiHttpError(422, 'voice_invalid', 'The recording is too large or invalid. Record up to 90 seconds.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
      '-vn', '-t', '91', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1',
    ], { timeout: 12000, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 400000) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', () => reject(new ApiHttpError(503, 'voice_conversion_unavailable', 'Voice recording is temporarily unavailable.')));
    child.on('close', (code) => {
      const audio = Buffer.concat(chunks);
      if (code !== 0 || audio.length < 27 || total > 400000 || !audio.subarray(0, 4).equals(Buffer.from('OggS'))) {
        reject(new ApiHttpError(422, 'voice_invalid', 'This recording could not be read. Record it again.'));
        return;
      }
      const lastPage = audio.lastIndexOf(Buffer.from('OggS'));
      if (lastPage + 27 > audio.length) {
        reject(new ApiHttpError(422, 'voice_invalid', 'This recording could not be read. Record it again.'));
        return;
      }
      if (audio.readBigUInt64LE(lastPage + 6) > 90n * 48000n + 48000n / 2n) {
        reject(new ApiHttpError(422, 'voice_too_long', 'Record a voice message of up to 90 seconds.'));
        return;
      }
      resolve(audio);
    });
    child.stdin.end(bytes);
  });
}
