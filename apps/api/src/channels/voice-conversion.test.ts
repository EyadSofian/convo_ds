import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { convertVoice } from './voice-conversion.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(process as never);
  return process;
}
function ogg(seconds = 1): Buffer {
  const buffer = Buffer.alloc(27);
  buffer.write('OggS'); buffer.writeBigUInt64LE(BigInt(seconds * 48000), 6);
  return buffer;
}
describe('bounded voice conversion', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects empty, malformed, noncanonical and oversized recordings before starting ffmpeg', () => {
    for (const input of [null, '', '*', 'AAAA=', 'A'.repeat(470001), Buffer.alloc(350001).toString('base64')]) {
      expect(() => convertVoice(input)).toThrow();
    }
    expect(spawn).not.toHaveBeenCalled();
  });
  it('uses only local pipes, limits execution time and returns Opus Ogg', async () => {
    const proc = child(); const result = convertVoice('YWJj');
    expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-protocol_whitelist', 'pipe', 'libopus']), expect.objectContaining({ timeout: 12000 }));
    proc.stdout.emit('data', ogg()); proc.emit('close', 0);
    expect(await result).toEqual(ogg());
    proc.stdin.emit('error', new Error('broken pipe'));
  });
  it('reports unavailable conversion rather than a successful recording', async () => {
    const proc = child(); const result = convertVoice('YWJj');
    proc.emit('error', new Error('missing ffmpeg'));
    await expect(result).rejects.toMatchObject({ status: 503, code: 'voice_conversion_unavailable' });
  });
  it.each([['exit', ogg(), 1], ['empty', Buffer.alloc(0), 0], ['bad magic', Buffer.alloc(27), 0], ['truncated page', Buffer.concat([ogg(), Buffer.from('OggS')]), 0]])('rejects %s', async (_name, audio, code) => {
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
    const proc = child(); const result = convertVoice('YWJj'); proc.stdout.emit('data', ogg(91)); proc.emit('close', 0);
    await expect(result).rejects.toMatchObject({ code: 'voice_too_long' });
  });
});
