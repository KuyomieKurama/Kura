import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stand-ins for ffprobe and ffmpeg (Node scripts with an absolute shebang). They behave according to markers in
 * the bytes of the file they are given, so a test controls them through the content of the "original":
 *   ffprobe: PROBE-HANG, PROBE-FAIL, PROBE-GARBAGE, KIND-AUDIO, KIND-VIDEO, KIND-ROTATED (default: a picture, 800x600)
 *   ffmpeg:  NO-WEBP (libwebp missing), ENC-FAIL, ENC-HANG, ENC-NOFILE, COLOR-FAIL
 * Every call is appended as one JSON line to calls.log next to the scripts.
 */
const FFPROBE = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(require('path').join(__dirname, 'calls.log'), JSON.stringify({ tool: 'ffprobe', args }) + '\\n');
const file = args[args.indexOf('-i') + 1];
const text = fs.readFileSync(file, 'latin1');
if (text.includes('PROBE-HANG')) { setTimeout(() => {}, 60000); return; }
if (text.includes('PROBE-FAIL')) { process.stderr.write('boom ' + file); process.exit(1); }
if (text.includes('PROBE-GARBAGE')) { console.log('this is not json'); process.exit(0); }
let result = { streams: [{ codec_type: 'video', width: 800, height: 600 }], format: { duration: 'N/A' } };
if (text.includes('KIND-VIDEO')) result = { streams: [{ codec_type: 'video', width: 640, height: 360, duration: '12.5' }, { codec_type: 'audio' }], format: { duration: '12.5' } };
if (text.includes('KIND-ROTATED')) result = { streams: [{ codec_type: 'video', width: 1080, height: 1920, side_data_list: [{ rotation: -90 }] }], format: { duration: '3.0' } };
if (text.includes('KIND-AUDIO')) result = { streams: [{ codec_type: 'audio', duration: '61.2' }], format: { duration: '61.2' } };
console.log(JSON.stringify(result));
`;

const FFMPEG = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(require('path').join(__dirname, 'calls.log'), JSON.stringify({ tool: 'ffmpeg', args }) + '\\n');
const input = args[args.indexOf('-i') + 1];
const output = args[args.length - 1];
const codec = args[args.indexOf('-c:v') + 1];
const text = fs.readFileSync(input, 'latin1');
if (text.includes('ENC-HANG') && codec !== 'ppm') { setTimeout(() => {}, 60000); return; }
if (output.endsWith('.ppm')) {
  if (text.includes('COLOR-FAIL')) process.exit(1);
  fs.writeFileSync(output, Buffer.concat([Buffer.from('P6\\n1 1\\n255\\n'), Buffer.from([0x10, 0x80, 0xf0])]));
  process.exit(0);
}
if (text.includes('ENC-FAIL') || (codec === 'libwebp' && text.includes('NO-WEBP'))) { process.stderr.write('encoder failed ' + input); process.exit(1); }
if (text.includes('ENC-NOFILE')) process.exit(0);
const width = String(args[args.indexOf('-vf') + 1]).match(/min\\((\\d+),/)[1];
if (codec === 'libwebp') fs.writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('fake-' + width + (text.includes('COLOR-FAIL') ? ' COLOR-FAIL' : ''))]));
else fs.writeFileSync(output, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fakejpeg-' + width + '-padding' + (text.includes('COLOR-FAIL') ? ' COLOR-FAIL' : ''))]));
`;

export interface FakeTools {
  directory: string;
  calls: () => Promise<{ tool: string; args: string[] }[]>;
  cleanup: () => Promise<void>;
}

export async function installFakeTools(options: { ffmpeg?: boolean; ffprobe?: boolean } = {}): Promise<FakeTools> {
  const directory = await mkdtemp(join(tmpdir(), 'kura-fake-tools-'));
  if (options.ffprobe !== false) {
    await writeFile(join(directory, 'ffprobe'), FFPROBE);
    await chmod(join(directory, 'ffprobe'), 0o755);
  }
  if (options.ffmpeg !== false) {
    await writeFile(join(directory, 'ffmpeg'), FFMPEG);
    await chmod(join(directory, 'ffmpeg'), 0o755);
  }
  return {
    directory,
    calls: async () => (await readFile(join(directory, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
