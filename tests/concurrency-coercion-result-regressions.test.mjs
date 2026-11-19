import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectUnboundedConcurrency} from '../dist/detectors/unboundedConcurrency.js';
import {AnalysisBudget,AnalysisLimitError} from '../dist/analysisBudget.js';
import {runAudit} from '../dist/runner.js';

const header="import pLimit from 'p-limit';const limit=pLimit(5);";
async function fixture(t,source){const root=await mkdtemp(join(tmpdir(),'scale-coercion-result-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'route.ts'),source);return root;}
const sourceFor=(expression,setup='')=>`${header}${setup}export function GET(users){return Promise.all(users.map(user=>limit(()=>fetch(user.url),${expression})));}`;

for(const [name,expression,expected] of [
 ['returned toJSON is not reinvoked',"JSON.stringify({toJSON(){return {toJSON(){fetch(user.url);return 1;},item:1};}})",0],
 ['returned getter is not hidden by returned toJSON',"JSON.stringify({toJSON(){return {toJSON(){return 1;},get item(){fetch(user.url);return 1;}};}})",1],
 ['getter results use the ordinary serialization phase',"JSON.stringify({get item(){return {toJSON(){fetch(user.url);return 1;}};}})",1],
 ['returned data object retains nested serializers',"JSON.stringify({toJSON(){return {item:{toJSON(){fetch(user.url);return 1;}}};}})",1],
 ['replacer result ignores its own serializer',"JSON.stringify(1,(key,value)=>key===''?{toJSON(){fetch(user.url);return 1;},item:1}:value)",0],
 ['replacer result retains property getters',"JSON.stringify(1,(key,value)=>key===''?{toJSON(){return 1;},get item(){fetch(user.url);return 1;}}:value)",1],
 ['conditional serializer results retain both property paths',"JSON.stringify({toJSON(){return flag?{item:1}:{get item(){fetch(user.url);return 1;}};}})",1],
 ['literal selected serializer result excludes unused getters',"JSON.stringify({toJSON(){return true?{item:1}:{get item(){fetch(user.url);return 1;}};}})",0],
 ['parenthesized this retains serializer property phase',"JSON.stringify({toJSON(){return (this);},get item(){fetch(user.url);return 1;}})",1],
 ['conditional receiver can expose getters',"JSON.stringify({toJSON(){return user ? this : undefined},get item(){fetch(user.url);return 1}})",1],
 ['conditional receiver can have only pure getters',"JSON.stringify({toJSON(){return user ? this : undefined},get item(){return 1}})",0],
 ['a false branch does not serialize its receiver',"JSON.stringify({toJSON(){return false ? this : undefined},get item(){fetch(user.url);return 1}})",0],
 ['the final comma operand retains its receiver',"JSON.stringify({toJSON(){return (0,this)},get item(){fetch(user.url);return 1}})",1],
 ['a discarded receiver does not read its getters',"JSON.stringify({toJSON(){return (this,0)},get item(){fetch(user.url);return 1}})",0],
 ['a short-circuited receiver is not returned',"JSON.stringify({toJSON(){return false && this},get item(){fetch(user.url);return 1}})",0],
 ['a truthy receiver is discarded on the left of &&',"JSON.stringify({toJSON(){return this && 1},get item(){fetch(user.url);return 1}})",0],
 ['native undefined is an absent JSON replacer',"JSON.stringify(user,undefined,2)",0],
 ['an absent JSON reviver is synchronous',"JSON.parse('{}',undefined)",0],
 ['evaluating an absent replacer can still schedule work',"JSON.stringify(user,void fetch(user.url),2)",1],
 ['arrow serializer does not bind its receiver',"JSON.stringify({toJSON:()=>this,get item(){fetch(user.url);return 1;}})",0],
 ['Number invokes valueOf',"Number({valueOf(){fetch(user.url);return 1;}})",1],
 ['Number invokes fallback toString',"Number({valueOf(){return {};},toString(){fetch(user.url);return '1';}})",1],
 ['Number skips fallback after a primitive',"Number({valueOf(){return 1;},toString(){fetch(user.url);return '1';}})",0],
 ['Number accepts a null primitive',"Number({valueOf(){return null;},toString(){fetch(user.url);return '1';}})",0],
 ['Number accepts undefined from fallthrough',"Number({valueOf(){},toString(){fetch(user.url);return '1';}})",0],
 ['String invokes toString first',"String({valueOf(){return 1;},toString(){fetch(user.url);return '1';}})",1],
 ['String skips valueOf after a string',"String({toString(){return '1';},valueOf(){fetch(user.url);return 1;}})",0],
 ['String invokes fallback valueOf',"String({toString(){return {};},valueOf(){fetch(user.url);return 1;}})",1],
 ['Math invokes valueOf',"Math.abs({valueOf(){fetch(user.url);return 1;}})",1],
 ['Math uses numeric hints',"Math.abs({valueOf(){return 1;},toString(){fetch(user.url);return '1';}})",0],
 ['Math variadic arguments all coerce',"Math.max(1,2,{valueOf(){fetch(user.url);return 3;}})",1],
 ['Math binary second argument coerces',"Math.pow(2,{valueOf(){fetch(user.url);return 3;}})",1],
 ['Number ignores unused arguments',"Number(1,{valueOf(){fetch(user.url);return 1;}})",0],
 ['Math unary ignores unused arguments',"Math.abs(1,{valueOf(){fetch(user.url);return 1;}})",0],
 ['Math random ignores its arguments',"Math.random({valueOf(){fetch(user.url);return 1;}})",0],
 ['Boolean does not coerce objects',"Boolean({[Symbol.toPrimitive](){fetch(user.url);return 1;}})",0],
 ['pure numeric conversion',"Number({valueOf(){return 1;}})",0],
 ['pure string conversion',"String({toString(){return '1';}})",0],
 ['pure ordinary object',"Number({item:1})",0],
 ['numeric conversion invokes exotic hook',"Number({[Symbol.toPrimitive](){fetch(user.url);return 1;}})",1],
 ['string conversion invokes exotic hook',"String({[Symbol['toPrimitive']](){fetch(user.url);return '1';}})",1],
 ['exotic primitive skips both ordinary methods',"Number({[Symbol.toPrimitive](){return 1;},valueOf(){fetch(user.url);return 1;},toString(){fetch(user.url);return '1';}})",0],
 ['nonprimitive exotic result throws without fallback',"Number({[Symbol.toPrimitive](){return {};},valueOf(){fetch(user.url);return 1;}})",0],
 ['absent exotic hook allows ordinary methods',"Number({[Symbol.toPrimitive]:undefined,valueOf(){fetch(user.url);return 1;}})",1],
 ['null exotic hook allows ordinary methods',"Number({[Symbol.toPrimitive]:null,valueOf(){fetch(user.url);return 1;}})",1],
 ['noncallable exotic hook throws without fallback',"Number({[Symbol.toPrimitive]:1,valueOf(){fetch(user.url);return 1;}})",0],
 ['exotic hook getter executes',"Number({get [Symbol.toPrimitive](){fetch(user.url);return ()=>1;}})",1],
 ['ordinary method getter executes',"Number({get valueOf(){fetch(user.url);return ()=>1;}})",1],
 ['ordinary method getter returned callback executes',"Number({get valueOf(){return ()=>{fetch(user.url);return 1;};}})",1],
 ['pure ordinary method getter',"Number({get valueOf(){return ()=>1;}})",0],
 ['default object stringification reads tag getter',"String({get [Symbol.toStringTag](){fetch(user.url);return 'Item';}})",1],
 ['JSON ignores symbol getters',"JSON.stringify({get [Symbol.toPrimitive](){fetch(user.url);return ()=>1;},item:1})",0],
 ['Object.values ignores symbol getters',"Object.values({get [Symbol.toStringTag](){fetch(user.url);return 'Item';},item:1})",0],
 ['Number arrays stringify their elements',"Number([{toString(){fetch(user.url);return '1';}}])",1],
 ['String arrays stringify their elements',"String([{toString(){fetch(user.url);return '1';}}])",1],
 ['pure array coercion',"Number([{toString(){return '1';}}])",0],
 ['parseInt coerces text',"parseInt({toString(){fetch(user.url);return '1';}})",1],
 ['parseInt coerces radix',"parseInt('10',{valueOf(){fetch(user.url);return 10;}})",1],
 ['parseFloat coerces text',"parseFloat({toString(){fetch(user.url);return '1';}})",1],
 ['isFinite coerces numeric input',"isFinite({valueOf(){fetch(user.url);return 1;}})",1],
 ['Date.parse coerces text',"Date.parse({toString(){fetch(user.url);return '2000-01-01';}})",1],
 ['JSON.parse coerces text',"JSON.parse({toString(){fetch(user.url);return '{}';}})",1],
 ['native string method coerces search text',"'abc'.includes({toString(){fetch(user.url);return 'a';}})",1],
 ['native string method pure coercion',"'abc'.includes({toString(){return 'a';}})",0],
 ['Object.hasOwn coerces property key',"Object.hasOwn({}, {[Symbol.toPrimitive](){fetch(user.url);return 'item';}})",1],
 ['generic unknown numeric data stays heuristic',"Number(user.input)",0],
 ['generic unknown JSON data stays heuristic',"JSON.stringify(user.input)",0],
 ['generic unknown Object data stays heuristic',"Object.values(user.input)",0],
])test(`serialization and coercion: ${name}`,async t=>{const root=await fixture(t,sourceFor(expression));assert.equal((await detectUnboundedConcurrency(root)).length,expected);});

for(const [name,setup,expression,expected]of[
 ['an immutable alias of undefined is an absent replacer',"const nothing=undefined;","JSON.stringify(user,nothing,2)",0],
 ['a shadowed undefined replacer can run user code',"const undefined=()=>fetch(url);","JSON.stringify(user,undefined,2)",1],
 ['captured pure numeric value',"const payload={valueOf(){return 1;}};const alias=payload;","Number(alias)",0],
 ['captured eager numeric value',"const payload={valueOf(){fetch(url);return 1;}};const alias=payload;","Number(alias)",1],
 ['replaced coercion method',"const payload={valueOf(){return 1;}};payload.valueOf=()=>fetch(url);","Number(payload)",1],
 ['mutated numeric builtin can mutate a later inspected object',"const payload={item:1};Number=custom;Number(payload);","Object.values(payload)",1],
 ['mutated JSON builtin can mutate a later inspected object',"const payload={item:1};JSON.parse=custom;JSON.parse(payload);","Object.values(payload)",1],
 ['primitive readonly call preserves later pure JSON evidence',"const payload={valueOf(){return 1;},item:1};Number(payload);","JSON.stringify(payload)",0],
 ['changed primitive string method is not certified',"String.prototype.toLowerCase=async()=>{};","'abc'.toLowerCase()",1],
])test(`coercion mutation evidence: ${name}`,async t=>{assert.equal((await detectUnboundedConcurrency(await fixture(t,sourceFor(expression,setup)))).length,expected);});

for(const reverse of[false,true])test(`serializer caches retain receiver and phase identity (${reverse})`,async t=>{
 const expressions=["JSON.stringify({toJSON:serialize,item:1})","JSON.stringify({toJSON:serialize,get item(){fetch(user.url);return 1;}})"];
 if(reverse)expressions.reverse();
 const source=header+"function serialize(){return this;}export function GET(users){"+expressions.map(expr=>`Promise.all(users.map(user=>limit(()=>fetch(user.url),${expr})));`).join('')+'}';
 assert.equal((await detectUnboundedConcurrency(await fixture(t,source))).length,1);
});

test('native runtime distinguishes serializer results, getters, coercion hints and ignored arguments',()=>{
 let calls=0;const fetch=()=>{calls++;return Promise.resolve(1)};
 JSON.stringify({toJSON(){return {toJSON(){fetch();return 1},item:1}}});assert.equal(calls,0);
 JSON.stringify({toJSON(){return {toJSON(){return 1},get item(){fetch();return 1}}}});assert.equal(calls,1);
 JSON.stringify({get item(){return {toJSON(){fetch();return 1}}}});assert.equal(calls,2);
 Number({valueOf(){return 1},toString(){fetch();return '1'}});assert.equal(calls,2);
 String({valueOf(){return 1},toString(){fetch();return '1'}});assert.equal(calls,3);
 Number({[Symbol.toPrimitive](){fetch();return 1}});assert.equal(calls,4);
 Boolean({[Symbol.toPrimitive](){fetch();return 1}});Math.abs(1,{valueOf(){fetch();return 1}});assert.equal(calls,4);
});

test('shared serializer return inspection grows linearly across callback sites',async t=>{
 const work=[];
 for(const count of[250,500]){
  const source=header+`function serialize(){${'if(flag)return 1;'.repeat(count)}return 1;}export function GET(users){${Array.from({length:count},()=>"Promise.all(users.map(user=>limit(()=>fetch(user.url),JSON.stringify({toJSON:serialize}))));").join('')}}`;
  const root=await fixture(t,source);const take=AnalysisBudget.prototype.take;let units=0;
  AnalysisBudget.prototype.take=function(n=1){if(this.label==='Concurrency callback')units+=n;return take.call(this,n)};
  try{assert.equal((await detectUnboundedConcurrency(root)).length,0);work.push(units);}finally{AnalysisBudget.prototype.take=take;}
 }
 assert.ok(work[1]<work[0]*2.4,`expected shared result reuse: ${work}`);
});

test('hook work exhaustion remains an explicitly incomplete public audit',async t=>{
 const root=await fixture(t,sourceFor("Number({valueOf(){return 1;}})"));const take=AnalysisBudget.prototype.take;
 AnalysisBudget.prototype.take=function(n=1){if(this.label==='Concurrency callback')throw new AnalysisLimitError('forced callback analysis work budget exceeded');return take.call(this,n)};
 try{const report=await runAudit(root);assert.equal(report.complete,false);assert.equal(report.detectors.find(d=>d.name==='detectUnboundedConcurrency').status,'failed');}finally{AnalysisBudget.prototype.take=take;}
});
