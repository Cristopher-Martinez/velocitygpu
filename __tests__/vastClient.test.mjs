import { describe, expect, it } from "vitest";
import {
  createVastApiClient,
  isStaleOfferError,
  mapInstance,
  mapOffer,
  VastApiError,
} from "../src/vastClient.mjs";

/** Fake fetch that records the last request and returns a fixed response. */
function fakeFetch(response) {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.method = init?.method;
    seen.headers = init?.headers;
    seen.body = init?.body;
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body ?? {},
      text: async () => response.text ?? "",
    };
  };
  return { fetchImpl, seen };
}

describe("mapOffer", () => {
  it("uses gpu_total_ram when present", () => {
    const o = mapOffer({
      id: 5,
      gpu_name: "RTX 4090",
      num_gpus: 2,
      gpu_ram: 24576,
      gpu_total_ram: 49152,
      dph_total: 0.5,
      reliability2: 0.99,
      machine_id: 77,
      driver_version: "550.0",
      geolocation: "US",
      cuda_max_good: 12,
      compute_cap: 890,
      inet_down: 500,
    });
    expect(o).toMatchObject({
      id: 5,
      gpuName: "RTX 4090",
      numGpus: 2,
      perGpuVramGb: 24,
      totalVramGb: 48,
      dphTotal: 0.5,
      reliability: 0.99,
      machineId: 77,
      driverVersion: "550.0",
      geolocation: "US",
      cudaMax: 12,
      computeCap: 890,
      inetDown: 500,
    });
  });

  it("derives the total as perGpu*numGpus and applies safe defaults", () => {
    const o = mapOffer({ gpu_ram: 24576, num_gpus: 2 });
    expect(o.totalVramGb).toBe(48); // 24576*2/1024
    expect(o.id).toBe(0);
    expect(o.gpuName).toBe("?");
    expect(o.dphTotal).toBe(0);
  });

  it("falls back to reliability when there is no reliability2", () => {
    const o = mapOffer({ reliability: 0.8 });
    expect(o.reliability).toBe(0.8);
    expect(o.numGpus).toBe(1);
  });
});

describe("mapInstance", () => {
  it("extracts the mapped host port of 11434/tcp", () => {
    const i = mapInstance({
      id: 9,
      actual_status: "running",
      status_msg: "ok",
      public_ipaddr: "1.2.3.4",
      ssh_host: "h",
      ssh_port: 22,
      ports: { "11434/tcp": [{ HostPort: "41234" }] },
    });
    expect(i).toMatchObject({
      id: 9,
      actualStatus: "running",
      statusMsg: "ok",
      publicIp: "1.2.3.4",
      sshHost: "h",
      sshPort: 22,
      apiPort: 41234,
    });
  });

  it("apiPort is undefined when there are no ports or the mapping is empty", () => {
    expect(mapInstance({ id: 1 }).apiPort).toBeUndefined();
    expect(mapInstance({ id: 1, ports: {} }).apiPort).toBeUndefined();
    expect(mapInstance({ id: 1, ports: { "11434/tcp": [] } }).apiPort).toBeUndefined();
    expect(mapInstance({ id: 1, ports: "nope" }).apiPort).toBeUndefined();
    expect(mapInstance({}).id).toBe(0);
  });

  it("maps the bundle VRAM (gpu_total_ram → totalVramGb) to reconcile the offer", () => {
    const i = mapInstance({ id: 7, gpu_ram: 49152, gpu_total_ram: 49152, num_gpus: 1 });
    expect(i.perGpuVramGb).toBe(48);
    expect(i.totalVramGb).toBe(48);
  });

  it("derives totalVramGb from gpu_ram × num_gpus if gpu_total_ram is missing", () => {
    const i = mapInstance({ id: 7, gpu_ram: 24576, num_gpus: 2 });
    expect(i.perGpuVramGb).toBe(24);
    expect(i.totalVramGb).toBe(48);
  });

  it("VRAM is undefined when the raw data has no gpu_ram (no invented 0 → avoids 'undefinedGB')", () => {
    const i = mapInstance({ id: 7, num_gpus: 1 });
    expect(i.perGpuVramGb).toBeUndefined();
    expect(i.totalVramGb).toBeUndefined();
  });
});

describe("VastApiError", () => {
  it("keeps the status and the name", () => {
    const e = new VastApiError("boom", 404);
    expect(e.status).toBe(404);
    expect(e.name).toBe("VastApiError");
    expect(e.message).toBe("boom");
  });
});

describe("isStaleOfferError", () => {
  it("detects no_such_ask", () => {
    expect(isStaleOfferError(new Error("error 404/3603: no_such_ask"))).toBe(true);
  });
  it("detects 'is not available'", () => {
    expect(isStaleOfferError(new Error("Instance type by id 39314702 is not available."))).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isStaleOfferError(new Error("401 unauthorized"))).toBe(false);
    expect(isStaleOfferError(null)).toBe(false);
    expect(isStaleOfferError(undefined)).toBe(false);
  });
});

