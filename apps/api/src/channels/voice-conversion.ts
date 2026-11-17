import { spawn } from 'node:child_process';
import { ApiHttpError } from '../http-error.js';

const MAX_SAMPLES = 90n * 48000n + 48000n / 2n;

/**
 * Bounded, local-only conversion from browser recordings to WhatsApp Opus.
 *
 * `asetpts=N/SR/TB` is the part that matters for playback. Chrome stamps its
 * WebM blocks in whole milliseconds with a millisecond or two of jitter, and
 * without it ffmpeg carries that jitter into the Ogg granule positions: pages
 * then claim fewer samples than they hold. WhatsApp on Android refuses such a
 * file outright ("something is wrong with the audio file") even though Web and
 * iPhone play it. Re-timing from the decoded sample count makes every granule
 * exact.
 */
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
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-t', '91', '-af', 'asetpts=N/SR/TB',
      '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', 'pipe:1',
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
      const samples = code === 0 && total <= 400000 ? oggOpusSamples(audio) : null;
      if (samples === null) {
        reject(new ApiHttpError(422, 'voice_invalid', 'This recording could not be read. Record it again.'));
        return;
      }
      if (samples > MAX_SAMPLES) {
        reject(new ApiHttpError(422, 'voice_too_long', 'Record a voice message of up to 90 seconds.'));
        return;
      }
      resolve(audio);
    });
    child.stdin.end(bytes);
  });
}

/**
 * The playable length of a mono Ogg Opus stream in 48 kHz samples, or `null`
 * when the stream is one a strict player would refuse (RFC 7845).
 *
 * Checked here rather than trusted from ffmpeg because a malformed file is not
 * rejected by Meta: it uploads, shows a duration and a waveform, and then fails
 * only on the customer's phone, where nobody on our side can see it.
 */
export function oggOpusSamples(audio: Buffer): bigint | null {
  let stage: 'head' | 'tags' | 'audio' = 'head';
  let pending: Buffer[] = [];
  let offset = 0;
  let pages = 0;
  let counted = 0n;
  let granule: bigint | null = null;
  let serial: number | null = null;
  let ended = false;
  while (offset < audio.length) {
    if (ended || offset + 27 > audio.length || audio.toString('latin1', offset, offset + 4) !== 'OggS' || audio[offset + 4] !== 0) return null;
    const flags = audio[offset + 5] as number;
    const pageGranule = audio.readBigUInt64LE(offset + 6);
    const pageSerial = audio.readUInt32LE(offset + 14);
    const segments = audio[offset + 26] as number;
    let cursor = offset + 27 + segments;
    if (cursor > audio.length || (serial !== null && pageSerial !== serial) || ((flags & 0x02) !== 0) !== (pages === 0)) return null;
    serial = pageSerial;
    let audioPackets = 0;
    for (let index = 0; index < segments; index += 1) {
      const lace = audio[offset + 27 + index] as number;
      if (cursor + lace > audio.length) return null;
      pending.push(audio.subarray(cursor, cursor + lace));
      cursor += lace;
      if (lace === 255) continue;
      const packet = Buffer.concat(pending);
      pending = [];
      if (stage === 'head') {
        // Mono, as WhatsApp requires of a voice message.
        if (packet.length < 19 || packet.toString('latin1', 0, 8) !== 'OpusHead' || packet[9] !== 1) return null;
        stage = 'tags';
      } else if (stage === 'tags') {
        if (packet.toString('latin1', 0, 8) !== 'OpusTags') return null;
        stage = 'audio';
      } else {
        const duration = opusPacketSamples(packet);
        if (duration === null) return null;
        counted += duration;
        audioPackets += 1;
      }
    }
    ended = (flags & 0x04) !== 0;
    if (audioPackets > 0) {
      // A granule may trail its packets only on the last page, where it trims
      // the encoder's padding. Anywhere else the page claims fewer samples than
      // it holds, which is exactly the file Android would not play.
      if (pageGranule > counted || (!ended && pageGranule !== counted)) return null;
      granule = pageGranule;
    }
    pages += 1;
    offset = cursor;
  }
  return ended && pending.length === 0 ? granule : null;
}

/** Samples in one Opus packet at 48 kHz, from its TOC byte (RFC 6716 §3.1). */
function opusPacketSamples(packet: Buffer): bigint | null {
  if (packet.length === 0) return null;
  const toc = packet[0] as number;
  const config = toc >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] as number
    : config < 16 ? [480, 960][config & 1] as number
      : [120, 240, 480, 960][config & 3] as number;
  const code = toc & 3;
  if (code === 3 && packet.length < 2) return null;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] as number) & 0x3f : 2;
  return frames === 0 || frames * frame > 5760 ? null : BigInt(frames * frame);
}
