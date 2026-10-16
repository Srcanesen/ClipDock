import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {captureManagedRoot} from '../dist/main-process.js';

test('captured managed root creates a missing directory and rejects an outside artifact',t=>{
  const tmp=fs.mkdtempSync(path.join(tmpdir(),'clipdock-main-mkdir-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const root=path.join(tmp,'a','b','ClipDock'),outside=path.join(tmp,'outside.mp4');fs.writeFileSync(outside,'media');
  assert.throws(()=>captureManagedRoot(root,outside),/safely register/);
  assert.equal(fs.existsSync(root),true);
  const inside=path.join(root,'clip.mp4');fs.writeFileSync(inside,'media');
  assert.equal(captureManagedRoot(root,inside),fs.realpathSync(root));
});
