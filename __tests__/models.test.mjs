import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, findModel } from "../src/models.mjs";

describe("MODEL_CATALOG", () => {
  it("has entries with the expected shape (Ollama-oriented)", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0);
    for (const m of MODEL_CATALOG) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.label).toBe("string");
      expect(typeof m.ollamaTag).toBe("string");
      expect(m.ollamaTag.length).toBeGreaterThan(0);
      expect(typeof m.repo).toBe("string");
      expect(typeof m.params).toBe("number");
      expect(m.minTotalVramGb).toBeGreaterThan(0);
      expect(m.diskGb).toBeGreaterThan(0);
      expect(typeof m.gated).toBe("boolean");
      expect(typeof m.blurb).toBe("string");
    }
  });

  it("the whole catalog declares engine 'ollama' (dormant seam) and runs on ONE GPU", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.engine).toBe("ollama");
      // GGUF on a single GPU: there is no multi-GPU tensor parallelism in this PoC.
      expect(m.tensorParallel).toBe(1);
    }
  });

  it("budget models (<= $1/h) have a price cap and a single GPU", () => {
    const budget = MODEL_CATALOG.filter((m) => m.budget);
    expect(budget.length).toBeGreaterThan(0);
    for (const m of budget) {
      expect(m.tensorParallel).toBe(1);
      expect(m.maxDphTotal).toBeLessThanOrEqual(1.0);
    }
  });

  it("curates only official Ollama library models (no community fine-tunes)", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.repo).toBe(`ollama.com/library/${m.ollamaTag}`);
    }
  });
});

describe("findModel", () => {
  it("returns the model when the id exists", () => {
    const m = findModel("qwen2_5-7b");
    expect(m).not.toBeNull();
    expect(m.id).toBe("qwen2_5-7b");
    expect(m.ollamaTag).toBe("qwen2.5:7b");
  });

  it("returns null when the id does not exist", () => {
    expect(findModel("does-not-exist")).toBeNull();
    expect(findModel(undefined)).toBeNull();
  });
});
