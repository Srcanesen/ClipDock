import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {cleanJobDirectory} from '../dist/provider-platform.js';
import {GalleryDlWorker} from '../dist/gallerydl.js';
import {YtdlpWorker} from '../dist/ytdlp.js';
import {DownloadHistory} from '../dist/history.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {AnchoredDir, captureFile} from '../dist/safe-fs.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'rest-files-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const dir = path.join(base, 'managed'); fs.mkdirSync(dir);
  return {base, dir};
}
const input = filePath => ({filePath, provider: 'youtube', source: 'https://youtu.be/dQw4w9WgXcQ', assetId: null, title: 'Clip', creator: null, profile: 'original', quality: null, mediaMode: 'video', selection: null, automation: {chapters: []}});

for (const Worker of [GalleryDlWorker, YtdlpWorker]) {
  for (const replacement of ['missing', 'directory', 'symlink']) {
    test(`${Worker.name} never recreates or adopts a ${replacement} session parent`, async t => {
      const {base, dir} = fixture(t);
      const worker = Worker === YtdlpWorker ? new Worker('/fake/engine', undefined, undefined, {sessionDir: dir}) : new Worker('/fake/engine', undefined, {sessionDir: dir});
      t.after(() => worker.dispose());
      fs.renameSync(dir, `${dir}-original`);
      if (replacement === 'directory') fs.mkdirSync(dir);
      if (replacement === 'symlink') {fs.mkdirSync(path.join(base, 'outside')); fs.symlinkSync(path.join(base, 'outside'), dir);}
      const outcome = await worker.runJob({jobDir: path.join(dir, 'job'), kind: 'metadata'}, async () => 'adopted').then(value => ({value}), error => ({error}));
      assert.ok(outcome.error, 'changed parent must be reported');
      assert.equal(fs.existsSync(path.join(dir, 'job')), false);
      if (replacement === 'missing') assert.equal(fs.existsSync(dir), false);
    });
  }
}

test('job cleanup preserves and reports a file replaced after inventory', t => {
  const {dir} = fixture(t), file = path.join(dir, 'discard.tmp'); fs.writeFileSync(file, 'old');
  const lstat = fs.lstatSync; let seen = 0;
  t.mock.method(fs, 'lstatSync', (name, ...args) => {
    if (name === file && ++seen === 2) {fs.renameSync(file, `${file}.original`); fs.writeFileSync(file, 'replacement');}
    return lstat(name, ...args);
  });
  const outcome = (() => {try {cleanJobDirectory(dir, []);} catch (error) {return error;}})();
  assert.ok(outcome, 'replacement must be reported');
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});

test('job cleanup refuses an inventoried directory replaced before descent', t => {
  const {dir} = fixture(t), nested = path.join(dir, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'clip'), 'old');
  const lstat = fs.lstatSync; let seen = 0;
  t.mock.method(fs, 'lstatSync', (name, ...args) => {
    const info = lstat(name, ...args);
    if (name === nested && ++seen === 1) {fs.renameSync(nested, `${nested}-old`); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'precious'), 'replacement');}
    return info;
  });
  assert.throws(() => cleanJobDirectory(dir, []), /replaced|safety/);
  assert.equal(fs.readFileSync(path.join(nested, 'precious'), 'utf8'), 'replacement');
});

for (const target of ['media', 'subtitle', 'parent']) {
  test(`history preserves and reports a replaced ${target} across transaction reload`, t => {
    const {base, dir} = fixture(t), job = path.join(dir, 'job'); fs.mkdirSync(job);
    const media = path.join(job, 'clip.mp4'), subtitle = path.join(job, 'clip.srt'); fs.writeFileSync(media, 'media'); fs.writeFileSync(subtitle, 'subtitle');
    const history = new DownloadHistory(path.join(base, 'history.json'), dir);
    const record = history.add({...input(media), subtitle: {filePath: subtitle}});
    const victim = target === 'subtitle' ? subtitle : media;
    if (target === 'parent') {fs.renameSync(job, `${job}-original`); fs.mkdirSync(job); fs.writeFileSync(media, 'replacement'); fs.writeFileSync(subtitle, 'replacement');}
    else {fs.renameSync(victim, `${victim}.original`); fs.writeFileSync(victim, 'replacement');}
    const result = history.delete(record.id, []);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'replacement');
    assert.match(result.warning, /replaced|changed|safety|could not/i);
    assert.equal(result.deleted, target === 'subtitle');
  });
}

