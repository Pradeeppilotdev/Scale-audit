import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import {Workspace} from '../dist/workspace.js';
async function fixture(t,files){
 const root=await mkdtemp(path.join(os.tmpdir(),'scale-module-await-parser-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [name,text]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text)}
 return Workspace.load(root);
}
function awaits(sf){let count=0;const visit=node=>{if(ts.isAwaitExpression(node))count++;ts.forEachChild(node,visit)};visit(sf);return count}
for(const name of ['main.mts','main.mjs'])test('explicit ESM extension parses parenthesized await without imports: '+name,async t=>{
 const ws=await fixture(t,{[name]:`await (setup());`});assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),1);
});
for(const name of ['main.ts','main.js'])test('module package parses parenthesized await without imports: '+name,async t=>{
 const ws=await fixture(t,{'package.json':'{"type":"module"}',[name]:`await (setup());`});assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),1);
});
test('nearest CommonJS package preserves await identifier calls',async t=>{
 const ws=await fixture(t,{'package.json':'{"type":"module"}','child/package.json':'{"type":"commonjs"}','child/main.js':`const await=value=>value;await (setup());`});
 assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),0);
});
for(const name of ['main.cjs','main.cts'])test('explicit CommonJS extension overrides module package: '+name,async t=>{
 const ws=await fixture(t,{'package.json':'{"type":"module"}',[name]:`const await=value=>value;await (setup());`});assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),0);
});
test('forced TypeScript module context parses parenthesized await',async t=>{
 const ws=await fixture(t,{'tsconfig.json':'{"compilerOptions":{"moduleDetection":"force","module":"esnext"}}','main.ts':`await (setup());`});
 assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),1);
});
test('ordinary CommonJS script still permits an await identifier',async t=>{
 const ws=await fixture(t,{'main.js':`const await=value=>value;await (setup());`});assert.equal(ws.coverage.skipped.length,0);assert.equal(awaits(ws.units[0].sf),0);
});
