import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runAudit } from '../dist/runner.js';

async function audit(files, verify) {
  const root=await mkdtemp(path.join(tmpdir(),'scale-cross-file-'));
  try {
    for(const [file,content] of Object.entries(files)){
      await mkdir(path.dirname(path.join(root,file)),{recursive:true});
      await writeFile(path.join(root,file),content);
    }
    await verify(await runAudit(root),root);
  } finally {await rm(root,{recursive:true,force:true});}
}
const byId=(r,id)=>r.findings.filter(f=>f.id===id);
const service="import {Pool} from 'pg'; export class Service{constructor(){this.pool=new Pool();}}";
const nestModule="import {Module} from '@nestjs/common'; import {provider} from './provider.js'; @Module({providers:[provider]}) export class AppModule{}";

test('pool-owning classes allocated in another file are followed through aliases and re-exports',async()=>{
  await audit({
    'service.ts':service,
    'barrel.ts':"export {Service as DatabaseService} from './service.js';",
    'route.ts':"import {DatabaseService as DB} from './barrel.js'; export function GET(req,res){return new DB();}",
  },r=>{
    assert.equal(byId(r,'per-request-client').length,1);
    assert.equal(byId(r,'per-request-client')[0].file,'service.ts');
    assert.equal(byId(r,'per-request-client')[0].severity,'high');
  });
});

test('external DB re-export identity distinguishes real and unrelated Pool classes',async()=>{
  await audit({
    'db.ts':"export {Pool as DatabasePool} from 'pg';",
    'custom.ts':"export class Pool {}",
    'route.ts':"import {DatabasePool} from './db.js'; import {Pool} from './custom.js'; export function GET(req,res){new Pool();return new DatabasePool();}",
  },r=>{
    assert.equal(byId(r,'per-request-client').length,1);
    assert.match(byId(r,'per-request-client')[0].message,/DatabasePool/);
  });
});

test('default and namespace imports preserve class allocation identity',async()=>{
  for(const route of [
    "import Service from './service.js'; export function GET(req,res){return new Service();}",
    "import * as services from './service.js'; export function GET(req,res){return new services.Service();}",
  ]) await audit({
    'service.ts':service+'\nexport default Service;',
    'route.ts':route,
  },r=>assert.equal(byId(r,'per-request-client').length,1));
});

test('exported Axios instances retain bounded, unbounded and mutated defaults across barrels',async()=>{
  for(const [config,mutation,expected]of [['{}','',1],['{timeout:5000}','',0],['{timeout:5000}',"api.defaults.timeout=0;",1]]){
    await audit({
      'http.ts':`import axios from 'axios'; export const api=axios.create(${config});`,
      'barrel.ts':"export {api} from './http.js';",
      'route.ts':`import {api} from './barrel.js'; ${mutation} export function GET(req,res){return api.get('url');}`,
    },r=>{
      const f=byId(r,'outbound-no-timeout');assert.equal(f.length,expected);
      if(mutation)assert.equal(f[0].confidence,'low');
    });
  }
});

test('exported HTTP default instances and callable clients are resolved',async()=>{
  await audit({
    'http.ts':"import axios from 'axios'; export default axios.create({});",
    'route.ts':"import api from './http.js'; export function GET(req,res){return api('url');}",
  },r=>assert.equal(byId(r,'outbound-no-timeout').length,1));
});

test('JSONC config, inherited aliases, nested configs and .mjs/.cjs source mappings are honored',async()=>{
  await audit({
    'tsconfig.base.json':'{ // shared aliases\n "compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}} }',
    'tsconfig.json':'{"extends":"./tsconfig.base.json",}',
    'cli.ts':"#!/usr/bin/env node\nimport {read} from './lib/io.js';read();",
    'lib/io.ts':"import fs from 'node:fs';export function read(){return fs.readFileSync('x');}",
    'route.ts':"import {read} from '@lib/io';export function GET(req,res){return read();}",
  },r=>assert.equal(byId(r,'sync-io')[0].severity,'high'));
  await audit({
    'apps/web/tsconfig.json':'{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
    'apps/web/src/io.mts':"import fs from 'node:fs';export function read(){return fs.readFileSync('x');}",
    'apps/web/route.ts':"import {read} from '@/io.mjs';export function GET(req,res){return read();}",
  },r=>assert.equal(byId(r,'sync-io')[0].severity,'high'));
});