for (const target of ['media', 'subtitle']) {
  test(`unrecorded history deletion preserves a ${target} replaced after admission`, t => {
    const {base, dir} = fixture(t), media = path.join(dir, 'clip.mp4'), subtitle = path.join(dir, 'clip.srt');
    fs.writeFileSync(media, 'media'); fs.writeFileSync(subtitle, 'subtitle');
    const history = new DownloadHistory(path.join(base, 'history.json'), dir), root = ManagedRoot.capture(dir);
    const anchor = AnchoredDir.capture(root.verify(), root), files = {media: captureFile(anchor, media), subtitle: captureFile(anchor, subtitle)};
    const victim = target === 'media' ? media : subtitle;
    const protectedPaths = {[Symbol.iterator]: function* () {fs.renameSync(victim, `${victim}.original`); fs.writeFileSync(victim, 'replacement');}};
    const result = history.deleteUnrecorded(media, root, protectedPaths, files, false, subtitle);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'replacement');
    assert.match(result.warning, /replaced|changed|safety|could not/i);
    assert.equal(result.deleted, target === 'subtitle');
  });
}

for (const operation of ['download', 'subtitles']) {
  test(`yt-dlp ${operation} cached metadata never writes through a replaced job directory`, async t => {
    const {base, dir} = fixture(t), outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    const worker = new YtdlpWorker('/fake/engine', () => {throw new Error('must not spawn');}, undefined, {sessionDir: dir, ffmpegPath: '/fake/ffmpeg'});
    t.after(() => worker.dispose());
    t.mock.method(worker.metadataStore.raw, 'get', () => {
      const job = fs.readdirSync(dir).find(name => name.startsWith(`${operation}-`));
      assert.ok(job);
      const jobPath = path.join(dir, job); fs.renameSync(jobPath, `${jobPath}-original`); fs.symlinkSync(outside, jobPath);
      return '{}';
    });
    const pending = operation === 'download' ? worker.download('https://youtu.be/dQw4w9WgXcQ', 'best', 'cached', () => {}) : worker.subtitles('https://youtu.be/dQw4w9WgXcQ', 'en');
    await assert.rejects(pending);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

test('history temporary cleanup preserves and reports a replaced inventoried entry', t => {
  const {base, dir} = fixture(t), media = path.join(dir, 'clip.mp4'); fs.writeFileSync(media, 'media');
  const history = new DownloadHistory(path.join(base, 'history.json'), dir);
  const temp = path.join(base, 'history.json.00000000-0000-0000-0000-000000000000.tmp'); fs.writeFileSync(temp, 'abandoned');
  const lstat = fs.lstatSync; let seen = 0;
  t.mock.method(fs, 'lstatSync', (name, ...args) => {
    if (name === temp && ++seen === 2) {fs.renameSync(temp, `${temp}.original`); fs.writeFileSync(temp, 'replacement');}
    return lstat(name, ...args);
  });
  assert.throws(() => history.add(input(media)), /replaced|safety/);
  assert.equal(fs.readFileSync(temp, 'utf8'), 'replacement');
});

import {EventEmitter} from 'node:events';
function child() {
  const value = new EventEmitter(); value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.kill = () => true; return value;
}

test('subtitle search creates its job exactly once and returns literal cues', async t => {
  const {dir} = fixture(t), mkdir = fs.mkdirSync; let creations = 0;
  t.mock.method(fs, 'mkdirSync', (name, ...args) => {if (String(name).includes('/subtitles-')) creations++; return mkdir(name, ...args);});
  const worker = new YtdlpWorker('/fake/engine', (_binary, args) => {
    const value = child(); queueMicrotask(() => {
      fs.writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n'); value.emit('close', 0);
    }); return value;
  }, undefined, {sessionDir: dir});
  t.after(() => worker.dispose());
  assert.deepEqual(await worker.subtitles('https://youtu.be/dQw4w9WgXcQ', 'en'), [{start: 1, end: 2, text: 'hello'}]);
  assert.equal(creations, 1);
});

for (const replacement of ['regular file', 'destination symlink']) {
  test(`subtitle normalization preserves a replacement ${replacement}`, async t => {
    const {base, dir} = fixture(t); let subtitle, victim;
    const worker = new YtdlpWorker('/fake/engine', (binary, args) => {
      const value = child(); queueMicrotask(() => {
        if (binary.endsWith('ffprobe')) value.stdout.emit('data', JSON.stringify({streams: [{codec_type: 'video', width: 1920, height: 1080}], format: {duration: '2', format_name: 'mp4'}}));
        else {
          const job = path.dirname(args[args.indexOf('-o') + 1]), media = path.join(job, 'clip.mp4'); fs.writeFileSync(media, 'media');
          subtitle = path.join(job, replacement === 'regular file' ? 'clip.srt' : 'clip.vtt'); fs.writeFileSync(subtitle, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\ncaption\n');
          if (replacement === 'destination symlink') {victim = path.join(base, 'precious.srt'); fs.writeFileSync(victim, 'replacement'); fs.symlinkSync(victim, path.join(job, 'clip.srt'));}
          value.stdout.emit('data', `P|${media}\n`);
        }
        value.emit('close', 0);
      }); return value;
    }, undefined, {sessionDir: dir, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe'});
    t.after(() => worker.dispose());
    if (replacement === 'regular file') {
      const read = fs.readFileSync;
      t.mock.method(fs, 'readFileSync', (name, ...args) => {
        const content = read(name, ...args);
        if (name === subtitle) {fs.renameSync(subtitle, `${subtitle}.original`); fs.writeFileSync(subtitle, 'replacement'); victim = subtitle;}
        return content;
      });
    }
    const result = await worker.download('https://youtu.be/dQw4w9WgXcQ', 'best', 'normalize', () => {}, {mediaMode: 'video', audioFormat: 'm4a', subtitles: true, subtitleLanguage: 'en'});
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(victim, 'utf8'), 'replacement');
    if (replacement === 'destination symlink') assert.equal(fs.lstatSync(path.join(path.dirname(subtitle), 'clip.srt')).isSymbolicLink(), true);
    assert.equal(result.subtitlePath, undefined);
    assert.match(result.warning, /subtitle|safety/i);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), 'media');
  });
}


test('history admits remounted files only after an explicit root selection', t => {
  const {base, dir} = fixture(t), media = path.join(dir, 'clip.mp4'); fs.writeFileSync(media, 'original');
  const history = new DownloadHistory(path.join(base, 'history.json'), dir), record = history.add(input(media));
  fs.renameSync(dir, `${dir}-original`); fs.mkdirSync(dir); fs.writeFileSync(media, 'remounted');
  assert.equal(history.delete(record.id, [], false, true).deleted, false);
  assert.equal(fs.readFileSync(media, 'utf8'), 'remounted');
  history.setManagedRoot(ManagedRoot.capture(dir));
  assert.equal(history.delete(record.id, [], false, true).deleted, true);
  assert.equal(fs.existsSync(media), false);
  assert.equal(fs.readFileSync(path.join(`${dir}-original`, 'clip.mp4'), 'utf8'), 'original');
});


for (const recorded of [true, false]) {
  test(`history reports a replaced subtitle symlink (${recorded ? 'recorded' : 'unrecorded'})`, t => {
    const {base, dir} = fixture(t), media = path.join(dir, 'clip.mp4'), subtitle = path.join(dir, 'clip.srt'), target = path.join(base, 'precious.srt');
    fs.writeFileSync(media, 'media'); fs.writeFileSync(subtitle, 'subtitle'); fs.writeFileSync(target, 'precious');
    const history = new DownloadHistory(path.join(base, 'history.json'), dir), root = ManagedRoot.capture(dir);
    const anchor = AnchoredDir.capture(root.verify(), root), files = {media: captureFile(anchor, media), subtitle: captureFile(anchor, subtitle)};
    const record = recorded ? history.add({...input(media), subtitle: {filePath: subtitle}}) : null;
    const replace = () => {fs.renameSync(subtitle, `${subtitle}.original`); fs.symlinkSync(target, subtitle);};
    const protectedPaths = {[Symbol.iterator]: function* () {replace();}};
    if (recorded) replace();
    const result = recorded ? history.delete(record.id, []) : history.deleteUnrecorded(media, root, protectedPaths, files, false, subtitle);
    assert.equal(result.deleted, true); assert.match(result.warning, /subtitle.*could not/i);
    assert.equal(fs.lstatSync(subtitle).isSymbolicLink(), true); assert.equal(fs.readFileSync(target, 'utf8'), 'precious');
  });
}

test('explicit root selection admits history loaded while its volume was unavailable', t => {
  const {base, dir} = fixture(t), media = path.join(dir, 'clip.mp4'), store = path.join(base, 'history.json'); fs.writeFileSync(media, 'original');
  const record = new DownloadHistory(store, dir).add(input(media));
  fs.renameSync(dir, `${dir}-unmounted`);
  const history = new DownloadHistory(store, dir);
  fs.cpSync(`${dir}-unmounted`, dir, {recursive: true});
  history.setManagedRoot(ManagedRoot.capture(dir));
  assert.equal(history.delete(record.id, []).deleted, true); assert.equal(fs.existsSync(media), false);
  assert.equal(fs.readFileSync(path.join(`${dir}-unmounted`, 'clip.mp4'), 'utf8'), 'original');
});
