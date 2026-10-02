import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {expect,it} from "vitest";
import {readLatestJapannextPtsBars} from "./server-pts-collector";
import type {D1DatabaseLike,D1PreparedStatementLike} from "./cloudflare-market-env";
it("projects only requested public PTS symbols in SQLite before transferring whole-market frames",async()=>{
 const sqlite=new DatabaseSync(":memory:");
 sqlite.exec(readFileSync(new URL("../migrations/0005_japannext_pts_frames.sql",import.meta.url),"utf8"));
 let maximumPayload=0;
 class Statement implements D1PreparedStatementLike {
  values:(string|number|null)[]=[];
  constructor(private query:string){}
  bind(...values:unknown[]){expect(values.length).toBeLessThanOrEqual(100);this.values=values as (string|number|null)[];return this;}
  async all<T>(){const rows=sqlite.prepare(this.query).all(...this.values);for(const row of rows) maximumPayload=Math.max(maximumPayload,String(row.payload_json ?? "").length);return {success:true,results:rows as T[]};}
  async first<T>(){return (sqlite.prepare(this.query).get(...this.values) ?? null) as T|null;}
  async run(){sqlite.prepare(this.query).run(...this.values);return {success:true};}
 }
 const db:D1DatabaseLike={prepare:query=>new Statement(query),batch:async statements=>Promise.all(statements.map(statement=>statement.run()))};
 try {
  const payload=Object.fromEntries(Array.from({length:5000},(_,i)=>[String(5000+i),["100.1234567890123456789","100"]]));
  for(const minute of ["2026-10-01T07:00:00Z","2026-10-01T07:01:00Z"]) sqlite.prepare("INSERT INTO market_pts_frames VALUES (?,?,?,?,?,?,?)").run("2026-10-01:night","JNX_NIGHT",minute,minute,JSON.stringify(payload),5000,minute);
  const selected=new Set(["sec-7203","sec-9984"]);
  const result=await readLatestJapannextPtsBars(db,selected,"2026-10-01T07:00:00Z");
  expect(result.bars).toHaveLength(2);expect(result.revision).toBe("2026-10-01T07:01:00Z");
  expect(result.bars.map(bar=>bar.securityId).sort()).toEqual([...selected].sort());
  expect(result.bars[0].price).toBe("100.1234567890123456789");
  expect(maximumPayload).toBeLessThan(200);
 } finally {sqlite.close();}
});
