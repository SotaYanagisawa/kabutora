import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const web=path.join(root,'apps/web');
const directory=mkdtempSync(path.join(tmpdir(),'kabutora-market-runtime-'));chmodSync(directory,0o700);
const wrangler=path.join(web,'node_modules/wrangler/bin/wrangler.js');
const config=path.join(directory,'wrangler.json');
const stress=process.env.KABUTORA_RUNTIME_STRESS==='1';
const port=Number(process.env.KABUTORA_RUNTIME_TEST_PORT ?? 8791),origin=`http://127.0.0.1:${port}`;
const env={...process.env,WRANGLER_LOG_PATH:path.join(directory,'wrangler.log'),WRANGLER_SEND_METRICS:'false'};
writeFileSync(config,JSON.stringify({name:'kabutora',main:path.join(web,'runtime-tests/market-worker.ts'),compatibility_date:'2026-08-08',compatibility_flags:['nodejs_compat'],durable_objects:{bindings:[{name:'MARKET_COORDINATOR',class_name:'MarketCoordinator'}]},migrations:[{tag:'market-coordinator-v2',new_sqlite_classes:['MarketCoordinator']}],d1_databases:[{binding:'MARKET_DB',database_name:'kabutora-market',database_id:'11d6ba0e-2f8d-4506-98ee-92792185ddc8',migrations_dir:path.join(web,'migrations')}]}));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=path.join(directory,'state');
let server,output='';
const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[wrangler,...args],{cwd:web,env,stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr]) stream.on('data',data=>logs=(logs+data).slice(-10000));child.on('error',reject);child.on('exit',code=>code===0 ? resolve() : reject(new Error(logs)));});
const fetchLocal=(url,init)=>fetch(origin+url,{...init,signal:AbortSignal.timeout(5000)});
try {
 await run(['d1','migrations','apply','kabutora-market','--local','--config',config,'--persist-to',state]);
 server=spawn(process.execPath,[wrangler,'dev','--local','--ip','127.0.0.1','--port',String(port),'--config',config,'--persist-to',state],{cwd:web,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [server.stdout,server.stderr]) stream.on('data',data=>output=(output+data).slice(-12000));
 const deadline=Date.now()+30000;
 while(true) {
  if(server.exitCode!==null) throw new Error(output);
  try {if((await fetchLocal('/__health')).ok) break;} catch {}
  if(Date.now()>deadline) throw new Error('runtime_start_timeout\n'+output);
  await wait(150);
 }
 assert.equal((await fetchLocal('/data?resource=quotes')).status,503);
 if(stress) {
  for(let offset=0;offset<200;offset+=10) assert.equal((await fetchLocal(`/__seedmax?offset=${offset}`,{method:'POST'})).status,204);
  for(let offset=0;offset<1500;offset+=100) assert.equal((await fetchLocal(`/__seedframes?offset=${offset}`,{method:'POST'})).status,204);
 } else assert.equal((await fetchLocal('/__seed',{method:'POST'})).status,204);
 assert.equal((await fetchLocal('/__wake')).status,204);
 let history;
 const publicationDeadline=Date.now()+(stress ? 150000 : 30000);
 while(Date.now()<publicationDeadline) {
  const response=await fetchLocal('/data?resource=history');
  if(response.ok) {history=await response.json();break;}
  await wait(150);
 }
 assert.ok(history,'durable alarm did not publish history');
 const quoteResponse=await fetchLocal('/data?resource=quotes'),quotes=await quoteResponse.json();
 if(stress) {
  const manifest=await (await fetchLocal('/data?resource=intraday')).json();let points=0,ids=new Set();
  for(let index=0;index<manifest.chunk_count;index++) {
   const chunk=await (await fetchLocal(`/data?resource=intraday&revision=${manifest.revision}&chunk=${index}`)).json();
   for(const block of chunk.intradayBlocks) {ids.add(block.securityId);points+=block.rows.length;assert.ok(block.rows.every(row=>row[1]==='100.125' || row[1]==='99.125'));}
  }
  assert.equal(ids.size,200);assert.ok(points>=20000);
  console.log(JSON.stringify({status:'maximum_intraday_passed',instruments:ids.size,points,chunks:manifest.chunk_count}));
 }
 assert.match(quotes.revision,/^[a-f0-9]{64}$/);
 const unchanged=await fetchLocal('/data?resource=quotes',{headers:{'If-None-Match':quoteResponse.headers.get('ETag')}});
 assert.equal(unchanged.status,304);assert.ok(unchanged.headers.get('X-Market-Server-Time'));
 const chunk=await fetchLocal(`/data?resource=quotes&revision=${quotes.revision}&chunk=0`);
 assert.equal((await chunk.json()).quotes[0].price,'100.125');
 const historyChunk=await fetchLocal(`/data?resource=history&revision=${history.revision}&chunk=0`);
 assert.deepEqual((await historyChunk.json()).historyBlocks[0].rows,[['2026-10-01','100.125']]);
 assert.equal((await (await fetchLocal('/__progress')).json()).status,'unknown');
 assert.ok(!/market_coordinator_retry|SQLITE_(?:IOERR|BUSY|LOCKED)|uncaughtException|unhandledRejection/.test(output),output);
 console.log(JSON.stringify({status:'worker_runtime_passed',checks:stress?12:9,stress,storage:'local D1 + SQLite Durable Object',providersCalled:false}));
} finally {
 if(server && server.exitCode===null) {server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),wait(5000)]);if(server.exitCode===null) server.kill('SIGKILL');}
 rmSync(directory,{recursive:true,force:true});
}
