import {
  buildEnvelope,
  buildErrorEnvelope,
} from "../../../src/cli/output/envelope";
import { ToolError } from "../../../src/cli/output/toolError";

describe("buildEnvelope", () => {
  it("builds a v1 envelope with derived ok flag", () => {
    const env = buildEnvelope({
      command: "analyze",
      exitCode: 0,
      data: { foo: 42 },
      meta: { durationMs: 1, configPath: "./aact.config.ts", source: "x.puml" },
    });

    expect(env.schemaVersion).toBe(1);
    expect(env.command).toBe("analyze");
    expect(env.ok).toBe(true);
    expect(env.exitCode).toBe(0);
    expect(env.data).toEqual({ foo: 42 });
    expect(env.diagnostics).toEqual([]);
    expect(env.meta.configPath).toBe("./aact.config.ts");
    expect(env.meta.source).toBe("x.puml");
    expect(env.meta.durationMs).toBe(1);
    expect(env.meta.aactVersion).toMatch(/^\d/);
  });

  it("sets ok=false for non-zero exit codes", () => {
    const env = buildEnvelope({
      command: "check",
      exitCode: 1,
      data: { violations: [] },
      meta: { durationMs: 1, configPath: null, source: null },
    });
    expect(env.ok).toBe(false);
  });

  it("preserves provided diagnostics", () => {
    const env = buildEnvelope({
      command: "check",
      exitCode: 0,
      data: {},
      diagnostics: [
        {
          kind: "model.selfRelation",
          message: "self relation",
          severity: "warning",
        },
      ],
      meta: { durationMs: 0, configPath: null, source: null },
    });
    expect(env.diagnostics).toHaveLength(1);
    expect(env.diagnostics[0].kind).toBe("model.selfRelation");
  });
});

describe("buildErrorEnvelope", () => {
  it("wraps a ToolError with its diagnostic kind", () => {
    const env = buildErrorEnvelope({
      command: "analyze",
      error: new ToolError("config.invalidSchema", "schema busted"),
      startedAt: Date.now() - 5,
      configPath: "./aact.config.ts",
      source: null,
    });

    expect(env.exitCode).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.diagnostics).toHaveLength(1);
    expect(env.diagnostics[0].kind).toBe("config.invalidSchema");
    expect(env.diagnostics[0].message).toBe("schema busted");
    expect(env.meta.configPath).toBe("./aact.config.ts");
  });

  it("falls back to internal.unexpected for non-ToolError throws", () => {
    const env = buildErrorEnvelope({
      command: "analyze",
      error: new Error("something exploded"),
      startedAt: Date.now(),
      configPath: null,
      source: null,
    });

    expect(env.exitCode).toBe(2);
    expect(env.diagnostics[0].kind).toBe("internal.unexpected");
    expect(env.diagnostics[0].message).toBe("something exploded");
  });

  it("handles non-Error throws", () => {
    const env = buildErrorEnvelope({
      command: "analyze",
      error: "string thrown",
      startedAt: Date.now(),
      configPath: null,
      source: null,
    });

    expect(env.diagnostics[0].kind).toBe("internal.unexpected");
    expect(env.diagnostics[0].message).toBe("string thrown");
  });
});
