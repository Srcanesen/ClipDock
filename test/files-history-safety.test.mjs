import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DownloadHistory } from '../dist/history.js';
const require = createRequire(import.meta.url);
const input = filePath => ({provider:'youtube', source:'https://www.youtube.com/watch?v=dQw4w9WgXcQ', filePath, assetId:null, title:'Clip', creator:null, profile:'original', quality:'best', mediaMode:'video', selection:null, automation:{provider:'youtube', source:'https://www.youtube.com/watch?v=dQw4w9WgXcQ', selection:null, chapters:[]}});
function fixture(t) { const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'files-history-'))); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); const root=path.join(dir,'managed'); fs.mkdirSync(root); const file=path.join(root,'clip.mp4'); fs.writeFileSync(file,'media'); return {dir,root,file,store:path.join(dir,'history.json')}; }
function faultHistory(overrides) {
  const safe = {exports: {}};
  vm.runInNewContext(fs.readFileSync('dist/safe-fs.js', 'utf8'), {module: safe, exports: safe.exports, Buffer, require: id => id === 'node:fs' ? {...fs, ...overrides} : id.startsWith('.') ? require(path.resolve('dist', id)) : require(id)});
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync('dist/history.js', 'utf8'), {module, exports: module.exports, URL, Date, require: id => id === './safe-fs' ? safe.exports : id === 'node:fs' ? {...fs, ...overrides} : id.startsWith('.') ? require(path.resolve('dist', id)) : require(id)});
  return module.exports.DownloadHistory;
}
test('SHL-4: independent writers retain both successful additions',t=>{const {root,file,store}=fixture(t);const a=new DownloadHistory(store,root),b=new DownloadHistory(store,root); a.add(input(file)); const second=b.add(input(file)); assert.equal(new DownloadHistory(store,root).list().length,2); a.reuse(second.id); assert.equal(new DownloadHistory(store,root).list()[0].id,second.id);});
test('SHL-2: replaced managed root cannot become unrestricted provenance',t=>{const {dir,root,file,store}=fixture(t);const h=new DownloadHistory(store,root);fs.writeFileSync(path.join(root,'clip.srt'),'subtitle');const id=h.add({...input(file),subtitle:{filePath:path.join(root,'clip.srt')}}).id;fs.rmSync(root,{recursive:true});const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'clip.mp4'),'outside');fs.writeFileSync(path.join(outside,'clip.srt'),'outside');fs.symlinkSync(outside,root);const restored=new DownloadHistory(store,root);assert.equal(restored.resolve(id),null);assert.equal(restored.resolveSubtitle(id),null);assert.equal(restored.get(id).available,false);});
test('SHL-10: relinking the same owned artifact retains deletion ownership',t=>{const {root,file,store}=fixture(t);const h=new DownloadHistory(store,root);const id=h.add(input(file)).id;h.relink(id,file);assert.equal(h.delete(id,[],false,true).deleted,true);assert.equal(fs.existsSync(file),false);});
test('SHL-11/17: failed writes publish no changes and leave no temp copies',t=>{const {dir,root,file,store}=fixture(t);const H=faultHistory({renameSync(){throw new Error('rename denied');}});const h=new H(store,root);assert.throws(()=>h.add(input(file)),/rename denied/);assert.equal(h.list().length,0);assert.deepEqual(fs.readdirSync(dir).sort(),['managed']);});
test('SHL-12: companion failure reports committed primary deletion',t=>{const {root,file,store}=fixture(t);const subtitle=path.join(root,'clip.srt');fs.writeFileSync(subtitle,'subtitle');const H=faultHistory({unlinkSync(p,...args){if(p===subtitle)throw new Error('subtitle denied');return fs.unlinkSync(p,...args);}});const h=new H(store,root);const id=h.add({...input(file),subtitle:{filePath:subtitle}}).id;const result=h.delete(id,[],false,true);assert.equal(result.deleted,true);assert.equal(result.removed,true);assert.match(result.warning,/subtitle/i);assert.equal(fs.existsSync(file),false);assert.equal(h.list().length,0);assert.equal(new DownloadHistory(store,root).list().length,0);});

test('SHL-11: failed reuse, relink and metadata-only delete leave the published record unchanged',t=>{
  const {dir,root,file,store}=fixture(t);let deny=false;let project='Before';
  const H=faultHistory({renameSync(...args){if(deny)throw new Error('rename denied');return fs.renameSync(...args);}});
  const h=new H(store,root,()=>project);const original=h.add(input(file));const other=path.join(dir,'other.mp4');fs.writeFileSync(other,'other');
  deny=true;project='After';assert.throws(()=>h.reuse(original.id),/rename denied/);assert.equal(h.get(original.id).project,'Before');
  assert.throws(()=>h.relink(original.id,other),/rename denied/);assert.equal(h.get(original.id).fileName,'clip.mp4');
  assert.throws(()=>h.delete(original.id,[file]),/rename denied/);assert.equal(h.list().length,1);assert.equal(fs.readFileSync(file,'utf8'),'media');
  assert.equal(new DownloadHistory(store,root).get(original.id).project,'Before');
});

