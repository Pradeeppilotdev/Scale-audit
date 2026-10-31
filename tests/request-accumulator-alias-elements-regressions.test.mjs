import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {detectSyncIo} from '../dist/detectors/syncIo.js';

async function high(t, body) {
  const root = await mkdtemp('/tmp/scale-accumulator-alias-elements-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(root + '/main.ts', `import http from 'node:http';import fs from 'node:fs';${body}`);
  return (await detectSyncIo(root)).filter(row => row.id === 'sync-io' && row.severity === 'high');
}
for (const method of ['reduce', 'reduceRight']) {
  test(method + ' preserves an aliased factory initial accumulator used read-only', async t => {
    assert.equal((await high(t, `function make(){return[1]}const init=make();http.createServer(()=>[0].${method}(acc=>{acc.forEach(()=>fs.readFileSync('live'));return acc},init));`)).length, 1);
  });
  test(method + ' preserves factory-produced source element payloads', async t => {
    assert.equal((await high(t, `function make(){return[1]}http.createServer(()=>[make()].${method}((acc,value)=>{value.forEach(()=>fs.readFileSync('live'));return acc},0));`)).length, 1);
  });
  test(method + ' preserves the first accumulator source element without an initial value', async t => {
    const items = method === 'reduce' ? '[make(),0]' : '[0,make()]';
    assert.equal((await high(t, `function make(){return[1]}http.createServer(()=>${items}.${method}(acc=>{acc.forEach(()=>fs.readFileSync('live'));return acc}));`)).length, 1);
  });
}
test('an unchanged accumulator can be returned through a const alias', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();http.createServer(()=>[0].reduce(acc=>{const alias=acc;alias.forEach(()=>fs.readFileSync('live'));return alias},init));`)).length, 1);
});
test('a reducer can forward the accumulator to an inspectable read-only helper', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();function visit(items){items.forEach(()=>fs.readFileSync('live'))}http.createServer(()=>[0].reduce(acc=>{visit(acc);return acc},init));`)).length, 1);
});
test('a bound reducer uses the accumulator parameter after the bound prefix', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();function visit(prefix,acc){acc.forEach(()=>fs.readFileSync('live'));return acc}http.createServer(()=>[0].reduce(visit.bind(null,0),init));`)).length, 1);
});
for (const operation of ['acc.push(1)', 'external(acc)', 'acc[0]=2']) test('accumulator mutation and escape remain uncertain: ' + operation, async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();http.createServer(()=>[0].reduce(acc=>{${operation};acc.forEach(()=>fs.readFileSync('possible'));return acc},init));`)).length, 0);
});
test('mutated native reduce is not certified as a safe accumulator consumer', async t => {
  assert.equal((await high(t, `Array.prototype.reduce=(callback,acc)=>external(acc);function make(){return[1]}const init=make();http.createServer(()=>[0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('possible'));return acc},init));`)).length, 0);
});
test('a reducer using arguments remains an uncertain accumulator consumer', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();http.createServer(()=>[0].reduce(function(){external(arguments[0]);return arguments[0]},init));function unused(){fs.readFileSync('dead')}`)).length, 0);
});
test('a bound rest reducer is not certified read-only without inspecting its rest array', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();function visit(...values){external(values);values[1].forEach(()=>fs.readFileSync('possible'))}http.createServer(()=>[0].reduce(visit.bind(null,0),init));`)).length, 0);
});
for (const keyword of ['async function', 'function*']) test(keyword + ' source factories do not donate eventual array payloads', async t => {
  assert.equal((await high(t, `${keyword} make(){return[1]}http.createServer(()=>[make()].reduce((acc,value)=>{value.forEach(()=>fs.readFileSync('dead'));return acc},0));`)).length, 0);
});
test('native Array arguments retain factory-produced array payloads', async t => {
  assert.equal((await high(t, `function make(){return[1]}http.createServer(()=>new Array(make()).forEach(value=>value.forEach(()=>fs.readFileSync('live'))));`)).length, 1);
});
test('a numeric factory argument to Array creates holes rather than a numeric element', async t => {
  assert.equal((await high(t, `function make(){return 2}http.createServer(()=>new Array(make()).forEach(()=>fs.readFileSync('dead')));`)).length, 0);
});
test('a nested factory source retains both array container levels', async t => {
  assert.equal((await high(t, `function make(){return[[1]]}http.createServer(()=>[make()].reduce((acc,value)=>{value.forEach(items=>items.forEach(()=>fs.readFileSync('live')));return acc},0));`)).length, 1);
});
test('returning a member of the accumulator is not an unchanged-identity proof', async t => {
  assert.equal((await high(t, `function make(){return[1]}const init=make();http.createServer(()=>[0].reduce(acc=>{acc.forEach(()=>fs.readFileSync('possible'));return acc.nested},init));`)).length, 0);
});
test('read-only native reductions do not poison a factory callback source alias', async t => {
  assert.equal((await high(t, `function make(){return[1]}const item=make();http.createServer(()=>[item].reduce((acc,value)=>{value.forEach(()=>fs.readFileSync('live'));return acc},0));`)).length, 1);
});
