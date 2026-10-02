import { afterEach, expect, it, vi } from "vitest";
import { providerFetch, withProviderExecution } from "./provider-fetch";
afterEach(() => vi.unstubAllGlobals());
it("reserves fallback and redirect attempts before network I/O", async () => {
    const calls: string[] = [];
    const network = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/next" } })).mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", network);
    await withProviderExecution({ signal: new AbortController().signal, reserve: (host) => { calls.push(host); }, outcome: () => { } }, () => providerFetch("https://provider.test/start"));
    expect(calls).toEqual(["provider.test", "provider.test"]);
    expect(network).toHaveBeenCalledTimes(2);
});
it("never calls an upstream after an exhausted reservation", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(withProviderExecution({ signal: new AbortController().signal, reserve: () => { throw Error("provider_budget_deferred"); }, outcome: () => { } }, () => providerFetch("https://provider.test"))).rejects.toThrow("provider_budget_deferred");
    expect(network).not.toHaveBeenCalled();
});
it("blocks redirect credential forwarding across origins", async () => {
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://other.test" } }));
    vi.stubGlobal("fetch", network);
    await expect(withProviderExecution({ signal: new AbortController().signal, reserve: () => { }, outcome: () => { } }, () => providerFetch("https://provider.test", { headers: { Cookie: "synthetic" } }))).rejects.toThrow("provider_redirect_origin_invalid");
    expect(network).toHaveBeenCalledTimes(1);
});
