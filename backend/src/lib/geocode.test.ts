import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostcode, geocodePostcodesBulk } from "./geocode.js";

afterEach(() => vi.restoreAllMocks());

describe("canonicalPostcode", () => {
  it("uppercases and strips all spaces", () => {
    expect(canonicalPostcode(" ls1 4dy ")).toBe("LS14DY");
    expect(canonicalPostcode("ec1a1bb")).toBe("EC1A1BB");
  });
});

describe("geocodePostcodesBulk", () => {
  it("returns an empty map for no postcodes without calling the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const map = await geocodePostcodesBulk([]);
    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps each known postcode to coords, keyed canonically, and omits unknowns", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { query: "LS1 4DY", result: { latitude: 53.79, longitude: -1.54 } },
          { query: "ZZ1 1ZZ", result: null },
        ],
      }),
    } as unknown as Response);

    const map = await geocodePostcodesBulk(["ls1 4dy", "ZZ1 1ZZ", null, "ls1 4dy"]);
    expect(map.get("LS14DY")).toEqual({ latitude: 53.79, longitude: -1.54 });
    expect(map.has("ZZ11ZZ")).toBe(false);
  });

  it("never throws on a network error — returns whatever resolved (empty here)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const map = await geocodePostcodesBulk(["LS1 4DY"]);
    expect(map.size).toBe(0);
  });
});
