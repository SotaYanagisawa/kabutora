import {MarketCoordinator as ProductionCoordinator} from "../lib/server/market/coordinator";
import {readPublicResource} from "../lib/server/market/publisher";
import type {MarketWorkerEnv} from "../lib/cloudflare-market-env";
export class MarketCoordinator extends ProductionCoordinator {
 constructor(state:ConstructorParameters<typeof ProductionCoordinator>[0],env:MarketWorkerEnv) {
  super(state,env);
  // Exercise cache publication while acquisition is durably budget-deferred.
  // This local fixture must never call a real market provider.
  state.storage.sql.exec("INSERT INTO metadata VALUES ('provider:blockedUntil',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(Date.now()+86400000));
 }
}
/** Local-only test entry; production worker-entry.ts never imports this module. */
export default {
 async fetch(request:Request,env:MarketWorkerEnv) {
  if(!env.MARKET_DB || !env.MARKET_COORDINATOR) return new Response(null,{status:503});
  const path=new URL(request.url).pathname;
  if(path==="/__health") return new Response("local-runtime");
  if(path==="/__seedmax" && request.method==="POST") {
   const url=new URL(request.url), offset=Number(url.searchParams.get("offset") ?? 0), timestamp=new Date().toISOString();
   const statements=[];
   for(let i=offset;i<Math.min(200,offset+10);i++) {
    const symbol=String(7000+i),id=`sec-${symbol}`;
    const quote={securityId:id,symbol,exchangeMic:"XTKS",currency:"JPY",price:"100.125",marketTimestamp:timestamp,fetchedAt:timestamp,freshness:"delayed",provider:"synthetic-runtime",session:"regular",priceType:"delayed_last",venueCode:"TSE",validationStatus:"valid"};
    const points=Array.from({length:2000},(_,j)=>({securityId:id,timestamp:new Date(Date.now()-(1999-j)*60000).toISOString(),price:"100.125",provider:"synthetic-runtime",session:"regular"}));
    statements.push(env.MARKET_DB.prepare("INSERT INTO market_securities VALUES (?,?,?,'XTKS','JPY','TSE','stock',1,?,?,?)").bind(id,symbol,symbol,timestamp,timestamp,timestamp),
     env.MARKET_DB.prepare("INSERT INTO market_quotes VALUES (?,?,?,?,'regular','delayed','valid',?)").bind(id,JSON.stringify(quote),timestamp,timestamp,timestamp),
     env.MARKET_DB.prepare("INSERT INTO market_intraday VALUES (?,?,?,?,?)").bind(id,JSON.stringify(points),points[0].timestamp,points.at(-1)!.timestamp,timestamp),
     env.MARKET_DB.prepare("INSERT INTO market_history_chunks VALUES (?,'2026-10',?,?)").bind(id,JSON.stringify([{securityId:id,date:"2026-10-01",close:"100.125",provider:"synthetic-runtime"}]),timestamp));
   }
   await env.MARKET_DB.batch(statements);return new Response(null,{status:204});
  }
  if(path==="/__seedframes" && request.method==="POST") {
   const offset=Number(new URL(request.url).searchParams.get("offset") ?? 0), payload=JSON.stringify(Object.fromEntries(Array.from({length:200},(_,i)=>[String(7000+i),["99.125","10"]])));
   const rows=Array.from({length:Math.min(100,1500-offset)},(_,j)=>{
    const minute=new Date(Date.now()-(1499-offset-j)*60000).toISOString();return {minute,payload};
   });
   await env.MARKET_DB.prepare("INSERT INTO market_pts_frames SELECT 'synthetic-session','JNX_DAY',json_extract(value,'$.minute'),json_extract(value,'$.minute'),json_extract(value,'$.payload'),200,json_extract(value,'$.minute') FROM json_each(?)").bind(JSON.stringify(rows)).run();
   return new Response(null,{status:204});
  }
  if(path==="/__seed" && request.method==="POST") {
   const timestamp=new Date().toISOString();
   const quote={securityId:"sec-us-aapl",symbol:"AAPL",exchangeMic:"XNAS",currency:"USD",price:"100.125",marketTimestamp:timestamp,fetchedAt:timestamp,freshness:"delayed",provider:"synthetic-runtime",session:"closed",priceType:"official_close",venueCode:"US",validationStatus:"valid"};
   const bars=[{securityId:"sec-us-aapl",date:"2026-10-01",close:"100.125",provider:"synthetic-runtime"}];
   await env.MARKET_DB.batch([
    env.MARKET_DB.prepare("INSERT INTO market_securities VALUES ('sec-us-aapl','AAPL','AAPL','XNAS','USD','US','stock',1,?,?,?)").bind(timestamp,timestamp,timestamp),
    env.MARKET_DB.prepare("INSERT INTO market_quotes VALUES ('sec-us-aapl',?,?,?,'closed','delayed','valid',?)").bind(JSON.stringify(quote),timestamp,timestamp,timestamp),
    env.MARKET_DB.prepare("INSERT INTO market_history_chunks VALUES ('sec-us-aapl','2026-10',?,?)").bind(JSON.stringify(bars),timestamp),
   ]);
   return new Response(null,{status:204});
  }
  if(path==="/__wake") return env.MARKET_COORDINATOR.get(env.MARKET_COORDINATOR.idFromName("public-market-v2")).fetch("https://coordinator/wake");
  if(path==="/__progress") return env.MARKET_COORDINATOR.get(env.MARKET_COORDINATOR.idFromName("public-market-v2")).fetch("https://coordinator/progress?runId=synthetic-runtime");
  if(path==="/__status") return env.MARKET_COORDINATOR.get(env.MARKET_COORDINATOR.idFromName("public-market-v2")).fetch("https://coordinator/status");
  if(path==="/data") return readPublicResource(env.MARKET_DB,request);
  return new Response(null,{status:404});
 }
};