test('cyclic barrels terminate and type-only request imports do not change CLI context',async()=>{
  await audit({
    'a.ts':"export * from './b.js';export {api} from './http.js';",
    'b.ts':"export * from './a.js';",
    'http.ts':"import axios from 'axios';export const api=axios.create({});",
    'route.ts':"import {api} from './b.js';export function GET(req,res){return api.get('url');}",
  },r=>assert.equal(byId(r,'outbound-no-timeout').length,1));
  await audit({
    'cli.ts':"#!/usr/bin/env node\nimport {read} from './io.js';read();",
    'io.ts':"import fs from 'node:fs';export function read(){return fs.readFileSync('x');}",
    'route.ts':"import type {read} from './io.js';export type Read=typeof read;",
  },r=>assert.equal(byId(r,'sync-io')[0].severity,'info'));
});

test('Nest REQUEST scopes and implicit REQUEST injection report pool recreation',async()=>{
  for(const metadata of [
    "@Injectable({scope:Scope.REQUEST}) export class Service{constructor(){this.pool=new Pool();}}",
    "@Injectable() export class Service{constructor(@Inject(REQUEST) private req){this.pool=new Pool();}}",
  ]) await audit({
    'service.ts':"import {Injectable,Inject,Scope} from '@nestjs/common';import {REQUEST} from '@nestjs/core';import {Pool} from 'pg';"+metadata,
  },r=>{
    assert.equal(byId(r,'per-request-client').length,1);
    assert.equal(byId(r,'per-request-client')[0].severity,'high');
  });
});

test('default and explicit singleton factory providers are not mistaken for request allocations',async()=>{
  for(const scope of ['',',scope:Scope.DEFAULT']) await audit({
    'provider.ts':`import {Scope} from '@nestjs/common';import {Pool} from 'pg';export const provider={provide:'DB',useFactory:()=>new Pool()${scope}};`,
    'app.module.ts':nestModule,
  },r=>assert.equal(byId(r,'per-request-client').length,0));
  await audit({
    'service.ts':"import {Injectable} from '@nestjs/common';import {Pool} from 'pg';@Injectable() export class Service{constructor(){this.pool=new Pool();}}",
    'provider.ts':"import {Service} from './service.js';export const provider={provide:Service,useFactory:()=>new Service()};",
    'app.module.ts':nestModule,
  },r=>assert.equal(byId(r,'per-request-client').length,0));
});

