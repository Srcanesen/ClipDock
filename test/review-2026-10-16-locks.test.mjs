import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {test} from 'node:test';
import {DownloadHistory} from '../dist/history.js';
import {historyInput} from './helpers/files-main.mjs';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-locks-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'managed'); fs.mkdirSync(root);
  const file = path.join(root, 'clip.mp4'); fs.writeFileSync(file, 'media');
  return {base, root, file, store: path.join(base, 'history.json')};
}
test('history refuses an aged live writer and retry preserves both successful additions', async t => {
  const f = fixture(t), state = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const {workerData:d,parentPort:p}=require('node:worker_threads');
    const {DownloadHistory}=require(d.module);
    new DownloadHistory(d.store,d.root,()=>{p.postMessage('held');Atomics.wait(new Int32Array(d.signal),0,0,5000);return 'A';}).add(d.input);
  `, {eval: true, workerData: {...f, module: path.resolve('dist/history.js'), input: {...historyInput(f.file), title: 'A'}, signal: state.buffer}});
  const exit = new Promise((resolve, reject) => {worker.once('exit', code => code ? reject(Error(`exit ${code}`)) : resolve()); worker.once('error', reject);});
  await new Promise(resolve => worker.once('message', resolve));
  const other = new DownloadHistory(f.store, f.root);
  const old = new Date(Date.now() - 120_000); fs.utimesSync(f.store + '.lock', old, old);
  try { assert.throws(() => other.add({...historyInput(f.file), title: 'B'}), /locked by another writer/); }
  finally {Atomics.store(state, 0, 1); Atomics.notify(state, 0); await exit;}
  other.add({...historyInput(f.file), title: 'B'});
  assert.deepEqual(new DownloadHistory(f.store, f.root).list().map(x => x.title), ['B', 'A']);
});

test('Keychain recovery contenders cannot erase a successful save through a stale rollback', async t => {
  const {base} = fixture(t), lock = path.join(base, 'keychain.lock'), saved = path.join(base, 'saved');
  fs.writeFileSync(lock, JSON.stringify({pid: 999999999, token: 'dead-owner-token', createdAt: Date.now() - 120000}));
  const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  const state = new Int32Array(new SharedArrayBuffer(12));
  const source = `
    const {workerData:d,parentPort:p}=require('node:worker_threads');
    const fs=require('node:fs'), fsp=require('node:fs/promises'), {EventEmitter}=require('node:events');
    const state=new Int32Array(d.signal);
    if(d.name==='A') {
      let paused=false;
      const pause=file=>{if(file===d.lock&&!paused){paused=true;p.postMessage('reclaim');Atomics.wait(state,0,0,5000);}};
      const unlink=fs.unlinkSync;fs.unlinkSync=(file,...args)=>{pause(file);return unlink(file,...args);};
      const asyncUnlink=fsp.unlink;fsp.unlink=async(file,...args)=>{pause(file);return asyncUnlink(file,...args);};
    }
    if(d.name==='B') {
      const link=fs.linkSync;
      fs.linkSync=(from,to,...args)=>{try{return link(from,to,...args);}catch(error){if(to===d.lock+'.recovery'&&error.code==='EEXIST')p.postMessage('blocked');throw error;}};
    }
    const {MacKeychainPexelsCredentialStore}=require(d.module);
    let first=true;
    const store=new MacKeychainPexelsCredentialStore((_cmd,args)=>{
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>true;
      let input='';child.stdin.write=x=>{input+=x;};
      child.stdin.end=()=>queueMicrotask(()=>{
        let value=fs.existsSync(d.saved)?fs.readFileSync(d.saved,'utf8'):null;
        if(d.name==='B'&&first){first=false;Atomics.store(state,2,1);p.postMessage('reading');Atomics.wait(state,1,0,5000);}
        let code=0;
        if(args[0]==='find-generic-password'){if(value===null)code=44;else child.stdout.emit('data',value);}
        else if(args[0]==='-i'){fs.writeFileSync(d.saved,input.match(/ -w (\\S+)\\n/)[1]);if(d.name==='B')code=1;}
        else if(args[0]==='delete-generic-password'){fs.rmSync(d.saved,{force:true});}
        child.emit('close',code);
      });return child;
    },d.lock);
    store.save(d.name.repeat(20)).then(value=>p.postMessage({value}),error=>p.postMessage({error:error.message}));
  `;
  function start(name) {
    const worker = new Worker(source, {eval: true, workerData: {name, lock, saved, signal: state.buffer, module: path.resolve('dist/pexels-credential.js')}});
    const done = new Promise((resolve, reject) => {worker.on('message', x => {if(typeof x === 'object') resolve(x);}); worker.on('error', reject);});
    const exit = new Promise(resolve => worker.on('exit', resolve));
    const contended = new Promise(resolve => worker.on('message', x => {if(x === 'blocked' || x === 'reading') resolve();}));
    return {worker, done, exit, contended};
  }
  const a = start('A'); await new Promise(resolve => a.worker.once('message', resolve));
  const b = start('B');
  try {
    // Resume only after B reaches either the recovery guard or its read snapshot.
    await b.contended;
    Atomics.store(state, 0, 1); Atomics.notify(state, 0);
    assert.deepEqual(await a.done, {value: true});
    Atomics.store(state, 1, 1); Atomics.notify(state, 1);
    assert.deepEqual(await b.done, {error: 'Could not save the Pexels credential securely.'});
    assert.equal(fs.existsSync(saved), true, 'a successful secure save must remain persisted');
    assert.equal(fs.readFileSync(saved, 'utf8'), 'A'.repeat(20));
    assert.equal(fs.existsSync(lock), false);
  } finally {
    for(const index of [0,1]) {Atomics.store(state,index,1);Atomics.notify(state,index);}
    await Promise.all([a.exit,b.exit]);
  }
});

test('history release preserves a replacement owner token', t => {
  const f = fixture(t), lock = f.store + '.lock';
  const replacement = JSON.stringify({pid: process.pid, token: 'replacement-owner', createdAt: Date.now()});
  const history = new DownloadHistory(f.store, f.root, () => {
    fs.unlinkSync(lock); fs.writeFileSync(lock, replacement); return 'Project';
  });
  assert.equal(history.add(historyInput(f.file)).title, 'Clip');
  assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
});

test('a crashed recovery guard is itself recovered without an age delay', async t => {
  const {base} = fixture(t), lock = path.join(base, 'nested.lock');
  const dead = JSON.stringify({pid: 999999999, token: 'dead-owner', createdAt: Date.now()});
  fs.writeFileSync(lock, dead); fs.writeFileSync(lock + '.recovery', dead);
  const {tryAcquireFileLock} = await import('../dist/file-lock.js');
  const owner = tryAcquireFileLock(lock);
  assert.equal(typeof owner?.release, 'function');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.equal(fs.existsSync(lock + '.recovery'), false);
  owner.release(); owner.release();
  assert.equal(fs.existsSync(lock), false);
});
