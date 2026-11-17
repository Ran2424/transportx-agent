import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import jsonPatch from 'fast-json-patch';
import * as helper from './harness/workspace-client.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = process.argv[3] ? path.resolve(process.argv[3]) : os.tmpdir();
fs.mkdirSync(evidenceRoot, { recursive: true });
const state = fs.mkdtempSync(path.join(evidenceRoot, 'resilience-agent-'));
const networkSnapshot = process.argv[2] ? fs.readFileSync(path.resolve(process.argv[2])) : Buffer.from(JSON.stringify({ elements: [
  { type: 'node', id: 1, lat: 31.17, lon: 121.41 },
  { type: 'node', id: 2, lat: 31.17, lon: 121.42 },
  { type: 'way', id: 3, nodes: [1, 2], tags: { highway: 'residential' } },
] }));
const moduleId = 'com.transportx.service-resilience';
const hash = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const report = { startedAt: new Date().toISOString(), provider: 'Scripted localhost tool calls on real Pi and Agent Host.',
  provenance: process.argv[2] ? 'Road geometry supplied by the test operator. Exercise, demand and survey are synthetic.' : 'Synthetic geometry, exercise, demand and survey.',
  checks: {}, trace: [] };
assert.ok(fs.statSync(path.join(repo, 'dist/module-extensions/capabilities/service-resilience/extensions/pi-service-resilience/index.ts')).size > 1000, 'Built capability bundle must exist');
let child, base, runtime, startup = '';
const fixture = http.createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const text = body.messages.findLast(m => m.role === 'user').content;
    const user = typeof text === 'string' ? text : text.map(p => p.text).join('');
    const intended = JSON.parse(user.replace(/^resilience-test:/, ''));
    const last = body.messages.at(-1);
    const previous = body.messages.findLast(m => m.tool_calls)?.tool_calls[0]?.function.name;
    const available = (body.tools || []).map(({ function: spec }) => spec.name);
    let call;
    if (last.role === 'user' || (last.role === 'tool' && previous === 'manage_capabilities')) {
      if (available.includes(intended.name)) call = intended;
      else if (last.role === 'user') call = { name: 'manage_capabilities', args: { action: 'enable', moduleId: intended.name === 'publish_geodata' ? 'com.transportx.geo' : moduleId } };
    }
    report.trace.push({ intended: intended.name, dispatched: call?.name ?? null, available });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({id:'resilience-fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta,finish_reason}]}) + '\n\n');
    if (call) send({ role: 'assistant', tool_calls: [{index:0,id:'call_' + report.trace.length,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}] });
    else send({ role: 'assistant', content: '工具调用完成。' });
    send({}, call ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
  } catch (error) { report.trace.push({error:String(error)}); response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(state, 'models.json'), JSON.stringify({providers:{probe:{baseUrl:`http://127.0.0.1:${fixture.address().port}/v1`,api:'openai-completions',apiKey:'fixture',models:[{id:'probe',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
const log = fs.openSync(path.join(state,'host.log'),'a'), errors = fs.openSync(path.join(state,'host.err.log'),'a');
const until = async (test, label, timeout=60000) => {
  const end=Date.now()+timeout;
  while(Date.now()<end) { const result=await test(); if(result) return result; assert.equal(child.exitCode,null,`Host stopped during ${label}`); await delay(200); }
  throw new Error('Timed out: '+label);
};
async function json(url, data) {
  const response=await fetch(base+url,{headers:{...helper.protocolHeaders,'Content-Type':'application/json'},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});
  const result=await response.json(); assert.ok(response.ok,JSON.stringify(result)); return result;
}
const rpc = data => json('/api/rpc',data);
const results = snapshot => snapshot.entries.map(entry=>entry.message).filter(m=>m?.role==='toolResult');
async function call(name,args,expectedError=false) {
  const before=results(await helper.nativeSnapshot(json,runtime.conversationId)).length;
  const ack=await rpc({type:'prompt',sessionId:runtime.id,clientCommandId:randomUUID(),message:'resilience-test:'+JSON.stringify({name,args})});
  assert.equal(ack.success,true,JSON.stringify(ack));
  const result=await until(async()=>{const s=await helper.nativeSnapshot(json,runtime.conversationId);return !s.isStreaming&&results(s).slice(before).findLast(m=>m.toolName===name)},name);
  assert.equal(result.isError,expectedError,JSON.stringify(result));
  return result.details;
}
const artifact = file => { const bytes=fs.readFileSync(path.join(runtime.cwd,file.path)); assert.equal(hash(bytes),file.sha256); return bytes; };
try {
  child = spawn(process.execPath, ['bin/tau.js', '--desktop', '--parent-pid', String(process.pid)], {
    cwd: repo, stdio: ['ignore', 'pipe', errors, 'ipc'], windowsHide: true,
    env: {
      ...process.env, PI_OFFLINE: '1', PYTHONUTF8: '1', TAU_USER_DATA_DIR: state, PI_CODING_AGENT_DIR: state,
      TAU_PROJECTS_DIR: path.join(state, 'projects'), PI_CODING_AGENT_SESSION_DIR: path.join(state, 'sessions'),
      TAU_PI_ENTRYPOINT: path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    },
  });
  child.stdout.on('data',chunk=>{startup+=chunk;fs.writeSync(log,chunk)});
  const ready=await until(()=>startup.split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).find(m=>m?.type==='transportx-agent-host-ready'),'host startup');
  base=`http://127.0.0.1:${ready.port}`; await until(async()=> (await json('/api/health')).dataState==='ready','host inventory');
  const options=await json('/api/platform/session-options');
  const capability=options.modules.find(m=>m.id===moduleId); assert.ok(capability,'Official builtin capability missing');
  const selected=options.modules.filter(m=>m.selectedByDefault||m.id===moduleId).map(({id,version})=>({id,version}));
  runtime=await helper.createHostConversation(json,{name:'Service resilience agent smoke',model:'probe/probe',profile:{...helper.smokeProfile,modules:{selectionMode:'explicit',selected}}});
  report.checks.module={id:capability.id,version:capability.version,selected:true};
  fs.writeFileSync(path.join(runtime.cwd, 'roads.json'), networkSnapshot);
  fs.writeFileSync(path.join(runtime.cwd,'survey.csv'),'id,object,period,value,source\no1,east-bridge,peak,passable,synthetic exercise\no2,missing-object,peak,unknown,synthetic exercise\n');
  fs.writeFileSync(path.join(runtime.cwd,'malformed.csv'),'id,object,period,value,source\no1,east-bridge,peak\n');
  const net=await call('resilience_import',{kind:'osm-overpass',sourcePath:'roads.json',mode:'road',speedKph:30});
  assert.ok(net.nodes >= 2 && net.edges >= 1);
  if (!process.argv[2]) assert.deepEqual([net.nodes, net.edges], [2, 2]);
  artifact(net);
  assert.equal(net.source.sha256, hash(networkSnapshot));
  report.checks.network = net;
  assert.ok(report.trace.some(t=>t.intended==='resilience_import'&&t.dispatched==='manage_capabilities'),'Must lazily enable module');
  const imported=JSON.parse(artifact(net)); const edge=imported.edges[0];
  const osmCase={title:'Synthetic demand on imported OSM road geometry',provenance:{kind:'exercise',note:'Demand, service capacity and power disruption are synthetic; road geometry is OSM and 30 km/h is assumed.'},networkPath:net.path,
    services:[{id:'osm-care',node:edge.to,kind:'medical',capacity:5,requires:['osm-power']},{id:'origin-care',node:edge.from,kind:'medical',capacity:0,requires:[]}],
    demands:[{id:'osm-demand',node:edge.from,kind:'medical',mode:'road',amount:10,priority:true,maxMinutes:Math.min(1440,edge.minutes+0.000001)}],
    periods:[{id:'peak',label:'Synthetic peak',weight:1}],states:[{id:'ready',label:'Power available',periods:{}},{id:'outage',label:'Power unavailable',periods:{peak:{unavailableResources:['osm-power']}}}],
    plans:[{id:'none',label:'No temporary capacity',periods:{}},{id:'temporary',label:'Temporary capacity',periods:{peak:{serviceCapacity:{'origin-care':4}}}}],investigations:[],decisionWindowMinutes:30};
  fs.writeFileSync(path.join(runtime.cwd,'osm-exercise.json'),JSON.stringify(osmCase,null,2));
  const osmPressure=await call('resilience_pressure_test',{casePath:'osm-exercise.json',stateId:'ready',planId:'none',periodId:'peak'});
  assert.equal(osmPressure.provenance.kind,'exercise');
  assert.ok(osmPressure.inputs.some(i=>i.role==='network'&&i.path===net.path&&i.sha256===net.sha256));
  const osmTotals=Object.fromEntries(osmPressure.scenarioTotals.map(s=>[s.stateId+'/'+s.planId,s.shortage]));
  assert.deepEqual(osmTotals,{'outage/none':10,'outage/temporary':6,'ready/none':5,'ready/temporary':1});
  const osmPressureData=JSON.parse(artifact(osmPressure.files.pressure));
  assert.equal(osmPressureData.scenarios.find(s=>s.stateId==='ready'&&s.planId==='none').periods[0].cohorts[0].reachable,10);
  assert.equal(osmPressureData.scenarios.find(s=>s.stateId==='outage'&&s.planId==='none').periods[0].cohorts[0].capacityUnmet,10);
  report.checks.osmPressure={edge,network:net.path,networkSha256:net.sha256,casePath:'osm-exercise.json',inputs:osmPressure.inputs,provenance:osmPressure.provenance,scenarioShortages:osmTotals,pressureSha256:osmPressure.files.pressure.sha256};
  fs.writeFileSync(path.join(runtime.cwd,'osm-plans.json'),'{}');
  const osmComparison=await call('resilience_compare_plans',{casePath:'osm-exercise.json',planPath:'osm-plans.json',stateId:'ready',planId:'none',periodId:'peak'});
  const osmRoutes=await call('resilience_accessibility',{casePath:osmComparison.files.case.path,caseSha256:osmComparison.files.case.sha256,stateId:'ready',planId:'none',periodId:'peak'});
  assert.match(artifact(osmComparison.files.report).toString('utf8'),/OpenStreetMap contributors/);
  assert.ok(JSON.parse(artifact(osmRoutes.map)).notes.some(note=>note.includes('OpenStreetMap contributors')));
  report.checks.osmPressure.derivedAttributionPreserved=true;
  const obs=await call('resilience_import',{kind:'field-survey',sourcePath:'survey.csv',columns:{observationId:'id',objectId:'object',periodId:'period',value:'value',source:'source'}}); assert.equal(obs.observations,2);artifact(obs);report.checks.survey=obs;
  const align=await call('resilience_align',{observationPath:obs.path}); assert.equal(align.coverage.matched,1);assert.equal(align.coverage.unknown,1);artifact(align);report.checks.alignment=align;
  const pressure=await call('resilience_pressure_test',{stateId:'bridge-and-power-ready',planId:'shuttle',periodId:'peak'}); assert.deepEqual(pressure.view,{stateId:'bridge-and-power-ready',planId:'shuttle',periodId:'peak'});for(const f of Object.values(pressure.files))artifact(f);report.checks.pressure=pressure;
  const inv=await call('resilience_investigate',{}); const invFull=read(path.join(runtime.cwd,inv.files.investigation.path)); assert.ok(invFull.beforeObservation.eligiblePlanIds.length); assert.ok(invFull.investigations.every(i=>typeof i.decision==='string')); report.checks.investigation={decision:inv.decision,investigations:inv.investigations,sha256:inv.files.investigation.sha256};
  const sweep=await call('resilience_investigate',{sweep:{stateId:'bridge-and-power-ready',periodId:'peak',objectId:'east-care',variable:'service-capacity',values:[0,30,60,90,120,140,180]}}); const scan=JSON.parse(artifact(sweep)); assert.equal(scan.points.length,7);assert.ok(scan.brackets.length>0,'Expected a best-plan change');report.checks.sensitivity={path:sweep.path,sha256:sweep.sha256,brackets:scan.brackets,points:scan.points};
  // Separate synthetic fixture: a physical closure must defeat a plan's capacity override,
  // and either service can independently cover demand before their joint outage.
  const caseData={title:'Two service co-failure exercise',provenance:{kind:'exercise',note:'Synthetic network, service availability and event evidence.'},
    nodes:[{id:'origin',coordinates:[121.41,31.17]},{id:'destination',coordinates:[121.42,31.17]}],
    edges:[{id:'road',from:'origin',to:'destination',minutes:1,modes:['road'],requires:[]}],
    services:[{id:'s1',node:'destination',kind:'care',capacity:10,requires:['r1']},{id:'s2',node:'destination',kind:'care',capacity:10,requires:['r2']}],
    demands:[{id:'d',node:'origin',kind:'care',mode:'road',amount:10,priority:true,maxMinutes:5}],
    periods:[{id:'p',label:'Peak',weight:1}],states:[{id:'ready',label:'Available',periods:{}},{id:'observed',label:'Confirmed closure',periods:{}}],
    plans:[{id:'p1',label:'Increase first service',periods:{p:{serviceCapacity:{s1:20}}}},
      {id:'p2',label:'Limit second service',periods:{p:{serviceCapacity:{s2:5}}}},
      {id:'late',label:'Late option',setupMinutes:11,periods:{p:{serviceCapacity:{s2:20}}}}],
    investigations:[{id:'condition',question:'Is the service closed?',source:'Site status',effort:'One check',leadMinutes:1,outcomes:[{label:'Available',stateIds:['ready']},{label:'Closed',stateIds:['observed']}]}],decisionWindowMinutes:10};
  const plansData={plans:caseData.plans};
  const calendarData={periods:[{id:'p',start:'2026-11-17T08:00:00+08:00',end:'2026-11-17T10:00:00+08:00'}]};
  const event=(eventId,objectId,start,end,geometry)=>({type:'Feature',geometry,properties:{eventId,...(objectId?{objectId}:{}),start,end,source:'synthetic inspection',status:'confirmed',action:'close-service'}});
  const eventsData={type:'FeatureCollection',features:[
    event('full','s1','2026-11-17T08:00:00+08:00','2026-11-17T10:00:00+08:00',null),
    event('partial','s2','2026-11-17T09:00:00+08:00','2026-11-17T10:00:00+08:00',null),
    event('ambiguous',null,'2026-11-17T08:00:00+08:00','2026-11-17T10:00:00+08:00',{type:'Point',coordinates:[121.42,31.17]}),
    event('conflict','s1','2026-11-17T08:00:00+08:00','2026-11-17T10:00:00+08:00',{type:'Point',coordinates:[0,0]})]};
  for(const [file,value] of Object.entries({'joint-case.json':caseData,'joint-plans.json':plansData,'joint-calendar.json':calendarData,'joint-events.json':eventsData})) fs.writeFileSync(path.join(runtime.cwd,file),JSON.stringify(value,null,2));
  const originalHashes=Object.fromEntries(['joint-case.json','joint-plans.json','joint-calendar.json','joint-events.json'].map(file=>[file,hash(fs.readFileSync(path.join(runtime.cwd,file)))]));
  const eventAlignment=await call('resilience_align_events',{casePath:'joint-case.json',eventPath:'joint-events.json',calendarPath:'joint-calendar.json',toleranceMeters:0});
  const eventEvidence=JSON.parse(artifact(eventAlignment));
  assert.deepEqual(eventAlignment.confirmedChanges,[{eventId:'full',objectId:'s1',periodId:'p',action:'close-service'}]);
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='partial').status,'pending');
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='partial').timeStatus,'partial');
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='ambiguous').ambiguous,true);
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='ambiguous').status,'pending');
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='conflict').geometryConflict,true);
  assert.equal(eventEvidence.rows.find(row=>row.eventId==='conflict').status,'pending');
  const comparisonArgs={casePath:'joint-case.json',planPath:'joint-plans.json',alignment:{path:eventAlignment.path,sha256:eventAlignment.sha256,stateId:'observed',eventIds:['full']},stateId:'observed',planId:'p1',periodId:'p'};
  await call('resilience_compare_plans',{...comparisonArgs,alignment:{...comparisonArgs.alignment,sha256:'0'.repeat(64)}},true);
  for(const eventId of ['partial','ambiguous']) await call('resilience_compare_plans',{...comparisonArgs,alignment:{...comparisonArgs.alignment,eventIds:[eventId]}},true);
  const comparison=await call('resilience_compare_plans',comparisonArgs);
  const derived=JSON.parse(artifact(comparison.files.case));
  assert.deepEqual(comparison.appliedEventIds,['full']);
  const definition=JSON.parse(artifact(comparison.definition));
  const patchBase=JSON.parse(artifact(definition.base)), patchDerived=JSON.parse(artifact(definition.derived));
  const replayed=jsonPatch.applyPatch(structuredClone(patchBase),definition.patch,true).newDocument;
  assert.deepEqual(replayed,patchDerived); assert.deepEqual(patchDerived,derived);
  assert.deepEqual(derived.states.find(s=>s.id==='observed').periods.p.closedServices,['s1']);
  assert.deepEqual(derived.states.find(s=>s.id==='ready').periods,{});
  const totals=Object.fromEntries(comparison.scenarioTotals.map(s=>[s.stateId+'/'+s.planId,s.shortage]));
  assert.equal(totals['ready/p2'],0); assert.equal(totals['observed/p2'],5);
  const pressureDetail=JSON.parse(artifact(comparison.files.pressure));
  assert.equal(pressureDetail.scenarios.find(s=>s.stateId==='observed'&&s.planId==='p1').periods[0].cohorts[0].reachableServiceIds.includes('s1'),false);
  const repeat=await call('resilience_compare_plans',comparisonArgs);
  assert.equal(repeat.files.case.sha256,comparison.files.case.sha256); assert.equal(repeat.files.pressure.sha256,comparison.files.pressure.sha256);assert.equal(repeat.definition.sha256,comparison.definition.sha256);
  const accessArgs={casePath:comparison.files.case.path,caseSha256:comparison.files.case.sha256,periodId:'p',stateId:'observed',planId:'p1',demandId:'d'};
  await call('resilience_accessibility',{...accessArgs,caseSha256:'f'.repeat(64)},true);
  const accessibility=await call('resilience_accessibility',accessArgs);
  const accessData=JSON.parse(artifact(accessibility)); const accessMap=JSON.parse(artifact(accessibility.map));
  assert.equal(accessData.rows[0].baseline.nearest.serviceId,'s1');assert.equal(accessData.rows[0].selected.nearest.serviceId,'s2');
  assert.equal(accessData.rows[0].selected.status,'within-threshold');assert.equal(accessMap.features[0].properties.service_id,'s2');
  const joint=await call('resilience_sensitivity',{casePath:comparison.files.case.path,caseSha256:comparison.files.case.sha256,stateId:'ready',periodId:'p',axes:[{variable:'unavailable-resource',objectId:'r1',values:[false,true]},{variable:'unavailable-resource',objectId:'r2',values:[false,true]}],constraints:{maxTotalShortage:0}});
  const jointData=JSON.parse(artifact(joint));
  assert.equal(joint.pointCount,4);assert.ok(jointData.interactions.some(i=>i.jointBreach));
  assert.ok(jointData.points.every(point=>point.plans.find(plan=>plan.planId==='late').feasible===false));
  const limit=await call('resilience_sensitivity',{casePath:comparison.files.case.path,stateId:'observed',periodId:'p',axes:[{variable:'demand-amount',objectId:'d',values:[6,8]}],constraints:{maxTotalShortage:2}});
  const limitData=JSON.parse(artifact(limit));
  assert.deepEqual(limitData.points.map(point=>point.bestPlanIds),[['p1'],['p1']]);
  assert.ok(limitData.transitions.some(t=>t.changedPlanLimits.some(p=>p.planId==='p2'&&p.from&&!p.to)));
  const derivedInvestigation=await call('resilience_investigate',{casePath:comparison.files.case.path});artifact(derivedInvestigation.files.investigation);
  for(const [file,sha256] of Object.entries(originalHashes)) assert.equal(hash(fs.readFileSync(path.join(runtime.cwd,file))),sha256,`${file} changed`);
  report.checks.connectedWorkflow={alignment:{path:eventAlignment.path,sha256:eventAlignment.sha256,summary:eventAlignment.summary},comparison:{case:comparison.files.case,definition:comparison.definition,appliedEventIds:comparison.appliedEventIds,patchReplayed:true,scenarioShortages:totals},accessibility:{path:accessibility.path,sha256:accessibility.sha256,map:accessibility.map},joint:{path:joint.path,sha256:joint.sha256,pointCount:joint.pointCount,interactions:jointData.interactions},investigation:derivedInvestigation.files.investigation,inputHashes:originalHashes,hashMismatchRejected:true,repeatStable:true};
  const published=await call('publish_geodata',{path:pressure.files.map.path,title:'Service resilience pressure map'}); report.checks.published={mapSha256:pressure.files.map.sha256,result:published};
  const visualizationId='service_resilience_smoke', resourceId=published.resource.resourceId;
  const created=await call('present_visualization',{command:'create_map',visualizationId,title:'Service resilience pressure',resourceId,sourceId:'pressure',layerId:'roads',layerType:'line'});
  const added=await call('present_visualization',{command:'add_layer',visualizationId,sourceId:'pressure',layerId:'services',layerType:'circle'});
  const shown=await call('present_visualization',{command:'show_map',visualizationId});
  assert.equal(created.visualization.operation,'replace');assert.equal(added.visualization.scene.layers.length,2);assert.equal(shown.visualization.operation,'focus');assert.equal(shown.visualization.revision,added.visualization.revision);assert.ok(shown.canvas);
  report.checks.canvas={create:created.visualization,add:added.visualization,show:shown.visualization,canvas:shown.canvas};
  const routePublished=await call('publish_geodata',{path:accessibility.map.path,title:'Derived service accessibility route'});
  const routeCanvas=await call('present_visualization',{command:'create_map',visualizationId:'service_resilience_route_smoke',title:'Derived accessibility',resourceId:routePublished.resource.resourceId,sourceId:'route',layerId:'route',layerType:'line'});
  const routeShown=await call('present_visualization',{command:'show_map',visualizationId:'service_resilience_route_smoke'});
  assert.equal(routeCanvas.visualization.operation,'replace');assert.equal(routeShown.visualization.operation,'focus');assert.ok(routeShown.canvas);
  report.checks.connectedWorkflow.routeCanvas={mapSha256:accessibility.map.sha256,published:routePublished,shown:routeShown.visualization};
  const before=fs.readdirSync(runtime.cwd).sort(); await call('resilience_import',{kind:'field-survey',sourcePath:'malformed.csv',columns:{observationId:'id',objectId:'object',periodId:'period',value:'value',source:'source'}},true);await call('resilience_import',{kind:'osm-overpass',sourcePath:'../escape.json',mode:'road',speedKph:30},true);assert.deepEqual(fs.readdirSync(runtime.cwd).sort(),before);report.checks.invalid={malformedRejected:true,pathEscapeRejected:true,workspaceUnchanged:true};
  await helper.closeHostConversation(json,runtime.conversationId); report.status='pass';
} catch(error) { report.status='fail';report.error=String(error.stack||error);process.exitCode=1; }
finally {
  if(child&&child.exitCode===null) {if(child.connected)child.send({type:'transportx-agent-host-stop'});for(let i=0;i<100&&child.exitCode===null;i++)await delay(100);if(child.exitCode===null){child.kill();report.shutdown='forced';process.exitCode=1}else report.shutdown=child.exitCode;}
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(state,'evidence.json'),JSON.stringify(report,null,2)+'\n');console.log(path.join(state,'evidence.json'));
}