test('request scope propagates through cross-file constructor dependencies and injection tokens',async()=>{
  await audit({
    'context.ts':"import {Injectable,Scope} from '@nestjs/common';@Injectable({scope:Scope.REQUEST})export class Context{}",
    'service.ts':"import {Injectable} from '@nestjs/common';import {Pool} from 'pg';import {Context} from './context.js';@Injectable()export class Service{constructor(private context:Context){this.pool=new Pool();}}",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
  await audit({
    'context.ts':"import {Injectable,Scope} from '@nestjs/common';@Injectable({scope:Scope.REQUEST})export class Context{}",
    'provider.ts':"import {Pool} from 'pg';export const provider={provide:'DB',inject:['CTX'],useFactory:(ctx)=>new Pool()};",
    'app.module.ts':"import {Module}from '@nestjs/common';import {Context}from './context.js';import {provider}from './provider.js';@Module({providers:[{provide:'CTX',useClass:Context},provider]})export class AppModule{}",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
});

test('transient scopes are per-consumer and become per-request only for request consumers',async()=>{
  const service="import {Injectable,Scope}from '@nestjs/common';import {Pool}from 'pg';@Injectable({scope:Scope.TRANSIENT})export class Service{constructor(){this.pool=new Pool();}}";
  await audit({'service.ts':service},r=>{
    assert.equal(byId(r,'per-request-client').length,0);
    assert.equal(byId(r,'transient-client-lifetime')[0].severity,'info');
  });
  await audit({
    'service.ts':service,
    'controller.ts':"import {Controller,Scope}from '@nestjs/common';import {Service}from './service.js';@Controller({scope:Scope.REQUEST})export class ControllerClass{constructor(private service:Service){}}",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
});

test('manual construction overrides DI singleton metadata; ordinary methods are still checked',async()=>{
  await audit({
    'service.ts':"import {Injectable}from '@nestjs/common';import {Pool}from 'pg';@Injectable()export class Service{constructor(){this.pool=new Pool();}}",
    'route.ts':"import {Service}from './service.js';export function GET(req,res){return new Service();}",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
  await audit({
    'service.ts':"import {Injectable}from '@nestjs/common';import {Pool}from 'pg';@Injectable()export class Service{work(){return new Pool();}}",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
});

test('explicit exports override stars and unresolved DI metadata never proves singleton lifetime',async()=>{
  await audit({
    'barrel.ts':"export * from 'pg'; export {Pool} from './custom.js';",
    'custom.ts':"export class Pool{}",
    'route.ts':"import {Pool}from './barrel.js';export function GET(req,res){return new Pool();}",
  },r=>assert.equal(byId(r,'per-request-client').length,0));
  for(const options of ['scopeOptions','{scope:Scope.DEFAULT,...scopeOptions}']) await audit({
    'service.ts':`import {Injectable,Scope}from '@nestjs/common';import {Pool}from 'pg';@Injectable(${options})export class Service{constructor(){this.pool=new Pool();}}`,
  },r=>{
    assert.equal(byId(r,'per-request-client').length,0);
    assert.equal(byId(r,'unknown-provider-lifetime')[0].severity,'info');
  });
});

test('scope overrides on registered factories and direct REQUEST token injection are honored',async()=>{
  await audit({
    'provider.ts':"import {Pool}from 'pg';import {Scope}from '@nestjs/common';export const provider={provide:'DB',scope:Scope.REQUEST,useFactory:()=>new Pool()};",
    'app.module.ts':nestModule,
  },r=>assert.equal(byId(r,'per-request-client').length,1));
  await audit({
    'provider.ts':"import {Pool}from 'pg';import {REQUEST}from '@nestjs/core';export const provider={provide:'DB',inject:[REQUEST],useFactory:(req)=>new Pool()};",
    'app.module.ts':nestModule,
  },r=>assert.equal(byId(r,'per-request-client').length,1));
});

test('CommonJS barrels, named exports and direct class exports preserve identities',async()=>{
  await audit({
    'db.cjs':"exports.DatabasePool=require('pg').Pool;",
    'barrel.cjs':"module.exports=require('./db.cjs');",
    'route.cjs':"const {DatabasePool}=require('./barrel.cjs');exports.GET=function(req,res){return new DatabasePool();};",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
  await audit({
    'service.cjs':"const {Pool}=require('pg'); class Service{constructor(){this.pool=new Pool();}} module.exports=Service;",
    'route.cjs':"const Service=require('./service.cjs');exports.GET=function(req,res){return new Service();};",
  },r=>assert.equal(byId(r,'per-request-client').length,1));
  await audit({
    'http.cjs':"const axios=require('axios');const api=axios.create({});module.exports={api};",
    'route.cjs':"const {api}=require('./http.cjs');exports.GET=function(req,res){return api.get('url');};",
  },r=>assert.equal(byId(r,'outbound-no-timeout').length,1));
});

test('unresolved factory scope is informational, rather than proof of singleton reuse',async()=>{
  await audit({
    'provider.ts':"import {Pool}from 'pg';export const provider={provide:'DB',...scopeOptions,useFactory:()=>new Pool()};",
    'app.module.ts':nestModule,
  },r=>assert.equal(byId(r,'unknown-provider-lifetime')[0].severity,'info'));
});
