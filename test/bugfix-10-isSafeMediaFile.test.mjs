import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {isSafeMediaFile} from '../dist/main-process.js';
const require=createRequire(import.meta.url);
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(),'clipdock-issafe-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function boundary(fsOverrides){const module={exports:{}};vm.runInNewContext(fs.readFileSync('dist/path-boundary.js','utf8'),{module,exports:module.exports,require:id=>id==='node:fs'?{...fs,...fsOverrides}:require(id)});return module.exports;}
test('isSafeMediaFile stats the canonical file once and rejects a canonical-stat error',t=>{const dir=fixture(t),file=path.join(dir,'real.mp4');fs.writeFileSync(file,'media');const calls=[];const real=boundary({statSync:p=>{calls.push(p);return fs.statSync(p);}});assert.equal(real.isSafeMediaFile(file,dir),true);assert.deepEqual(calls,[file]);assert.equal(boundary({statSync(){throw new Error('vanished');}}).isSafeMediaFile(file,dir),false);});
test('isSafeMediaFile rejects symlinks and accepts regular files',t=>{const dir=fixture(t),file=path.join(dir,'real.mp4'),link=path.join(dir,'link.mp4');fs.writeFileSync(file,'media');fs.symlinkSync(file,link);assert.equal(isSafeMediaFile(file),true);assert.equal(isSafeMediaFile(link),false);assert.equal(isSafeMediaFile(path.join(dir,'missing.mp4')),false);});
test('isSafeMediaFile rejects a file replaced by a directory between lstat and canonical stat',t=>{const dir=fixture(t),file=path.join(dir,'swap.mp4');fs.writeFileSync(file,'media');const real=boundary({realpathSync:p=>{const canonical=fs.realpathSync(p);if(p===file){fs.rmSync(file);fs.mkdirSync(file);}return canonical;}});assert.equal(real.isSafeMediaFile(file,dir),false);assert.equal(fs.statSync(file).isDirectory(),true);});
