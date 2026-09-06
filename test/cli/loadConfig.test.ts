import { loadConfig } from "c12";
import path from "pathe";

import { loadAndValidateConfig } from "../../src/cli/loadConfig";

vi.mock("c12", () => ({
  loadConfig: vi.fn(),
}));

const mockLoadConfig = vi.mocked(loadConfig);

describe("loadAndValidateConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no config file found", async () => {
    mockLoadConfig.mockResolvedValue({
      config: undefined,
    } as unknown as ReturnType<typeof loadConfig> extends Promise<infer T>
      ? T
      : never);

    await expect(loadAndValidateConfig()).rejects.toThrow(
      "No aact config found",
    );
  });

  it("throws on invalid source.type", async () => {
    mockLoadConfig.mockResolvedValue({
      config: { source: { type: "invalid", path: "test.puml" } },
    });

    await expect(loadAndValidateConfig()).rejects.toThrow();
  });

  it("throws when source.path is missing", async () => {
    mockLoadConfig.mockResolvedValue({
      config: { source: { type: "plantuml" } },
    });

    await expect(loadAndValidateConfig()).rejects.toThrow();
  });

  it("throws on extra fields in strictObject", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: { type: "plantuml", path: "test.puml" },
        unknownField: true,
      },
    });

    await expect(loadAndValidateConfig()).rejects.toThrow();
  });

  it("throws when acl rule contains removed aclSuffix field", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: { type: "plantuml", path: "test.puml" },
        rules: { acl: { aclSuffix: "_acl" } },
      },
    });

    await expect(loadAndValidateConfig()).rejects.toThrow();
  });

  it("returns valid config", async () => {
    mockLoadConfig.mockResolvedValue({
      config: { source: { type: "plantuml", path: "test.puml" } },
    });

    const { config } = await loadAndValidateConfig();
    expect(config.source.type).toBe("plantuml");
    expect(config.source.path).toBe("test.puml");
  });

  it("resolves source.path relative to the config file", async () => {
    const configFile = path.resolve(
      "/repo/examples/ecommerce-structurizr/aact.config.ts",
    );
    mockLoadConfig.mockResolvedValue({
      config: {
        source: { type: "structurizr", path: "./workspace.dsl" },
      },
      configFile,
    });

    const { config } = await loadAndValidateConfig(
      "examples/ecommerce-structurizr/aact.config.ts",
    );

    expect(config.source.path).toBe(
      path.resolve("/repo/examples/ecommerce-structurizr/workspace.dsl"),
    );
  });

  describe("source.type auto-detection via defaultPattern", () => {
    it("infers plantuml from *.puml extension", async () => {
      mockLoadConfig.mockResolvedValue({
        config: { source: "./architecture.puml" },
      });
      const { config } = await loadAndValidateConfig();
      expect(config.source.type).toBe("plantuml");
    });

    it("infers structurizr from workspace.json basename", async () => {
      mockLoadConfig.mockResolvedValue({
        config: { source: "./workspace.json" },
      });
      const { config } = await loadAndValidateConfig();
      expect(config.source.type).toBe("structurizr");
    });

    it("infers model-json from *.aact.json suffix", async () => {
      mockLoadConfig.mockResolvedValue({
        config: { source: "./snapshot.aact.json" },
      });
      const { config } = await loadAndValidateConfig();
      expect(config.source.type).toBe("model-json");
    });

    it.each([
      "./compose.yaml",
      "./compose.yml",
      "./docker-compose.yaml",
      "./docker-compose.yml",
    ])("infers compose from canonical basename %s", async (sourcePath) => {
      mockLoadConfig.mockResolvedValue({ config: { source: sourcePath } });
      const { config } = await loadAndValidateConfig();
      expect(config.source.type).toBe("compose");
    });

    it.each(["./workspace.dsl", "./architecture.dsl", "./c4.dsl"])(
      "infers structurizr from %s (DSL-source UX parity)",
      async (sourcePath) => {
        mockLoadConfig.mockResolvedValue({ config: { source: sourcePath } });
        const { config } = await loadAndValidateConfig();
        expect(config.source.type).toBe("structurizr");
      },
    );

    it("falls back to plantuml-style positional shape when no pattern matches and explicit type is missing", async () => {
      mockLoadConfig.mockResolvedValue({
        config: { source: { type: "model-json", path: "./my-arch.json" } },
      });
      const { config } = await loadAndValidateConfig();
      expect(config.source.type).toBe("model-json");
    });
  });

  it("accepts empty-object form for option-less rules (symmetry with option-bearing)", async () => {
    // After the AcyclicOptions/CohesionOptions/etc. additions, the
    // four rules that have no options today still accept `rules:
    // { acyclic: {} }` so the user can be explicit without
    // resorting to `true`. The strict-empty shape rejects any
    // unknown key — test that part separately.
    mockLoadConfig.mockResolvedValue({
      config: {
        source: { type: "plantuml", path: "test.puml" },
        rules: {
          acyclic: {},
          cohesion: {},
          commonReuse: {},
          stableDependencies: {},
        },
      },
    });
    const { config } = await loadAndValidateConfig();
    expect(config.rules?.acyclic).toEqual({});
    expect(config.rules?.cohesion).toEqual({});
  });

  it("rejects unknown keys inside an option-less rule object", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: { type: "plantuml", path: "test.puml" },
        rules: {
          // `bogus` is not a valid key on AcyclicOptions —
          // strictObject({}) refuses any property.
          acyclic: { bogus: 42 },
        },
      },
    });
    await expect(loadAndValidateConfig()).rejects.toMatchObject({
      kind: "config.invalidSchema",
    });
  });

  it("wraps c12 load failure as ToolError config.loadFailed", async () => {
    mockLoadConfig.mockRejectedValue(new Error("c12 said nope"));

    await expect(
      loadAndValidateConfig("./aact.config.ts"),
    ).rejects.toMatchObject({
      name: "ToolError",
      kind: "config.loadFailed",
      context: { path: "./aact.config.ts" },
      message: expect.stringContaining("c12 said nope"),
    });
  });

  it("wraps non-Error c12 throw via String() coercion", async () => {
    mockLoadConfig.mockRejectedValue("plain string thrown");

    await expect(loadAndValidateConfig()).rejects.toMatchObject({
      kind: "config.loadFailed",
      message: expect.stringContaining("plain string thrown"),
    });
  });

  it("rejects explicit unknown source.type via registry guard (format.unknown)", async () => {
    mockLoadConfig.mockResolvedValue({
      config: { source: { type: "mermaid", path: "x.mmd" } },
    });

    // The schema currently accepts arbitrary strings for source.type; the
    // registry guard at the end of loadAndValidateConfig catches anything
    // not in `knownFormatNames()` and surfaces it as `format.unknown`.
    await expect(loadAndValidateConfig()).rejects.toMatchObject({
      kind: "format.unknown",
    });
  });
});