describe("createVastApiClient", () => {
  it("getAccount uses credit and sends the Bearer token", async () => {
    const { fetchImpl, seen } = fakeFetch({ ok: true, body: { id: 1, email: "a@b.c", credit: 12.5 } });
    const client = createVastApiClient({ apiKey: "KEY", fetchImpl });
    const acct = await client.getAccount();
    expect(acct).toEqual({ id: 1, email: "a@b.c", balance: 12.5 });
    expect(seen.headers.Authorization).toBe("Bearer KEY");
  });

  it("getAccount falls back to balance when there is no credit", async () => {
    const { fetchImpl } = fakeFetch({ ok: true, body: { balance: 3 } });
    const client = createVastApiClient({ apiKey: "K", fetchImpl });
    expect((await client.getAccount()).balance).toBe(3);
  });

  it("searchOffers maps offers and handles a response without an array", async () => {
    const withOffers = fakeFetch({ ok: true, body: { offers: [{ id: 1, gpu_name: "A" }] } });
    const c1 = createVastApiClient({ apiKey: "K", fetchImpl: withOffers.fetchImpl });
    const offers = await c1.searchOffers({ rentable: { eq: true } });
    expect(offers).toHaveLength(1);
    expect(offers[0].gpuName).toBe("A");
    expect(decodeURIComponent(withOffers.seen.url)).toContain('"rentable"');

    const noOffers = fakeFetch({ ok: true, body: {} });
    const c2 = createVastApiClient({ apiKey: "K", fetchImpl: noOffers.fetchImpl });
    expect(await c2.searchOffers({})).toEqual([]);
  });

  it("createInstance resolves the id from new_contract / new_instance_id / 0", async () => {
    const a = fakeFetch({ ok: true, body: { new_contract: 111 } });
    const ca = createVastApiClient({ apiKey: "K", fetchImpl: a.fetchImpl });
    expect((await ca.createInstance(7, { image: "x" })).newInstanceId).toBe(111);
    expect(a.seen.method).toBe("PUT");

    const b = fakeFetch({ ok: true, body: { new_instance_id: 222 } });
    const cb = createVastApiClient({ apiKey: "K", fetchImpl: b.fetchImpl });
    expect((await cb.createInstance(7, {})).newInstanceId).toBe(222);

    const z = fakeFetch({ ok: true, body: {} });
    const cz = createVastApiClient({ apiKey: "K", fetchImpl: z.fetchImpl });
    expect((await cz.createInstance(7, {})).newInstanceId).toBe(0);
  });

  it("destroyInstance issues a DELETE", async () => {
    const { fetchImpl, seen } = fakeFetch({ ok: true, body: {} });
    const client = createVastApiClient({ apiKey: "K", fetchImpl });
    await client.destroyInstance(42);
    expect(seen.method).toBe("DELETE");
    expect(seen.url).toContain("/instances/42/");
  });

  it("getInstance reads data.instances, the flat object, and returns null if there is no object", async () => {
    const nested = fakeFetch({ ok: true, body: { instances: { id: 3, actual_status: "running" } } });
    const c1 = createVastApiClient({ apiKey: "K", fetchImpl: nested.fetchImpl });
    expect((await c1.getInstance(3)).id).toBe(3);

    const flat = fakeFetch({ ok: true, body: { id: 4 } });
    const c2 = createVastApiClient({ apiKey: "K", fetchImpl: flat.fetchImpl });
    expect((await c2.getInstance(4)).id).toBe(4);

    const empty = fakeFetch({ ok: true, body: { instances: null } });
    const c3 = createVastApiClient({ apiKey: "K", fetchImpl: empty.fetchImpl });
    // body.instances null → falls back to `data` (an object) → mapInstance handles it.
    expect((await c3.getInstance(5)).id).toBe(0);

    // non-object raw value (e.g. the API answers with a scalar) → null.
    const scalar = fakeFetch({ ok: true, body: { instances: "none" } });
    const c4 = createVastApiClient({ apiKey: "K", fetchImpl: scalar.fetchImpl });
    expect(await c4.getInstance(6)).toBeNull();
  });

  it("listInstances maps the array and returns [] if no array comes back", async () => {
    const list = fakeFetch({
      ok: true,
      body: { instances: [{ id: 7, actual_status: "running" }, { id: 8 }] },
    });
    const c1 = createVastApiClient({ apiKey: "K", fetchImpl: list.fetchImpl });
    const got = await c1.listInstances();
    expect(got.map((i) => i.id)).toEqual([7, 8]);

    const noArray = fakeFetch({ ok: true, body: { instances: null } });
    const c2 = createVastApiClient({ apiKey: "K", fetchImpl: noArray.fetchImpl });
    expect(await c2.listInstances()).toEqual([]);
  });

  it("throws VastApiError with the status and the detail on not-ok responses", async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 404, text: "missing" });
    const client = createVastApiClient({ apiKey: "K", fetchImpl });
    await expect(client.getAccount()).rejects.toMatchObject({
      name: "VastApiError",
      status: 404,
    });
  });

  it("formats the error without detail when the text body is empty", async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 500, text: "" });
    const client = createVastApiClient({ apiKey: "K", fetchImpl });
    await expect(client.getAccount()).rejects.toThrow(/→ 500$/);
  });

  it("uses the global fetch by default when none is injected", () => {
    const client = createVastApiClient({ apiKey: "K" });
    expect(typeof client.getAccount).toBe("function");
  });
});
