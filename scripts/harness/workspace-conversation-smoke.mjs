#!/usr/bin/env node
// Isolated real Host + fake Pi + Chrome verification of the durable conversation API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(path.join(process.cwd(),'package.json'));
const {chromium}=require('playwright');
const {WebSocket}=require('ws');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tau-new-api-smoke-'));
const scenario=path.join(root,'events.json');fs.writeFileSync(scenario,JSON.stringify({fallback:{steps:[{delay:5000},{streamText:{text:'新会话完成',chunks:1}}]}}));
const host=spawn(process.execPath,['scripts/harness/serve-with-fake-pi.mjs','--scenario',scenario],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
let log='',errors='',browser;
host.stdout.on('data',b=>log+=b);host.stderr.on('data',b=>errors+=b);
try {
  const started=Date.now();while(!log.includes('TAU_FAKE_READY ')){if(host.exitCode!==null||Date.now()-started>15000)throw Error(log+errors);await new Promise(r=>setTimeout(r,50));}
  const ready=JSON.parse(log.match(/TAU_FAKE_READY (\{[^\n]+\})/)[1]);const base=ready.baseUrl;
  const req=async(url,body,method=body===undefined?'GET':'POST',protocol=true)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(protocol?{'X-TransportX-Protocol':'2'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});let data;try{data=await response.json();}catch{}return {status:response.status,data};};
  let health=await req('/api/health');assert.equal(health.data.protocolVersion,2);assert.equal(health.data.dataState,'ready');
  assert.equal((await req('/api/live-sessions',{},'POST',false)).status,426);assert.equal((await req('/api/live-sessions',{})).status,404);
  const profile={schemaVersion:1,task:{kind:'data-query',expectedOutputs:['answer']},modules:{selectionMode:'explicit',selected:[]}};
  const input={requestId:crypto.randomUUID(),workspace:{kind:'new',name:'整改冒烟工作区',parentDirectory:ready.projectsDir},name:'会话 A',model:'kimi-coding/k2p7',domainId:'com.transportx.workbench',profile};
  const created=await req('/api/conversations',input);assert.equal(created.status,200,JSON.stringify(created));const a=created.data.conversation.id,ws=created.data.manifest.id;
  assert.equal((await req('/api/conversations',input)).data.conversation.id,a);
  assert.equal((await req('/api/health')).data.liveSessionCount,0);
  assert.equal((await req(`/api/conversations/${a}/snapshot`)).data.runtime,null);
  const existing={requestId:crypto.randomUUID(),workspace:{kind:'existing',workspaceId:ws,expectedRevision:created.data.manifest.revision,defaultsRevision:created.data.manifest.defaultsRevision},name:'会话 B'};
  assert.equal((await req('/api/conversations',{...existing,requestId:crypto.randomUUID(),workspace:{...existing.workspace,expectedRevision:999}})).status,409);
  const second=await req('/api/conversations',existing);assert.equal(second.status,200,JSON.stringify(second));const b=second.data.conversation.id;assert.equal(second.data.directory,created.data.directory);
  assert.equal((await req('/api/conversations',input)).data.conversation.id,a,'dedup precedes revisions');
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({locale:'zh-CN',viewport:{width:1280,height:900}});const uiErrors=[];page.on('pageerror',e=>uiErrors.push(String(e)));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('.workspace-group-heading').filter({hasText:'整改冒烟工作区'}).waitFor();
  await page.locator('.session-row').filter({hasText:'会话 A'}).click();await page.getByRole('button',{name:'激活此会话',exact:true}).waitFor();assert.equal((await req('/api/health')).data.liveSessionCount,0,'history browsing never spawns Pi');
  await page.getByRole('button',{name:'激活此会话',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.conversation-offline-bar'));
  const activeA=(await req(`/api/conversations/${a}/snapshot`)).data.runtime.id;
  assert.equal((await req(`/api/conversations/${a}/close`,{filePath:'old-session.jsonl'})).status,400,'legacy path input is rejected even with a current protocol header');
  const composer=page.getByLabel('消息输入');await composer.fill('工作区会话测试');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.waitForTimeout(100);
  await page.locator('.session-row').filter({hasText:'会话 B'}).click();await page.getByRole('button',{name:'激活此会话',exact:true}).waitFor();
  const occupied=await req(`/api/conversations/${b}/activate`,{});assert.equal(occupied.status,409,JSON.stringify(occupied));assert.equal(occupied.data.code,'workspace_busy');assert.equal((await req(`/api/conversations/${a}/snapshot`)).data.runtime.id,activeA);
  assert.equal((await req(`/api/conversations/${a}/close`,{stopCurrent:true})).status,200);
  await page.getByRole('button',{name:'激活此会话',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.conversation-offline-bar'));
  const activeB=(await req(`/api/conversations/${b}/snapshot`)).data.runtime.id;assert.notEqual(activeB,activeA);
  assert.equal((await req(`/api/conversations/${b}/close`,{stopCurrent:true})).status,200);assert.equal((await req('/api/health')).data.liveSessionCount,0);
  await page.reload({waitUntil:'networkidle'});await page.locator('.session-row').filter({hasText:'会话 A'}).click();await page.getByRole('button',{name:'激活此会话',exact:true}).waitFor();assert.equal((await req('/api/health')).data.liveSessionCount,0);
  const independent=await req('/api/conversations',{...input,requestId:crypto.randomUUID(),workspace:{kind:'new',name:'独立运行工作区'},name:'会话 C'});
  const c=independent.data.conversation.id;assert.equal((await req(`/api/conversations/${c}/activate`,{})).status,200);
  await page.locator('.session-row').filter({hasText:'会话 A'}).click();await page.reload({waitUntil:'networkidle'});
  await page.locator('.session-row.is-active').filter({hasText:'会话 A'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('tau-active-conversation-id')),a,'a newer running conversation cannot replace the saved selection before inventory arrives');
  assert.equal((await req('/api/health')).data.liveSessionCount,1,'restoring the offline A view does not activate it or stop C');
  fs.writeFileSync(path.join(created.data.directory,'shared.txt'),'shared result');assert.equal((await req(`/api/conversations/${a}/files/content?path=shared.txt`)).status,200);assert.equal((await req(`/api/conversations/${a}/files/content?path=.tau/workspace.json`)).status,403);
  fs.mkdirSync('.plans/workspace-conversations',{recursive:true});await page.screenshot({path:'.plans/workspace-conversations/new-api-smoke.png',fullPage:true});
  const index=(await req('/api/workspaces')).data;const workspace=index.workspaces.find(v=>v.id===ws);
  const deletion=await req(`/api/conversations/${b}`,{requestId:crypto.randomUUID(),expectedRevision:workspace.revision,confirm:true},'DELETE');assert.equal(deletion.status,200,JSON.stringify(deletion));
  assert.equal(fs.readFileSync(path.join(created.data.directory,'shared.txt'),'utf8'),'shared result');
  const fresh=(await req(`/api/workspaces/${ws}`)).data;const allDeletion=await req(`/api/workspaces/${ws}/delete`,{requestId:crypto.randomUUID(),expectedRevision:fresh.revision,confirm:true});assert.equal(allDeletion.status,200,JSON.stringify(allDeletion));
  assert.equal(fs.existsSync(created.data.directory),false);assert.deepEqual(uiErrors,[]);
  const socket=new WebSocket(base.replace('http','ws')+'/ws');const closed=new Promise(resolve=>socket.once('close',code=>resolve(code)));await new Promise(resolve=>socket.once('open',resolve));socket.send(JSON.stringify({type:'hello',protocolVersion:1}));assert.equal(await closed,4006);
  console.log('PASS: protocol fail-safe, durable creation/dedup, dual revisions, history-only browser open, explicit activation, busy refusal, stable identity, close/reload, scoped files and staged deletion');
} catch(e){console.error(log.slice(-10000));console.error(errors.slice(-10000));throw e;}
finally{await browser?.close();host.kill('SIGTERM');await new Promise(r=>host.exitCode!==null?r():host.once('exit',r));fs.rmSync(root,{recursive:true,force:true});}
