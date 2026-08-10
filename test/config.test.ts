import { describe, it, expect } from "vitest";
import { configure } from "../src/index.js";
import { DEFAULT_GATEWAY_URL } from "../src/config.js";

describe("config: validation", () => {
  it("refuses a plaintext http:// gateway URL without insecure: true", () => {
    expect(() => configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_test" })).toThrow(/plaintext http/);
  });

  it("allows plaintext http:// when insecure: true is passed explicitly", () => {
    expect(() => configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_test", insecure: true })).not.toThrow();
  });

  it("allows https:// with no escape hatch needed", () => {
    expect(() => configure({ gatewayUrl: "https://gateway.observra.in", gatewayKey: "obs_test" })).not.toThrow();
  });

  it("defaults to the hosted gateway when no URL is given", () => {
    // The common case is a customer on the hosted platform, who should only
    // ever need a key - the URL is a self-hosting detail.
    expect(configure({ gatewayKey: "obs_test" }).gatewayUrl).toBe(DEFAULT_GATEWAY_URL);
  });

  it("prefers an explicit URL over the env var over the default", () => {
    process.env.OBSERVRA_GATEWAY_URL = "https://env.example.com";
    try {
      expect(configure({ gatewayKey: "obs_test", gatewayUrl: "https://explicit.example.com" }).gatewayUrl)
        .toBe("https://explicit.example.com");
      expect(configure({ gatewayKey: "obs_test" }).gatewayUrl).toBe("https://env.example.com");
    } finally {
      delete process.env.OBSERVRA_GATEWAY_URL;
    }
    expect(configure({ gatewayKey: "obs_test" }).gatewayUrl).toBe(DEFAULT_GATEWAY_URL);
  });

  it("falls back to the default when the URL is given but empty", () => {
    // An unset env var read into an option ("" rather than undefined) is a
    // real shape - `??` would have accepted the empty string and produced a
    // client pointed at nothing.
    expect(configure({ gatewayKey: "obs_test", gatewayUrl: "" }).gatewayUrl).toBe(DEFAULT_GATEWAY_URL);
  });

  it("requires a gateway key", () => {
    expect(() => configure({ gatewayUrl: "https://gateway.observra.in" })).toThrow(/gatewayKey is required/);
  });

  it("strips trailing slashes from the gateway URL", () => {
    const config = configure({ gatewayUrl: "https://gateway.observra.in///", gatewayKey: "obs_test" });
    expect(config.gatewayUrl).toBe("https://gateway.observra.in");
  });

  it("defaults guardrailMode to warn (detect-only, never alters payloads)", () => {
    const config = configure({ gatewayUrl: "https://gateway.observra.in", gatewayKey: "obs_test" });
    expect(config.guardrailMode).toBe("warn");
  });
});
