import { describe, expect, it } from "vitest";

import {
  RUNTIME_MODES,
  resolveRuntimeMode,
  isDesktopMode,
  describeEnvironment,
} from "../src/runtime.mjs";

describe("resolveRuntimeMode", () => {
  it("desktop when VELOCITY_MODE=desktop", () => {
    expect(resolveRuntimeMode({ VELOCITY_MODE: "desktop" })).toBe("desktop");
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(resolveRuntimeMode({ VELOCITY_MODE: "  Desktop " })).toBe("desktop");
  });

  it("web when VELOCITY_MODE=web", () => {
    expect(resolveRuntimeMode({ VELOCITY_MODE: "web" })).toBe("web");
  });

  it("web by default for an unknown value", () => {
    expect(resolveRuntimeMode({ VELOCITY_MODE: "something-else" })).toBe("web");
  });

  it("web when there is no env or variable", () => {
    expect(resolveRuntimeMode({})).toBe("web");
    expect(resolveRuntimeMode(null)).toBe("web");
  });
});

describe("isDesktopMode", () => {
  it("true only for desktop", () => {
    expect(isDesktopMode(RUNTIME_MODES.DESKTOP)).toBe(true);
    expect(isDesktopMode(RUNTIME_MODES.WEB)).toBe(false);
    expect(isDesktopMode("anything")).toBe(false);
  });
});

describe("describeEnvironment", () => {
  it("desktop enables auto-config", () => {
    expect(describeEnvironment("desktop")).toEqual({
      mode: "desktop",
      canAutoConfig: true,
    });
  });

  it("web disables auto-config", () => {
    expect(describeEnvironment("web")).toEqual({
      mode: "web",
      canAutoConfig: false,
    });
  });

  it("normalizes an unknown mode to web", () => {
    expect(describeEnvironment("???")).toEqual({
      mode: "web",
      canAutoConfig: false,
    });
  });
});
