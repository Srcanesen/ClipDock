import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {mainFixture,deferred,historyInput,download} from './helpers/files-main.mjs';

test('SHL-1: cleanup and folder changes reject while completion waits for Resolve',async t=>{const f=await mainFixture(t);const entered=deferred(),release=deferred();f.controls.status=()=>{entered.resolve();return release.promise;};const job=download(f);await entered.promise;await assert.rejects(f.invoke('cleanupWorkspace'),/Wait for active/);await assert.rejects(f.invoke('chooseDownloadFolder'),/Wait for active/);assert.equal(fs.readFileSync(path.join(f.root,'youtube','job.mp4'),'utf8'),'media');release.resolve({project:{name:'Project'}});const result=await job;assert.equal(result.fileName,'job.mp4');assert.equal((await f.invoke('workspaceStatus')).cleanupFileCount,0);});
test('SHL-1: a pending Resolve transfer owns the artifact until its promise settles',async t=>{const f=await mainFixture(t);const file=path.join(f.root,'youtube','old.mp4');fs.writeFileSync(file,'old');const record=f.controls.history.add(historyInput(file));const card=(await f.invoke('historyList'))[0].cardId;const entered=deferred(),release=deferred();f.controls.transfer=()=>{entered.resolve();return release.promise;};const transfer=f.invoke('importToMediaPool',card,'active');await entered.promise;await assert.rejects(f.invoke('cleanupWorkspace'),/Wait for active/);assert.equal(fs.existsSync(file),true);release.resolve({ok:true,kind:'imported'});assert.equal((await transfer).ok,true);assert.equal(record.fileName,'old.mp4');});
test('SHL-6: folder dialog reserves the transition and rechecks worker activity',async t=>{const f=await mainFixture(t);const entered=deferred(),release=deferred();f.controls.dialog=()=>{entered.resolve();return release.promise;};const chooser=f.invoke('chooseDownloadFolder');await entered.promise;await assert.rejects(download(f),/folder operation/);await assert.rejects(f.invoke('chooseDownloadFolder'),/Wait for active/);const chosen=path.join(f.dir,'chosen');fs.mkdirSync(chosen);f.workers[0].active=true;release.resolve({canceled:false,filePaths:[chosen]});await assert.rejects(chooser,/Wait for active/);assert.equal((await f.invoke('downloadFolderStatus')).folder,f.root);assert.deepEqual(fs.readdirSync(chosen),[]);});
test('SHL-5: unusable default folder keeps the panel and recovery IPC available',async t=>{const f=await mainFixture(t,{invalidRoot:true});assert.equal(f.windows.length,1);assert.match((await f.invoke('downloadFolderStatus')).error,/Choose a usable/);await assert.rejects(download(f),/Choose a usable/);const chosen=path.join(f.dir,'chosen');fs.mkdirSync(chosen);f.controls.dialog=async()=>({canceled:false,filePaths:[chosen]});assert.equal((await f.invoke('chooseDownloadFolder')).folder,chosen);assert.equal((await download(f)).fileName,'job.mp4');assert.equal(fs.readFileSync(f.root,'utf8'),'keep');});
test('SHL-15: panel and folder status are available before engine discovery resolves',async t=>{const discovery=deferred();const f=await mainFixture(t,{discovery:discovery.promise});assert.deepEqual(f.order,['window','discovery']);assert.equal((await f.invoke('downloadFolderStatus')).folder,f.root);discovery.resolve({ffmpegPath:null,ffprobePath:null,ytdlpPath:null,galleryDlPath:null});assert.equal((await download(f)).fileName,'job.mp4');});

test('SHL-14: workspace status through the registered IPC leaves the event loop responsive',async t=>{
  const f=await mainFixture(t);for(let i=0;i<1000;i++)fs.writeFileSync(path.join(f.root,'youtube',`${i}.mp4`),'x');
  let heartbeat=false;setImmediate(()=>{heartbeat=true;});const summary=await f.invoke('workspaceStatus');
  assert.equal(heartbeat,true);assert.equal(summary.fileCount,1000);assert.equal(summary.totalBytes,1000);
});
test('SHL-3: the real main transfer wiring rejects a swapped pathname at native consumption',async t=>{
  const f=await mainFixture(t,{realTransfer:true});const completed=await download(f);
  const entered=deferred(),release=deferred();f.controls.nativeInitialize=()=>{entered.resolve();return release.promise;};
  const imports=[];f.controls.nativeResolve={GetProjectManager:async()=>null,GetMediaStorage:async()=>({AddItemListToMediaPool:async paths=>{imports.push(paths);return [{}];}})};
  const pending=f.invoke('importToMediaPool',completed.cardId,'active');await entered.promise;
  const file=path.join(f.root,'youtube','job.mp4'),outside=path.join(f.dir,'outside.mp4');fs.writeFileSync(outside,'outside');fs.rmSync(file);fs.symlinkSync(outside,file);
  release.resolve(true);assert.equal((await pending).ok,false);assert.deepEqual(imports,[]);
});

