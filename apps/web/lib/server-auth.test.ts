import { afterEach, expect, it, vi } from "vitest";

const env=vi.hoisted(()=>({FIREBASE_PROJECT_ID:"project",KABUTORA_ALLOWED_UID:"allowed",KABUTORA_REQUIRE_AUTH:"true",KABUTORA_ALLOWED_UIDS:undefined as string|undefined}));
const jose = vi.hoisted(() => ({
  importX509: vi.fn().mockResolvedValue({ type: "public" }),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "allowed" } }),
  decodeProtectedHeader: vi.fn().mockReturnValue({ alg: "RS256", kid: "key" }),
}));
vi.mock("jose", () => ({ ...jose, createRemoteJWKSet: () => ({}) }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); vi.resetModules(); env.KABUTORA_ALLOWED_UIDS=undefined; jose.jwtVerify.mockResolvedValue({payload:{sub:"allowed"}}); });

it("reuses imported public keys while verifying every token, and replaces keys after certificate rotation", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ key: "certificate-one" }, { headers: { "Cache-Control": "max-age=60" } }))
    .mockResolvedValueOnce(Response.json({ key: "certificate-two" }, { headers: { "Cache-Control": "max-age=60" } }));
  vi.stubGlobal("fetch", fetch);
  const { authorizeMarketRequest } = await import("./server-auth");
  const request = () => new Request("https://example.test/api/market/snapshot", { headers: { Authorization: "Bearer token" } });
  await authorizeMarketRequest(request(),env);
  await authorizeMarketRequest(request(),env);
  expect(jose.importX509).toHaveBeenCalledTimes(1);
  expect(jose.jwtVerify).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(61_000);
  await authorizeMarketRequest(request(),env);
  expect(jose.importX509).toHaveBeenLastCalledWith("certificate-two", "RS256");
  expect(jose.importX509).toHaveBeenCalledTimes(2);
  expect(jose.jwtVerify).toHaveBeenCalledTimes(3);
});

it("accepts configured group members and rejects an unlisted account",async()=>{
 env.KABUTORA_ALLOWED_UIDS="allowed, second";
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({key:"certificate"})));
 const {authorizeMarketRequest}=await import("./server-auth");
 jose.jwtVerify.mockResolvedValue({payload:{sub:"second"}});
 const request=new Request("https://example.test/api/market/snapshot",{headers:{Authorization:"Bearer synthetic"}});
 await expect(authorizeMarketRequest(request,env)).resolves.toEqual({uid:"second"});
 jose.jwtVerify.mockResolvedValue({payload:{sub:"unlisted"}});
 await expect(authorizeMarketRequest(request,env)).rejects.toThrow("Account is not authorized");
});
it("coalesces certificate downloads and distinguishes unavailable authentication from invalid credentials",async()=>{
 const network=vi.fn().mockResolvedValue(Response.json({key:"certificate"}));vi.stubGlobal("fetch",network);
 const {authorizeMarketRequest,MarketAuthUnavailable,unauthorizedResponse}=await import("./server-auth");
 const request=()=>new Request("https://example.test/api/market/snapshot",{headers:{Authorization:"Bearer synthetic"}});
 await Promise.all([authorizeMarketRequest(request(),env),authorizeMarketRequest(request(),env)]);
 expect(network).toHaveBeenCalledTimes(1);
 expect(unauthorizedResponse(new MarketAuthUnavailable("synthetic")).status).toBe(503);
 expect(unauthorizedResponse(new Error("synthetic")).status).toBe(401);
});
