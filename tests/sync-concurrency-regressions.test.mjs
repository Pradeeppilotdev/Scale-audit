import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runAudit} from '../dist/runner.js';
async function audit(source,expected,files={}) {
 const root=await mkdtemp(path.join(tmpdir(),'scale-sync-projection-'));
 try {
  for(const[file,text]of Object.entries({'route.ts':source,...files}))await writeFile(path.join(root,file),text);
  const report=await runAudit(root);assert.equal(report.complete,true);
  assert.equal(report.findings.filter(f=>f.id==='unbounded-concurrency').length,expected);
 }finally{await rm(root,{recursive:true,force:true});}
}
for(const expression of ['JSON.parse(u)','JSON.stringify(u)','Math.abs(u)','Number(u)','String(u)','Boolean(u)','parseInt(u)','parseFloat(u)','Date.now()','Array.isArray(u)','Object.keys(u)','Object.entries(u)'])test(`native synchronous projection ${expression} stays quiet`,()=>audit(`export function GET(users){return Promise.all(users.map(u=>${expression}));}`,0));
for(const declaration of ["const JSON={parse:async u=>u};","const Math={abs:async u=>u};","const Number=async u=>u;"])test('shadowed synchronous-looking builtins stay candidates',()=>audit(`${declaration}export function GET(users){return Promise.all(users.map(u=>${declaration.includes('JSON')?'JSON.parse(u)':declaration.includes('Math')?'Math.abs(u)':'Number(u)'}));}`,1));
for(const expression of ['JSON.parse(fetch(u.url))','Number(fetch(u.url))','JSON.parse(u,()=>fetch(u.url))','JSON.stringify(u,()=>fetch(u.url))'])test(`synchronous wrapper still exposes asynchronous work ${expression}`,()=>audit(`export function GET(users){return Promise.all(users.map(u=>${expression}));}`,1));
test('synchronous JSON reviver and literal replacer array stay quiet',()=>audit("export function GET(users){return Promise.all(users.map(u=>{JSON.parse(u,(key,value)=>value);return JSON.stringify(u,['name']);}));}",0));
test('discarded network call inside otherwise synchronous body remains detected',()=>audit("export function GET(users){return Promise.all(users.map(u=>{fetch(u.url);return u.id;}));}",1));
test('typed string local formatter is certified synchronously',()=>audit("const format=(x:string)=>x.trim();export function GET(users){return Promise.all(users.map(u=>format(u)));}",0));
test('cross-file typed local formatter retains sync proof',()=>audit("import {format} from './format.js';export function GET(users){return Promise.all(users.map(u=>format(u)));}",0,{'format.ts':'export const format=(x:string)=>x.trim();'}));
test('inspectable sync function declaration and chained helper stay quiet',()=>audit("function increment(x){return Math.abs(x)+1;}const format=x=>increment(x);export function GET(users){return Promise.all(users.map(u=>format(u)));}",0));
test('async local helper remains scheduled',()=>audit("const format=async x=>x;export function GET(users){return Promise.all(users.map(u=>format(u)));}",1));
test('local sync-looking helper cannot hide fire-and-forget work',()=>audit("const format=x=>{fetch(x);return x;};export function GET(users){return Promise.all(users.map(u=>format(u)));}",1));
test('database write inside local helper uses file context',()=>audit("import mongoose from 'mongoose';const User=mongoose.model('User',{});const save=x=>User.create(x);export function GET(users){return Promise.all(users.map(u=>save(u)));}",1));
test('unresolved exterior formatter remains unknown',()=>audit("import {format} from 'external';export function GET(users){return Promise.all(users.map(u=>format(u)));}",1));
test('unknown object toString is not trusted by name',()=>audit("export function GET(users){return Promise.all(users.map(u=>u.toString()));}",1));
test('recursive local functions cannot establish sync proof',()=>audit("function format(x){return format(x);}export function GET(users){return Promise.all(users.map(u=>format(u)));}",1));
test('reassigned function declaration cannot establish sync proof',()=>audit("function format(x){return x;}format=async x=>x;export function GET(users){return Promise.all(users.map(u=>format(u)));}",1));
for(const assignment of ['JSON.parse=async x=>fetch(x);','globalThis.JSON.parse=async x=>fetch(x);',"Object.assign(JSON,{parse:async x=>fetch(x)});"])test('builtin mutation invalidates sync certification',()=>audit(`${assignment}export function GET(users){return Promise.all(users.map(u=>JSON.parse(u)));}`,1));