test('a file stays while a Resolve handoff is reading media',async t=>{
  const f=await mainFixture(t);const file=path.join(f.root,'youtube','old.mp4');fs.writeFileSync(file,'old');
  const record=f.controls.history.add(historyInput(file));const card=(await f.invoke('historyList'))[0].cardId;
  const entered=deferred(),release=deferred();f.controls.transfer=()=>{entered.resolve();return release.promise;};
  const transfer=f.invoke('importToMediaPool',card,'active');await entered.promise;
  await assert.rejects(f.invoke('historyDelete',record.id),/Wait for active/);
  assert.equal(fs.existsSync(file),true);
  release.resolve({ok:true,kind:'imported'});assert.equal((await transfer).ok,true);
  assert.equal((await f.invoke('historyDelete',record.id)).deleted,true);
  assert.equal(fs.existsSync(file),false);
});

test('folder IPC rolls provider adapters and the shared root back when settings persistence fails', async t => {
  const f = await mainFixture(t);
  const chosen = path.join(f.dir, 'chosen'); fs.mkdirSync(chosen);
  fs.mkdirSync(path.join(f.userData, 'clipdock-settings.json'));
  const before = f.workers.map(worker => worker.root);
  f.controls.dialog = async () => ({ canceled: false, filePaths: [chosen] });
  await assert.rejects(f.invoke('chooseDownloadFolder'), /Could not change the download folder/);
  assert.equal((await f.invoke('downloadFolderStatus')).folder, f.root);
  assert.deepEqual(f.workers.map(worker => worker.root), before);
  assert.equal((await download(f)).fileName, 'job.mp4');
  assert.equal(fs.readFileSync(path.join(f.root, 'youtube', 'job.mp4'), 'utf8'), 'media');
  assert.deepEqual(fs.readdirSync(path.join(chosen, 'youtube')), []);
  assert.equal((await f.invoke('workspaceStatus')).cleanupFileCount, 0);
});

test('in-session replacement reports choose-again status and rechoosing the same default folder restores access', async t => {
  const f = await mainFixture(t);
  const file = path.join(f.root, 'youtube', 'old.mp4'); fs.writeFileSync(file, 'owned');
  const record = f.controls.history.add(historyInput(file));
  const oldCard = (await f.invoke('historyList'))[0].cardId;
  const moved = path.join(f.dir, 'original'); fs.renameSync(f.root, moved);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'owned');
  assert.equal((await f.invoke('importToMediaPool', oldCard, 'active')).kind, 'invalid-card');
  await assert.rejects(f.invoke('workspaceStatus'), /choose.*folder again/i);
  await assert.rejects(f.invoke('cleanupWorkspace'), /choose.*folder again/i);
  const status = await f.invoke('downloadFolderStatus');
  assert.equal(status.folder, f.root);
  assert.match(status.error ?? '', /choose.*folder again/i);
  await assert.rejects(download(f), /choose.*folder again/i);
  assert.equal((await f.invoke('historyList'))[0].available, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned');
  f.controls.dialog = async () => ({ canceled: false, filePaths: [f.root] });
  assert.equal((await f.invoke('chooseDownloadFolder')).folder, f.root);
  assert.equal((await f.invoke('downloadFolderStatus')).error, undefined);
  assert.equal((await f.invoke('workspaceStatus')).fileCount, 1);
  const restored = (await f.invoke('historyList')).find(hit => hit.id === record.id);
  assert.equal(restored.available, true);
  assert.notEqual(restored.cardId, oldCard);
  assert.equal((await f.invoke('importToMediaPool', restored.cardId, 'active')).ok, true);
  assert.equal((await download(f)).fileName, 'job.mp4');
  assert.equal(fs.readFileSync(path.join(f.root, 'youtube', 'job.mp4'), 'utf8'), 'media');
  assert.equal((await f.invoke('historyDelete', record.id)).deleted, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(moved, 'youtube', 'old.mp4'), 'utf8'), 'owned');
});

test('a remounted custom folder is recaptured through the same-folder chooser without relinking history', async t => {
  const f = await mainFixture(t), chosen = path.join(f.dir, 'custom'); fs.mkdirSync(chosen);
  f.controls.dialog = async () => ({ canceled: false, filePaths: [chosen] });
  assert.equal((await f.invoke('chooseDownloadFolder')).folder, chosen);
  const file = path.join(chosen, 'youtube', 'keep.mp4'); fs.writeFileSync(file, 'keep');
  const subtitle = path.join(chosen, 'youtube', 'keep.srt'); fs.writeFileSync(subtitle, 'captions');
  const record = f.controls.history.add({ ...historyInput(file), subtitle: { filePath: subtitle } });
  const moved = path.join(f.dir, 'unmounted'); fs.renameSync(chosen, moved);
  fs.cpSync(moved, chosen, { recursive: true });
  assert.match((await f.invoke('downloadFolderStatus')).error ?? '', /choose.*folder again/i);
  assert.equal((await f.invoke('historyList')).find(hit => hit.id === record.id).available, false);
  await assert.rejects(f.invoke('cleanupWorkspace'), /choose.*folder again/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.equal((await f.invoke('chooseDownloadFolder')).folder, chosen);
  assert.equal((await f.invoke('downloadFolderStatus')).error, undefined);
  const restored = (await f.invoke('historyList')).find(hit => hit.id === record.id);
  assert.equal(restored.available, true); assert.equal(restored.subtitle.available, true);
  assert.equal((await f.invoke('workspaceStatus')).fileCount, 2);
  assert.equal((await download(f)).fileName, 'job.mp4');
  assert.equal((await f.invoke('historyDelete', record.id)).deleted, true);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(subtitle), false);
  assert.equal(fs.readFileSync(path.join(moved, 'youtube', 'keep.mp4'), 'utf8'), 'keep');
});