describe("loadAndValidateConfig — source.options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts kubernetes options that match the format schema", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: {
          type: "kubernetes",
          path: "./k8s",
          options: { namespaces: ["shop"], skip: ["debug-*"] },
        },
      },
    });
    const { config } = await loadAndValidateConfig();
    expect(config.source.options).toEqual({
      namespaces: ["shop"],
      skip: ["debug-*"],
    });
  });

  it("rejects a mistyped key in kubernetes options", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: {
          type: "kubernetes",
          path: "./k8s",
          options: { namespace: ["shop"] },
        },
      },
    });
    await expect(loadAndValidateConfig()).rejects.toThrow(
      /source\.options for format "kubernetes" failed schema validation/,
    );
  });

  it("rejects an invalid kind in compose imageHeuristic", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: {
          type: "compose",
          path: "./compose.yaml",
          options: { imageHeuristic: { "*postgres*": "Database" } },
        },
      },
    });
    await expect(loadAndValidateConfig()).rejects.toThrow(
      /source\.options for format "compose"/,
    );
  });

  it("accepts a compose naming transform function", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: {
          type: "compose",
          path: "./compose.yaml",
          options: { naming: { transform: (key: string) => key } },
        },
      },
    });
    await expect(loadAndValidateConfig()).resolves.toBeDefined();
  });

  it("rejects source.options for a format whose schema is empty (plantuml)", async () => {
    mockLoadConfig.mockResolvedValue({
      config: {
        source: {
          type: "plantuml",
          path: "./architecture.puml",
          options: { anything: true },
        },
      },
    });
    await expect(loadAndValidateConfig()).rejects.toThrow(
      /source\.options for format "plantuml" failed schema validation/,
    );
  });
});
