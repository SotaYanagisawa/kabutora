import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { importPKCS8, exportJWK, importX509, SignJWT } from "jose";
const env = vi.hoisted(() => ({FIREBASE_PROJECT_ID:"synthetic-project",FIREBASE_PROJECT_NUMBER:"123456",FIREBASE_WEB_APP_ID:"synthetic-app",KABUTORA_REQUIRE_AUTH:"true",KABUTORA_REQUIRE_APP_CHECK:"true",KABUTORA_ALLOWED_UIDS:"member-a,member-b"}));
vi.mock("./server-market-request-context",()=>({currentMarketRequestContext:()=>({env})}));
let directory:string, certificate:string, privateKey:Awaited<ReturnType<typeof importPKCS8>>, publicJwk:Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async()=>{
  directory=mkdtempSync(`${tmpdir()}/kabutora-synthetic-auth-`);chmodSync(directory,0o700);
  execFileSync("/usr/bin/openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",`${directory}/key.pem`,"-out",`${directory}/certificate.pem`,"-days","1","-subj","/CN=synthetic-kabutora-test"],{stdio:"ignore"});
  certificate=readFileSync(`${directory}/certificate.pem`,"utf8");
  privateKey=await importPKCS8(readFileSync(`${directory}/key.pem`,"utf8"),"RS256");
  publicJwk=await exportJWK(await importX509(certificate,"RS256"));
});
afterEach(()=>{vi.unstubAllGlobals();env.KABUTORA_ALLOWED_UIDS="member-a,member-b";});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
async function request(uid:string, options:{expired?:boolean;appCheck?:boolean}={}) {
  const token=await new SignJWT({}).setProtectedHeader({alg:"RS256",kid:"synthetic-key"}).setSubject(uid).setIssuer("https://securetoken.google.com/synthetic-project").setAudience("synthetic-project").setIssuedAt().setExpirationTime(options.expired?Math.floor(Date.now()/1000)-60:"5m").sign(privateKey);
  const appCheck=await new SignJWT({}).setProtectedHeader({alg:"RS256",kid:"synthetic-key",typ:"JWT"}).setSubject("synthetic-app").setIssuer("https://firebaseappcheck.googleapis.com/123456").setAudience("projects/123456").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return new Request("https://synthetic.test/api/market/data?resource=quotes",{headers:{Authorization:`Bearer ${token}`,...(options.appCheck===false?{}:{"X-Firebase-AppCheck":appCheck})}});
}
it("verifies real signatures and App Check for two members, denies outsiders, expired tokens and immediate revocation",async()=>{
  vi.stubGlobal("fetch",async(input:string|URL)=>{
    const url=String(input);
    if(url.startsWith("https://www.googleapis.com/robot/")) return Response.json({"synthetic-key":certificate},{headers:{"Cache-Control":"max-age=3600"}});
    if(url==="https://firebaseappcheck.googleapis.com/v1/jwks") return Response.json({keys:[{...publicJwk,kid:"synthetic-key",alg:"RS256",use:"sig"}]});
    throw new Error("unexpected_network_destination");
  });
  const {authorizeMarketRequest}=await import("./server-auth");
  await expect(authorizeMarketRequest(await request("member-a"))).resolves.toEqual({uid:"member-a"});
  await expect(authorizeMarketRequest(await request("member-b"))).resolves.toEqual({uid:"member-b"});
  await expect(authorizeMarketRequest(await request("outsider"))).rejects.toThrow("Account is not authorized");
  await expect(authorizeMarketRequest(await request("member-a",{expired:true}))).rejects.toThrow();
  await expect(authorizeMarketRequest(await request("member-a",{appCheck:false}))).rejects.toThrow("App verification required");
  env.KABUTORA_ALLOWED_UIDS="member-a";
  await expect(authorizeMarketRequest(await request("member-b"))).rejects.toThrow("Account is not authorized");
});
