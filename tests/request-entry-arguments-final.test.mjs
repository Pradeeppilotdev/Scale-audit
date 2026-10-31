import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

for(const[file,declaration]of [
 ['app/api/data/route.ts','export function GET'],
 ['pages/api/data.ts','export default function handler'],
])test('framework entry supplies two arguments without suppressing later defaults: '+file,async t=>{
 const root=await mkdtemp('/tmp/scale-request-entry-arguments-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.dirname(path.join(root,file)),{recursive:true});
 await writeFile(path.join(root,file),`import fs from 'node:fs';
${declaration}(req=fs.readFileSync('unused'),res,
 third=fs.readFileSync('live')){return res}
`);
 const rows=await detectSyncIo(root);
 assert.equal(rows.length,2);
 assert.equal(rows.find(row=>row.line===2)?.severity,'medium');
 assert.equal(rows.find(row=>row.line===3)?.severity,'high');
});
