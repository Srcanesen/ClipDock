import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {YtdlpWorker} from '../dist/ytdlp.js';

const time = seconds => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
const captions = Array.from({length: 220}, (_, i) => `${i + 1}\n${time(i)} --> ${time(i + 1)}\nCaption ${i + 1}\n`).join('\n');

for (const selection of [null, {start: 210, end: 211, label: 'Late caption'}]) {
  test(`download preserves subtitles ${selection ? 'in a range after cue 200' : 'beyond cue 200'}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'clipdock-captions-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const spawn = (_binary, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (args.includes('-show_streams')) {
          child.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', width: 160, height: 96, avg_frame_rate: '30/1', start_time: '0'}], format: {duration: selection ? '1' : '220', format_name: 'mov,mp4'}}));
        } else {
          const dir = dirname(args[args.indexOf('-o') + 1]);
          if (args.includes('--write-subs')) writeFileSync(join(dir, 'captions.en.srt'), captions);
          if (!args.includes('--skip-download')) {
            const file = join(dir, 'clip.mp4'); writeFileSync(file, 'media');
            child.stdout.emit('data', `P|${file}\n`);
          }
        }
        child.emit('close', 0);
      });
      return child;
    };
    const worker = new YtdlpWorker('/fixture/yt-dlp', spawn, undefined, {sessionDir: root, ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe'});
    t.after(() => worker.dispose());
    const result = await worker.download('https://youtu.be/dQw4w9WgXcQ', 'best', 'captions', () => {}, {mediaMode: 'video', audioFormat: 'm4a', subtitles: true, subtitleLanguage: 'en', selection});
    assert.equal(result.warning, undefined);
    assert.equal(typeof result.subtitlePath, 'string');
    const text = readFileSync(result.subtitlePath, 'utf8');
    if (selection) assert.equal(text, '1\n00:00:00,000 --> 00:00:01,000\nCaption 211\n');
    else {
      assert.equal((text.match(/ --> /g) ?? []).length, 220);
      assert.equal(text.endsWith('Caption 220\n'), true);
    }
  });
}
