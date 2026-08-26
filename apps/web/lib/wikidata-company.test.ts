import { afterEach, describe, expect, it, vi } from "vitest";
import { clearWikidataCompanyAliasCache, resolveWikidataCompanyAlias } from "./wikidata-company";

const request = {
  symbol: "SPCX",
  exchangeMic: "XNAS",
  shortName: "Space Exploration Technologies",
  longName: "Space Exploration Technologies Corp.",
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearWikidataCompanyAliasCache();
});

describe("resolveWikidataCompanyAlias", () => {
  it("uses a common label only after exact legal-name verification", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ search: [{ id: "Q193701", label: "SpaceX", aliases: ["Space Exploration Technologies Corp."], match: { text: "Space Exploration Technologies Corp." } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveWikidataCompanyAlias(request)).resolves.toEqual({
      name: "SpaceX",
      source: "wikidata",
      entityId: "Q193701",
      confidence: "verified_legal_name",
    });
    await resolveWikidataCompanyAlias(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an attractive label when the legal name does not match", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ search: [{ id: "Q193701", label: "SpaceX", aliases: ["Unrelated Aerospace Corp."], match: { text: "Unrelated Aerospace Corp." } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ search: [] }), { status: 200 })));

    await expect(resolveWikidataCompanyAlias(request)).resolves.toBeNull();
  });
});
