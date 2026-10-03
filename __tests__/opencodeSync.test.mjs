import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_ID,
  mergeOpencodeProvider,
  syncOpencodeConfig,
  parseJsonc,
  resolveOpencodeConfigPath,
} from "../src/opencodeSync.mjs";

const PARAMS = {
  endpoint: "http://1.2.3.4:31739",
  modelId: "qwen2_5-coder-32b-awq",
  modelLabel: "Qwen2.5 Coder 32B (AWQ)",
};

// Dynamic default: without contextLen, resolveModelLimits falls back to
// DEFAULT_CONTEXT_LEN (32768) and output = min(4096, context/4) = 4096 (absolute
// cap). If the catalog default or MAX_OUTPUT_TOKENS changes, adjust it here.
const EXPECTED_LIMIT = { context: 32768, output: 4096 };

describe("mergeOpencodeProvider", () => {
  it("creates the provider from an empty config with a /v1 baseURL", () => {
    const { config, providerCreated, modelAdded, baseURL } =
      mergeOpencodeProvider({}, PARAMS);
    expect(providerCreated).toBe(true);
    expect(modelAdded).toBe(true);
    expect(baseURL).toBe("http://1.2.3.4:31739/v1");
    const p = config.provider[PROVIDER_ID];
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe("http://1.2.3.4:31739/v1");
    expect(p.options.apiKey).toBe("no-key-needed");
    expect(p.models[PARAMS.modelId]).toEqual({
      name: PARAMS.modelLabel,
      limit: EXPECTED_LIMIT,
    });
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  it("does not duplicate /v1 when the endpoint already has it", () => {
    const { baseURL } = mergeOpencodeProvider(
      {},
      { ...PARAMS, endpoint: "http://x:80/v1" },
    );
    expect(baseURL).toBe("http://x:80/v1");
  });

  it("preserves other providers and the existing agent config", () => {
    const current = {
      $schema: "https://opencode.ai/config.json",
      agent: { "my-agent": { mode: "primary" } },
      provider: { openai: { npm: "x", models: {} } },
    };
    const { config } = mergeOpencodeProvider(current, PARAMS);
    expect(config.agent["my-agent"].mode).toBe("primary");
    expect(config.provider.openai).toEqual({ npm: "x", models: {} });
    expect(config.provider[PROVIDER_ID]).toBeDefined();
  });

  it("updates the baseURL and adds a new model without overwriting the old one", () => {
    const current = {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Velocity GPU (Vast)",
          options: { baseURL: "http://old:1/v1", apiKey: "keep-me" },
          models: { "old-model": { name: "Old" } },
        },
      },
    };
    const { config, providerCreated, modelAdded } = mergeOpencodeProvider(
      current,
      PARAMS,
    );
    expect(providerCreated).toBe(false);
    expect(modelAdded).toBe(true);
    const p = config.provider[PROVIDER_ID];
    expect(p.options.baseURL).toBe("http://1.2.3.4:31739/v1");
    expect(p.options.apiKey).toBe("keep-me"); // preserves the existing key
    expect(p.models["old-model"]).toEqual({ name: "Old" }); // not overwritten
    expect(p.models[PARAMS.modelId]).toEqual({
      name: PARAMS.modelLabel,
      limit: EXPECTED_LIMIT,
    }); // added
  });

  it("modelAdded=false when the model already existed (only refreshes the baseURL)", () => {
    const current = {
      provider: {
        [PROVIDER_ID]: {
          options: { baseURL: "http://old:1/v1" },
          models: { [PARAMS.modelId]: { name: "previous" } },
        },
      },
    };
    const { config, modelAdded } = mergeOpencodeProvider(current, PARAMS);
    expect(modelAdded).toBe(false);
    expect(config.provider[PROVIDER_ID].models[PARAMS.modelId]).toEqual({
      name: "previous",
    });
    expect(config.provider[PROVIDER_ID].options.baseURL).toBe(
      "http://1.2.3.4:31739/v1",
    );
  });

  it("uses the modelId as the name when there is no label", () => {
    const { config } = mergeOpencodeProvider(
      {},
      { endpoint: "http://x:1", modelId: "m1" },
    );
    expect(config.provider[PROVIDER_ID].models.m1).toEqual({
      name: "m1",
      limit: EXPECTED_LIMIT,
    });
  });

  it("derives the limit dynamically from the model's contextLen", () => {
    const { config } = mergeOpencodeProvider(
      {},
      { ...PARAMS, contextLen: 16384 },
    );
    expect(config.provider[PROVIDER_ID].models[PARAMS.modelId].limit).toEqual({
      context: 16384,
      output: 4096,
    });
  });

  it("throws if endpoint or modelId is missing", () => {
    expect(() => mergeOpencodeProvider({}, { modelId: "m" })).toThrow(
      /required/,
    );
    expect(() => mergeOpencodeProvider({}, { endpoint: "http://x" })).toThrow(
      /required/,
    );
  });
});

