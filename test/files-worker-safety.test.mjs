import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectWorkspaceAsync,cleanupWorkspaceAsync} from '../dist/workspace.js';
import {createTransfer} from '../dist/transfer.js';
import {createMainTransferHandlers,resolveMainProcessCard} from '../dist/main-process.js';
import {ManagedRoot} from '../dist/managed-root.js';
import {DownloadLedger} from '../dist/download-ledger.js';
import {DownloadHistory} from '../dist/history.js';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'files-worker-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('SHL-14: real workspace IPC inventory and cleanup yield the main event loop and coalesce scans',async t=>{const directory=fixture(t);const root=ManagedRoot.capture(directory);const provider=path.join(directory,'youtube');fs.mkdirSync(provider);for(let i=0;i<1000;i++)fs.writeFileSync(path.join(provider,`${i}.mp4`),'x');const keep=path.join(provider,'0.mp4');const first=inspectWorkspaceAsync(root,[keep]);assert.equal(inspectWorkspaceAsync(root,[keep]),first);let settled=false;first.then(()=>{settled=true;});await new Promise(r=>setImmediate(r));assert.equal(settled,false,'filesystem traversal must leave the event loop available');assert.deepEqual(await first,{fileCount:1000,totalBytes:1000,cleanupFileCount:999,cleanupBytes:999});const result=await cleanupWorkspaceAsync(root,[keep]);assert.deepEqual(result,{deletedFileCount:999,deletedBytes:999,fileCount:1,totalBytes:1});assert.equal(fs.readFileSync(keep,'utf8'),'x');});
test('SHL-3: transfer revalidates canonical containment after host waits, before native import',async t=>{const root=fixture(t),managed=path.join(root,'managed'),outside=path.join(root,'outside.mp4');fs.mkdirSync(managed);fs.writeFileSync(outside,'outside');const file=path.join(managed,'clip.mp4');fs.writeFileSync(file,'media');const entered=deferred(),release=deferred(),imports=[];const project={GetMediaPool:()=>({GetCurrentFolder:()=>null})};const transfer=createTransfer({Initialize:async()=>{entered.resolve();await release.promise;return true;},GetResolve:async()=>({GetProjectManager:async()=>({GetCurrentProject:()=>project}),GetMediaStorage:async()=>({AddItemListToMediaPool:async paths=>{imports.push(paths);return [{}];}})})},'test',{validatePath:p=>boundary.resolve(p)});const boundary=ManagedRoot.capture(managed);const ledger=new DownloadLedger(new DownloadHistory(path.join(root,'history.json'),boundary),()=>false);const card=ledger.register({path:file},boundary);const handlers=createMainTransferHandlers({requireSender(){},resolveCard:id=>resolveMainProcessCard(ledger,id),transfer});const pending=handlers.importToMediaPool({},card,'active');await entered.promise;fs.rmSync(file);fs.symlinkSync(outside,file);release.resolve();const result=await pending;assert.equal(result.ok,false);assert.equal(result.kind,'import-failed');assert.deepEqual(imports,[]);fs.rmSync(file);fs.writeFileSync(file,'restored');assert.equal((await handlers.importToMediaPool({},card,'active')).ok,true);assert.deepEqual(imports,[[file]]);});

test('SHL-15: actual engine discovery runs version probes away from the event loop',async t=>{
  const root=fixture(t);const ffmpeg=path.join(root,'ffmpeg'),ffprobe=path.join(root,'ffprobe');
  fs.writeFileSync(ffmpeg,'#!/bin/sh\n/bin/sleep 0.15\necho "ffmpeg version fixture"\n',{mode:0o700});
  fs.writeFileSync(ffprobe,'#!/bin/sh\necho "ffprobe version fixture"\n',{mode:0o700});
  const before={PATH:process.env.PATH,CLIPDOCK_FFMPEG_PATH:process.env.CLIPDOCK_FFMPEG_PATH,CLIPDOCK_FFPROBE_PATH:process.env.CLIPDOCK_FFPROBE_PATH};
  Object.assign(process.env,{PATH:root,CLIPDOCK_FFMPEG_PATH:ffmpeg,CLIPDOCK_FFPROBE_PATH:ffprobe});
  try {
    const {discoverEnginePaths}=await import('../dist/main-process.js');let settled=false;
    const pending=discoverEnginePaths();pending.then(()=>{settled=true;});
    await new Promise(r=>setImmediate(r));assert.equal(settled,false);
    const paths=await pending;assert.equal(paths.ffmpegPath,ffmpeg);assert.equal(paths.ffprobePath,ffprobe);
  } finally {for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
