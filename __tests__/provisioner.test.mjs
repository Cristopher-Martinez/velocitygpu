import { describe, expect, it } from "vitest";
import {
  buildInstanceBody,
  buildOfferQuery,
  OLLAMA_IMAGE,
  OLLAMA_PORT,
  pickBestOffer,
  rankOffers,
} from "../src/provisioner.mjs";

const MODEL_32B = {
  id: "qwen2_5-32b",
  repo: "Qwen/Qwen2.5-32B-Instruct",
  params: 32,
  tensorParallel: 2,
  minTotalVramGb: 80,
  diskGb: 100,
  gated: false,
};

const MODEL_BUDGET = {
  id: "qwen2_5-72b-awq",
  repo: "Qwen/Qwen2.5-72B-Instruct-AWQ",
  params: 72,
  tensorParallel: 1,
  minTotalVramGb: 64,
  diskGb: 120,
  gated: false,
  quantization: "awq",
  minComputeCap: 750,
  maxDphTotal: 1.0,
};

describe("buildOfferQuery", () => {
  it("asks for a machine with EXACTLY the model's GPUs and enough VRAM", () => {
    const q = buildOfferQuery(MODEL_32B);
    expect(q.num_gpus).toEqual({ eq: 2 });
    expect(q.gpu_total_ram).toEqual({ gte: 80 * 1024 });
    expect(q.disk_space).toEqual({ gte: 100 });
    expect(q.order).toEqual([["dph_total", "asc"]]);
    expect(q.rentable).toEqual({ eq: true });
  });

  it("without maxDphTotal it adds no price cap", () => {
    expect(buildOfferQuery(MODEL_32B).dph_total).toBeUndefined();
  });

  it("with maxDphTotal it limits the offer price", () => {
    const q = buildOfferQuery(MODEL_BUDGET);
    expect(q.dph_total).toEqual({ lte: 1.0 });
    expect(q.num_gpus).toEqual({ eq: 1 });
  });

  it("always requires Turing+ (compute_cap >= 750) even if the model does not ask", () => {
    // Modern CUDA images dropped Volta (sm_70): the global floor applies to EVERY model.
    expect(buildOfferQuery(MODEL_32B).compute_cap).toEqual({ gte: 750 });
  });

  it("with a minComputeCap above the floor, the model's value wins (AWQ >= 750)", () => {
    expect(buildOfferQuery(MODEL_BUDGET).compute_cap).toEqual({ gte: 750 });
  });
});

describe("pickBestOffer", () => {
  const base = {
    gpuName: "X",
    reliability: 0.99,
    dphTotal: 1,
    computeCap: 800,
  };

  it("returns null when no offer qualifies", () => {
    expect(pickBestOffer(MODEL_32B, [])).toBeNull();
    expect(
      pickBestOffer(MODEL_32B, [
        { ...base, id: 1, numGpus: 1, totalVramGb: 24 },
      ]),
    ).toBeNull();
    // id 0 is discarded even if the VRAM is enough.
    expect(
      pickBestOffer(MODEL_32B, [
        { ...base, id: 0, numGpus: 2, totalVramGb: 96 },
      ]),
    ).toBeNull();
  });

  it("discards offers with MORE GPUs than tensorParallel (avoids the CDI bug)", () => {
    const offers = [
      { ...base, id: 1, numGpus: 4, totalVramGb: 96 },
      { ...base, id: 2, numGpus: 2, totalVramGb: 96 },
    ];
    // tp=2: the 4-GPU machine is discarded (it would mount extra cards); the 2-GPU one wins.
    expect(pickBestOffer(MODEL_32B, offers).id).toBe(2);
  });

  it("with the same num_gpus it prefers higher reliability", () => {
    const offers = [
      {
        id: 1,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        reliability: 0.96,
        dphTotal: 1,
        computeCap: 800,
      },
      {
        id: 2,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        reliability: 0.999,
        dphTotal: 2,
        computeCap: 800,
      },
    ];
    expect(pickBestOffer(MODEL_32B, offers).id).toBe(2);
  });

  it("with similar reliability it prefers the lower price", () => {
    const offers = [
      {
        id: 1,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        reliability: 0.99,
        dphTotal: 1.5,
        computeCap: 800,
      },
      {
        id: 2,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        reliability: 0.995,
        dphTotal: 0.7,
        computeCap: 800,
      },
    ];
    // |0.995 - 0.99| = 0.005 ≤ 0.01 → ties are broken by price.
    expect(pickBestOffer(MODEL_32B, offers).id).toBe(2);
  });

  it("discards offers above the model's maxDphTotal", () => {
    const expensive = {
      id: 1,
      gpuName: "A100",
      numGpus: 1,
      totalVramGb: 80,
      reliability: 0.99,
      dphTotal: 1.4,
      computeCap: 800,
    };
    const cheap = {
      id: 2,
      gpuName: "A100",
      numGpus: 1,
      totalVramGb: 80,
      reliability: 0.99,
      dphTotal: 0.9,
      computeCap: 800,
    };
    expect(pickBestOffer(MODEL_BUDGET, [expensive])).toBeNull();
    expect(pickBestOffer(MODEL_BUDGET, [expensive, cheap]).id).toBe(2);
  });

  it("discards GPUs below minComputeCap (V100=700 cannot run AWQ)", () => {
    const v100 = {
      id: 1,
      gpuName: "Tesla V100",
      numGpus: 1,
      totalVramGb: 80,
      reliability: 0.99,
      dphTotal: 0.13,
      computeCap: 700,
    };
    const a100 = {
      id: 2,
      gpuName: "A100",
      numGpus: 1,
      totalVramGb: 80,
      reliability: 0.99,
      dphTotal: 0.9,
      computeCap: 800,
    };
    // Only the V100 available: no valid offer (AWQ incompatible).
    expect(pickBestOffer(MODEL_BUDGET, [v100])).toBeNull();
    // With both, it picks the A100 even though it costs more: the V100 is discarded.
    expect(pickBestOffer(MODEL_BUDGET, [v100, a100]).id).toBe(2);
  });

  it("discards offers with no known computeCap (renting blind = crash on a V100)", () => {
    const noCap = {
      id: 1,
      gpuName: "?",
      numGpus: 1,
      totalVramGb: 80,
      reliability: 0.99,
      dphTotal: 0.5,
    };
    expect(pickBestOffer(MODEL_BUDGET, [noCap])).toBeNull();
  });

  it("treats a missing reliability as 0 when comparing", () => {
    const offers = [
      {
        id: 1,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        dphTotal: 1,
        computeCap: 800,
      },
      {
        id: 2,
        gpuName: "X",
        numGpus: 2,
        totalVramGb: 96,
        reliability: 0.99,
        dphTotal: 2,
        computeCap: 800,
      },
    ];
    expect(pickBestOffer(MODEL_32B, offers).id).toBe(2);
  });
});