test('SHL-4: overlapping writers fail closed at the lock and a retry preserves both records',async t=>{
  const {root,file,store}=fixture(t);const {Worker}=await import('node:worker_threads');
  const signal=new SharedArrayBuffer(4);const state=new Int32Array(signal);
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const production=path.resolve('dist/history.js');const realRequire=require('node:module').createRequire(production);
    const mod={exports:{}};
    const safe={exports:{}};
    const hookedFs={...fs,renameSync(...args){parentPort.postMessage('locked');Atomics.wait(new Int32Array(workerData.signal),0,0,5000);return fs.renameSync(...args);}};
    vm.runInNewContext(fs.readFileSync(path.resolve('dist/safe-fs.js'),'utf8'),{module:safe,exports:safe.exports,Buffer,require:id=>id==='node:fs'?hookedFs:realRequire(id)});
    vm.runInNewContext(fs.readFileSync(production,'utf8'),{module:mod,exports:mod.exports,URL,Date,require:id=>id==='node:fs'?hookedFs:id==='./safe-fs'?safe.exports:realRequire(id)});
    const history=new mod.exports.DownloadHistory(workerData.store,workerData.root);
    history.add(workerData.input);
    parentPort.postMessage('saved');
  `,{eval:true,workerData:{root,store,input:input(file),signal}});
  const messages=[];
  const locked=new Promise((resolve,reject)=>{worker.once('error',reject);worker.on('message',message=>{messages.push(message);if(message==='locked')resolve();});});
  const exited=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(new Error(`writer exited ${code}`)));});
  const other=new DownloadHistory(store,root);
  try {await locked;assert.throws(()=>other.add(input(file)),/locked by another writer/);assert.equal(other.list().length,0);}
  finally {Atomics.store(state,0,1);Atomics.notify(state,0);await exited;}
  assert.deepEqual(messages,['locked','saved']);other.add(input(file));assert.equal(new DownloadHistory(store,root).list().length,2);
});

test('SHL-17: recovery removes only abandoned UUID metadata attempts under the writer lock',t=>{
  const {dir,root,file,store}=fixture(t);const h=new DownloadHistory(store,root);
  const abandoned=store+'.11111111-2222-3333-4444-555555555555.tmp';const unrelated=store+'.user.tmp';
  fs.writeFileSync(abandoned,'abandoned metadata');fs.writeFileSync(unrelated,'keep');
  const added=h.add(input(file));assert.equal(added.fileName,'clip.mp4');assert.equal(fs.existsSync(abandoned),false);assert.equal(fs.readFileSync(unrelated,'utf8'),'keep');assert.equal(fs.existsSync(store+'.lock'),false);
});

test('SHL-2: replacing a canonical managed-root ancestor never changes the authorized boundary',t=>{
  const {dir,root,file,store}=fixture(t);const h=new DownloadHistory(store,root);const id=h.add(input(file)).id;
  const moved=dir+'-moved';fs.renameSync(dir,moved);t.after(()=>fs.rmSync(moved,{recursive:true,force:true}));
  const outside=path.join(moved,'outside');fs.mkdirSync(path.join(outside,'managed'),{recursive:true});fs.writeFileSync(path.join(outside,'managed','clip.mp4'),'outside');
  fs.symlinkSync(outside,dir);const reloaded=new DownloadHistory(path.join(moved,'history.json'),root);
  assert.equal(reloaded.resolve(id),null);assert.equal(reloaded.delete(id,[],false,true).deleted,false);
  assert.equal(fs.readFileSync(path.join(outside,'managed','clip.mp4'),'utf8'),'outside');
});

test('SHL-4: a lock abandoned by a crashed writer is recovered instead of blocking history forever',async t=>{
  const {root,file,store}=fixture(t);const {spawnSync}=await import('node:child_process');
  const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});const deadPid=Number(dead.stdout);
  fs.writeFileSync(store+'.lock',String(deadPid));
  const h=new DownloadHistory(store,root);h.add(input(file));
  assert.equal(new DownloadHistory(store,root).list().length,1);assert.equal(fs.existsSync(store+'.lock'),false);
  fs.writeFileSync(store+'.lock','');const old=new Date(Date.now()-60_000);fs.utimesSync(store+'.lock',old,old);
  h.add(input(file));assert.equal(new DownloadHistory(store,root).list().length,2);
});