describe("syncOpencodeConfig", () => {
  it("creates the file when it does not exist (ENOENT) and creates the directory", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const readFileImpl = vi.fn(async () => {
      throw enoent;
    });
    const writeFileImpl = vi.fn(async () => {});
    const mkdirImpl = vi.fn(async () => {});
    const out = await syncOpencodeConfig({
      configPath: "/home/user/.config/opencode/opencode.json",
      ...PARAMS,
      readFileImpl,
      writeFileImpl,
      mkdirImpl,
    });
    expect(out.created).toBe(true);
    expect(out.providerCreated).toBe(true);
    expect(out.modelAdded).toBe(true);
    expect(out.baseURL).toBe("http://1.2.3.4:31739/v1");
    expect(mkdirImpl).toHaveBeenCalledWith("/home/user/.config/opencode", {
      recursive: true,
    });
    const written = JSON.parse(writeFileImpl.mock.calls[0][1]);
    expect(written.provider[PROVIDER_ID].options.baseURL).toBe(
      "http://1.2.3.4:31739/v1",
    );
  });

  it("updates an existing file while preserving the rest", async () => {
    const existing = JSON.stringify({
      agent: { x: 1 },
      provider: { openai: {} },
    });
    const readFileImpl = vi.fn(async () => existing);
    const writeFileImpl = vi.fn(async () => {});
    const mkdirImpl = vi.fn(async () => {});
    const out = await syncOpencodeConfig({
      configPath: "/c/opencode.json",
      ...PARAMS,
      readFileImpl,
      writeFileImpl,
      mkdirImpl,
    });
    expect(out.created).toBe(false);
    const written = JSON.parse(writeFileImpl.mock.calls[0][1]);
    expect(written.agent).toEqual({ x: 1 });
    expect(written.provider.openai).toBeDefined();
    expect(written.provider[PROVIDER_ID]).toBeDefined();
  });

  it("treats an empty file as a new config", async () => {
    const readFileImpl = vi.fn(async () => "   ");
    const writeFileImpl = vi.fn(async () => {});
    const out = await syncOpencodeConfig({
      configPath: "/c/opencode.json",
      ...PARAMS,
      readFileImpl,
      writeFileImpl,
      mkdirImpl: vi.fn(async () => {}),
    });
    expect(out.created).toBe(false);
    expect(out.providerCreated).toBe(true);
  });

  it("does NOT overwrite a corrupted file: throws a readable error", async () => {
    const readFileImpl = vi.fn(async () => "{ this is not json");
    const writeFileImpl = vi.fn(async () => {});
    await expect(
      syncOpencodeConfig({
        configPath: "/c/opencode.json",
        ...PARAMS,
        readFileImpl,
        writeFileImpl,
        mkdirImpl: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/opencode\.json/);
    expect(writeFileImpl).not.toHaveBeenCalled();
  });

  it("throws if no configPath is given", async () => {
    await expect(
      syncOpencodeConfig({ ...PARAMS, configPath: "" }),
    ).rejects.toThrow(/configPath/);
  });
});

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  it("ignores line and block comments", () => {
    const raw = `{
      // line comment
      "a": 1,
      /* block
         comment */
      "b": 2
    }`;
    expect(parseJsonc(raw)).toEqual({ a: 1, b: 2 });
  });

  it("does NOT break URLs with // inside strings", () => {
    const raw = '{"baseURL":"http://1.2.3.4:42065/v1"}';
    expect(parseJsonc(raw)).toEqual({ baseURL: "http://1.2.3.4:42065/v1" });
  });

  it("respects escapes and quotes inside strings", () => {
    const raw = '{"q":"says \\"hi\\" and /* is not a comment */"}';
    expect(parseJsonc(raw)).toEqual({
      q: 'says "hi" and /* is not a comment */',
    });
  });

  it("tolerates trailing commas in objects and arrays (legal in JSONC)", () => {
    const raw = `{
      "command": [
        "my-mcp-server",
        "serve",
        "--tools=agent",
      ],
      "enabled": true,
    }`;
    expect(parseJsonc(raw)).toEqual({
      command: ["my-mcp-server", "serve", "--tools=agent"],
      enabled: true,
    });
  });

  it("does NOT mistake a comma inside a string for a trailing comma", () => {
    const raw = '{"a":"x, ]","b":[1,]}';
    expect(parseJsonc(raw)).toEqual({ a: "x, ]", b: [1] });
  });
});

describe("resolveOpencodeConfigPath", () => {
  it("prefers the .jsonc when it exists", () => {
    const existsImpl = vi.fn((p) => p.endsWith(".jsonc"));
    const path = resolveOpencodeConfigPath("/home/u/.config/opencode", {
      existsImpl,
    });
    expect(path).toMatch(/opencode\.jsonc$/);
  });

  it("falls back to .json when there is no .jsonc", () => {
    const existsImpl = vi.fn(() => false);
    const path = resolveOpencodeConfigPath("/home/u/.config/opencode", {
      existsImpl,
    });
    expect(path).toMatch(/opencode\.json$/);
    expect(path).not.toMatch(/\.jsonc$/);
  });
});
