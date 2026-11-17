import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { convertVoice, oggOpusSamples } from './voice-conversion.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(process as never);
  return process;
}

const fixture = (name: string): Buffer => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

/** One Ogg page; the CRC is left at zero because nothing here relies on it. */
function page(flags: number, granule: bigint, packets: readonly Buffer[], options: { serial?: number; lacing?: number[] } = {}): Buffer {
  const lacing = options.lacing ?? packets.flatMap((packet) => {
    const laces = new Array<number>(Math.floor(packet.length / 255)).fill(255);
    return [...laces, packet.length % 255];
  });
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS');
  header[5] = flags;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(options.serial ?? 7, 14);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  return Buffer.concat([header, ...packets]);
}
const head = (channels = 1): Buffer => Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, channels, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])]);
const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(8)]);
/** A 20 ms CELT frame: 960 samples. */
const frame = Buffer.from([0xf8, 0xff, 0xfe]);

/** A well-formed mono voice note: one page per second, the last trimming 312 samples. */
function voice(seconds = 1, behind = 0n): Buffer {
  const pages = [page(0x02, 0n, [head()]), page(0, 0n, [tags])];
  for (let second = 1; second <= seconds; second += 1) {
    const last = second === seconds;
    const granule = BigInt(second * 48000) - (last ? 312n : behind);
    pages.push(page(last ? 0x04 : 0, granule, new Array<Buffer>(50).fill(frame)));
  }
  return Buffer.concat(pages);
}

describe('bounded voice conversion', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects empty, malformed, noncanonical and oversized recordings before starting ffmpeg', () => {
    for (const input of [null, '', '*', 'AAAA=', 'A'.repeat(470001), Buffer.alloc(350001).toString('base64')]) {
      expect(() => convertVoice(input)).toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
  });
  it('uses only local pipes, re-times from the sample count, limits execution time and returns Opus Ogg', async () => {
    const proc = child(); const result = convertVoice('YWJj');
    expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-protocol_whitelist', 'pipe', 'libopus', 'asetpts=N/SR/TB', '-map_metadata']), expect.objectContaining({ timeout: 12000 }));
    proc.stdout.emit('data', voice(2)); proc.emit('close', 0);
    expect(await result).toEqual(voice(2));
    proc.stdin.emit('error', new Error('broken pipe'));
  });
  it('reports unavailable conversion rather than a successful recording', async () => {
    const proc = child(); const result = convertVoice('YWJj');
    proc.emit('error', new Error('missing ffmpeg'));
    await expect(result).rejects.toMatchObject({ status: 503, code: 'voice_conversion_unavailable' });
  });
  it.each([
    ['exit', voice(), 1],
    ['empty', Buffer.alloc(0), 0],
    ['bad magic', Buffer.alloc(27), 0],
    ['truncated page', Buffer.concat([voice(), Buffer.from('OggS')]), 0],
    // What production sent: a Chrome recording whose granules trail its samples.
    ['jittered granules', fixture('chrome-recording.jittered.ogg'), 0],
  ])('rejects %s', async (_name, audio, code) => {
    const proc = child(); const result = convertVoice('YWJj');
    proc.stdout.emit('data', audio); proc.emit('close', code);
    await expect(result).rejects.toMatchObject({ code: 'voice_invalid' });
  });
  it('kills conversion output above its bound', async () => {
    const proc = child(); const result = convertVoice('YWJj');
    proc.stdout.emit('data', Buffer.alloc(400001)); expect(proc.kill).toHaveBeenCalledWith('SIGKILL'); proc.emit('close', 0);
    await expect(result).rejects.toMatchObject({ code: 'voice_invalid' });
  });
  it('rejects recordings longer than 90 seconds', async () => {
    const proc = child(); const result = convertVoice('YWJj'); proc.stdout.emit('data', voice(91)); proc.emit('close', 0);
    await expect(result).rejects.toMatchObject({ code: 'voice_too_long' });
  });
});

