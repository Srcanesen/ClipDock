import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderJobRunner} from '../dist/provider-job.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'safefs-gate-alias-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const lower = path.join(base, 'clip.mp4'), upper = path.join(base, 'CLIP.mp4');
  fs.writeFileSync(lower, 'irreplaceable artifact');
  // APFS/NTFS exercise native case aliases; the hard-link fallback exercises
  // the same ownership identity on case-sensitive filesystems without a skip.
  if (!fs.existsSync(upper)) fs.linkSync(lower, upper);
  assert.equal(fs.lstatSync(lower, {bigint: true}).ino, fs.lstatSync(upper, {bigint: true}).ino);
  return {base, lower, upper, jobs: new ProviderJobRunner({cancelledMessage: 'Cancelled.', disposedMessage: 'Disposed.'})};
}

for (const spelling of ['lower', 'upper']) {
  test(`publishing the ${spelling} case alias preserves the registered file`, async t => {
    const f = fixture(t);
    const result = await f.jobs.run('alias', async context => {
      context.register(f.lower); context.register(f.upper); context.publish(f[spelling]); return 'published';
    });
    assert.equal(result, 'published');
    assert.equal(fs.existsSync(f.lower), true);
    assert.equal(fs.existsSync(f.upper), true);
    assert.equal(fs.readFileSync(f.lower, 'utf8'), 'irreplaceable artifact');
    assert.equal(fs.readFileSync(f.upper, 'utf8'), 'irreplaceable artifact');
  });
}

test('case aliases share one publication and retain the same ownership record', async t => {
  const f = fixture(t), commits = [];
  await f.jobs.run('alias', async context => {
    context.register(f.lower); context.register(f.upper);
    context.publish(f.lower, () => commits.push('superseded'));
    context.publish(f.upper, () => {context.retain(f.lower); commits.push('published');});
    return 'published';
  });
  assert.deepEqual(commits, ['published']);
  assert.equal(fs.readFileSync(f.lower, 'utf8'), 'irreplaceable artifact');
});

for (const publication of ['file', 'directory']) {
  test(`a published ${publication} retains captured hard-link aliases in other private directories`, async t => {
    const f = fixture(t), first = path.join(f.base, 'first'), second = path.join(f.base, 'second');
    const file = path.join(first, 'media.mp4'), alias = path.join(second, 'alias.mp4'), later = path.join(f.base, 'later.mp4');
    await assert.rejects(f.jobs.run('alias', async context => {
      context.createDirectory(first); context.createDirectory(second);
      fs.writeFileSync(file, 'referenced media'); fs.linkSync(file, alias); fs.writeFileSync(later, 'unpublished');
      context.register(file); context.register(alias); context.register(later);
      context.publish(publication === 'file' ? file : first);
      context.publish(later, () => {throw new Error('later publication failed');});
      return 'partial';
    }), {message: 'later publication failed'});
    assert.equal(fs.readFileSync(file, 'utf8'), 'referenced media');
    assert.equal(fs.readFileSync(alias, 'utf8'), 'referenced media');
    assert.equal(fs.existsSync(later), false);
  });
}