describe("rankOffers", () => {
  it("returns ALL viable offers, sorted (not just the best one)", () => {
    const offers = [
      {
        id: 1,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.9,
        computeCap: 800,
      },
      {
        id: 2,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.7,
        computeCap: 800,
      },
      {
        id: 3,
        gpuName: "V100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.1,
        computeCap: 700,
      },
    ];
    const ranked = rankOffers(MODEL_BUDGET, offers);
    // The V100 (cc 700) is discarded; 2 remain, the cheapest first.
    expect(ranked.map((o) => o.id)).toEqual([2, 1]);
  });

  it("returns an empty list when no offer works", () => {
    expect(rankOffers(MODEL_BUDGET, [])).toEqual([]);
  });

  it("EXCLUDES hosts banned by machineId (blocklist with memory)", () => {
    const offers = [
      {
        id: 1,
        machineId: 100,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.7,
        computeCap: 800,
      },
      {
        id: 2,
        machineId: 200,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.9,
        computeCap: 800,
      },
    ];
    const ranked = rankOffers(MODEL_BUDGET, offers, { badIds: new Set([100]) });
    // Host 100 (cheaper) is banned: only 200 survives.
    expect(ranked.map((o) => o.machineId)).toEqual([200]);
  });

  it("PREFERS known-good hosts even if they cost more (allowlist)", () => {
    const offers = [
      {
        id: 1,
        machineId: 100,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.5,
        computeCap: 800,
      },
      {
        id: 2,
        machineId: 200,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.9,
        computeCap: 800,
      },
    ];
    // 200 costs more but is known-good → it goes first despite the price.
    const ranked = rankOffers(MODEL_BUDGET, offers, {
      goodIds: new Set([200]),
    });
    expect(ranked.map((o) => o.machineId)).toEqual([200, 100]);
  });

  it("does not discard offers without a machineId even with badIds (no history can be kept)", () => {
    const offers = [
      {
        id: 1,
        gpuName: "A100",
        numGpus: 1,
        totalVramGb: 80,
        reliability: 0.99,
        dphTotal: 0.7,
        computeCap: 800,
      },
    ];
    const ranked = rankOffers(MODEL_BUDGET, offers, { badIds: new Set([100]) });
    expect(ranked).toHaveLength(1);
  });
});

describe("buildInstanceBody", () => {
  it("starts Ollama with the official image and exposes 11434", () => {
    const body = buildInstanceBody(MODEL_32B);
    expect(body.image).toBe(OLLAMA_IMAGE);
    expect(body.disk).toBe(100);
    expect(body.runtype).toBe("args");
    expect(body.env[`-p ${OLLAMA_PORT}:${OLLAMA_PORT}`]).toBe("1");
  });

  it("forces OLLAMA_HOST to 0.0.0.0 so Vast's proxy can reach it", () => {
    const body = buildInstanceBody(MODEL_32B);
    expect(body.env.OLLAMA_HOST).toBe(`0.0.0.0:${OLLAMA_PORT}`);
  });

  it("pins OLLAMA_CONTEXT_LENGTH so Ollama does not truncate the context to its default", () => {
    // Without contextLen → falls back to DEFAULT_CONTEXT_LEN (32768). String: Vast env values are strings.
    const body = buildInstanceBody(MODEL_32B);
    expect(body.env.OLLAMA_CONTEXT_LENGTH).toBe("32768");
  });

  it("honors the model's explicit contextLen in OLLAMA_CONTEXT_LENGTH", () => {
    const body = buildInstanceBody({ ...MODEL_32B, contextLen: 16384 });
    expect(body.env.OLLAMA_CONTEXT_LENGTH).toBe("16384");
  });

  it("does NOT put the model in the args: the machine starts empty and is pulled later", () => {
    const body = buildInstanceBody(MODEL_32B);
    expect(body.args).toEqual([]);
  });

  it("does NOT inject a HuggingFace token (the catalog GGUFs are public)", () => {
    const body = buildInstanceBody(MODEL_32B);
    expect(body.env.HUGGING_FACE_HUB_TOKEN).toBeUndefined();
  });

  it("the body is identical for any model except the disk (one image serves everything)", () => {
    const a = buildInstanceBody(MODEL_32B);
    const b = buildInstanceBody(MODEL_BUDGET);
    expect(a.image).toBe(b.image);
    expect(a.env.OLLAMA_HOST).toBe(b.env.OLLAMA_HOST);
    expect(a.args).toEqual(b.args);
    expect(a.disk).toBe(MODEL_32B.diskGb);
    expect(b.disk).toBe(MODEL_BUDGET.diskGb);
  });
});