describe('Ogg Opus stream check', () => {
  it('measures a well-formed mono voice note, including one re-timed from a real Chrome recording', () => {
    expect(oggOpusSamples(voice(3))).toBe(3n * 48000n - 312n);
    const retimed = oggOpusSamples(fixture('chrome-recording.retimed.ogg'));
    expect(Number(retimed) / 48000).toBeCloseTo(3.07, 1);
  });

  it('refuses the Chrome recording converted without re-timing, as Android WhatsApp does', () => {
    expect(oggOpusSamples(fixture('chrome-recording.jittered.ogg'))).toBeNull();
  });

  it('refuses a page whose granule trails or leads its samples', () => {
    expect(oggOpusSamples(voice(3, 96n))).toBeNull();
    expect(oggOpusSamples(voice(3, -96n))).toBeNull();
    const ahead = Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 960n * 2n, [frame])]);
    expect(oggOpusSamples(ahead)).toBeNull();
  });

  it('carries a packet across pages and ignores the granule of a page that ends none', () => {
    const big = Buffer.concat([frame, Buffer.alloc(400)]);
    const stream = Buffer.concat([
      page(0x02, 0n, [head()]), page(0, 0n, [tags]),
      page(0, 0xffffffffffffffffn, [big.subarray(0, 255)], { lacing: [255] }),
      page(0x05, 960n, [big.subarray(255)]),
    ]);
    expect(oggOpusSamples(stream)).toBe(960n);
  });

  it('counts every Opus frame layout', () => {
    const packets = [
      Buffer.from([0x00]), // SILK 10 ms
      Buffer.from([0x69]), // hybrid 20 ms, two equal frames
      Buffer.from([0x0a, 1]), // SILK 20 ms, two unequal frames
      Buffer.from([0xe3, 0x03]), // CELT 2.5 ms, three frames
    ];
    const samples = 480n + 1920n + 1920n + 360n;
    const stream = Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, samples, packets)]);
    expect(oggOpusSamples(stream)).toBe(samples);
  });

  it.each([
    ['nothing', Buffer.alloc(0)],
    ['a stereo recording', Buffer.concat([page(0x02, 0n, [head(2)]), page(0, 0n, [tags]), page(0x04, 960n, [frame])])],
    ['a stream that is not Opus', Buffer.concat([page(0x02, 0n, [Buffer.from('\x01vorbis-header-pad')]), page(0x04, 0n, [tags])])],
    ['missing comments', Buffer.concat([page(0x02, 0n, [head()]), page(0x04, 960n, [frame])])],
    ['no end of stream', voice(2).subarray(0, voice(2).length - page(0x04, 0n, new Array<Buffer>(50).fill(frame)).length)],
    ['an unfinished packet at the end', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 0n, [Buffer.alloc(255, 0xf8)], { lacing: [255] })])],
    ['a page after the end', Buffer.concat([voice(1), page(0x04, 0n, [frame])])],
    ['a second beginning', Buffer.concat([page(0x02, 0n, [head()]), page(0x02, 0n, [tags]), page(0x04, 960n, [frame])])],
    ['no beginning', Buffer.concat([page(0, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 960n, [frame])])],
    ['a second stream', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags], { serial: 8 }), page(0x04, 960n, [frame])])],
    ['an unknown page version', (() => { const audio = voice(1); audio[4] = 1; return audio; })()],
    ['a lacing table past the end', page(0x02, 0n, [], { lacing: [10] })],
    ['a header past the end', Buffer.concat([page(0x02, 0n, [head()]), Buffer.from('OggS\0\0')])],
    ['a segment table past the end', (() => { const first = page(0x02, 0n, [head()]); first[26] = 200; return first; })()],
    ['an empty packet', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 0n, [Buffer.alloc(0)])])],
    ['a frame count with no count byte', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 0n, [Buffer.from([0xfb])])])],
    ['zero frames', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 0n, [Buffer.from([0xfb, 0])])])],
    ['more than 120 ms in a packet', Buffer.concat([page(0x02, 0n, [head()]), page(0, 0n, [tags]), page(0x04, 0n, [Buffer.from([0xfb, 7])])])],
  ])('refuses %s', (_name, audio) => {
    expect(oggOpusSamples(audio)).toBeNull();
  });
});