test('local helper parameter default cannot hide asynchronous work',()=>audit("const format=(value=fetch(url))=>value;export function GET(users){return Promise.all(users.map(()=>format()));}",1));
test('destructured parameter default cannot hide asynchronous work',()=>audit("const format=({value=fetch(url)}={})=>value;export function GET(users){return Promise.all(users.map(()=>format()));}",1));
test('synchronous parameter defaults can still be certified',()=>audit("const format=(value=JSON.parse('{}'))=>value;export function GET(users){return Promise.all(users.map(()=>format()));}",0));
test('database tagged templates remain concurrent work',()=>audit("export function GET(users){return Promise.all(users.map(()=>prisma.$queryRaw`SELECT * FROM users`));}",1));
test('unknown tagged templates do not establish synchronous proof',()=>audit("export function GET(users){return Promise.all(users.map(u=>format`value:${u}`));}",1));

for (const [label, setup, projection, expected] of [
 ['excluded getter', '', "JSON.stringify({id:u,get extra(){fetch(u)}},['id'])", 0],
 ['included getter', '', "JSON.stringify({id:u,get extra(){fetch(u)}},['extra'])", 1],
 ['empty list', '', "JSON.stringify({get extra(){fetch(u)}},[])", 0],
 ['nested property list', '', "JSON.stringify({item:{id:u,get extra(){fetch(u)}}},['item','id'])", 0],
 ['nested selected property', '', "JSON.stringify({item:{get extra(){fetch(u)}}},['item','extra'])", 1],
 ['array elements still serialize', '', "JSON.stringify([{get x(){fetch(u)}}],['x'])", 1],
 ['toJSON still runs', '', "JSON.stringify({toJSON(){fetch(u);return {}}},[])", 1],
 ['serializer result is filtered', '', "JSON.stringify({toJSON(){return {get x(){fetch(u)}}}},[])", 0],
 ['numeric property', '', "JSON.stringify({get 7(){fetch(u)}},[7])", 1],
 ['immutable property list alias', "const allowed=['id'];", "JSON.stringify({id:u,get x(){fetch(u)}},allowed)", 0],
 ['mutated property list', "const allowed=['id'];allowed.push('x');", "JSON.stringify({id:u,get x(){fetch(u)}},allowed)", 1],
 ['unknown property name', '', "JSON.stringify({get x(){fetch(u)}},[u])", 1],
]) test(`JSON serialization property list: ${label}`, () => audit(`${setup}export function GET(users){return Promise.all(users.map(u=>${projection}));}`,expected));

for (const selectFirst of [true,false]) test(`shared hook results preserve the JSON property list in either order (${selectFirst})`,()=> {
 const list=selectFirst?["'extra'","'id'"]:["'id'","'extra'"];
 return audit(`const value={toJSON(){return {id:1,get extra(){fetch('/work')}}}};export function GET(users){
  Promise.all(users.map(()=>JSON.stringify(value,[${list[0]}])));
  return Promise.all(users.map(()=>JSON.stringify(value,[${list[1]}])));
 }`,1);
});

for(const [label,callback,expected] of [
 ['generator body is lazy', 'function*(id){yield fetch(id)}', 0],
 ['async generator body is lazy', 'async function*(id){yield fetch(id)}', 0],
 ['generator parameter defaults run at invocation', 'function*(id,idx,arr,extra=fetch(id)){yield id}', 1],
]) test(label,()=>audit(`export function GET(ids){return Promise.all(ids.map(${callback}));}`,expected));
