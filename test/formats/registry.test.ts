import { knownFormatNames, loadFormat } from "../../src/formats/registry";
import type { Format } from "../../src/formats/types";
import { canFix, canGenerate, canLoad } from "../../src/formats/types";

/**
 * F1 — Format API contract audit.
 *
 * Каждый зарегистрированный формат self-describes capabilities через
 * наличие методов (load / generate / fix). Тесты ниже фиксируют declared
 * shape per format — добавление/удаление capability у уже-существующего
 * формата = breaking change, должен сопровождаться явным CHANGELOG entry.
 *
 * При добавлении нового формата (Mermaid C4, Compose, LikeC4) — добавить
 * row в `CAPABILITIES_MATRIX` ниже.
 */

const CAPABILITIES_MATRIX: ReadonlyArray<{
  name: string;
  load: boolean;
  generate: boolean;
  fix: boolean;
  defaultPattern?: string | readonly string[];
}> = [
  {
    name: "plantuml",
    load: true,
    generate: true,
    fix: true,
    defaultPattern: "*.puml",
  },
  {
    name: "structurizr",
    load: true,
    // DSL emitter — see `src/formats/structurizr/generate.ts`. Out-of-scope
    // bits (archetype compress, opaque round-trip) documented in
    // `parser/README.md`; round-trip parity is covered by the generator tests.
    generate: true,
    fix: true,
    // workspace.json (exact basename) + *.dsl (extension) — DSL-files
    // auto-detect type=structurizr без явного source.type в config.
    defaultPattern: ["workspace.json", "*.dsl"],
  },
  {
    name: "kubernetes",
    // Phase 2 ADR: добавлен load для drift-detection (`aact diff
    // arch.dsl ./k8s/`). MVP coverage — workload kinds + namespace
    // → Boundary + aact.* annotations. Relations / Services /
    // kustomize chase — Phase C followup.
    load: true,
    generate: true,
    fix: false, // IaC не authored руками — fix не имеет смысла
  },
  {
    name: "model-json",
    load: true,
    generate: true,
    fix: false, // JSON не имеет meaningful range semantics для C4 edits
    defaultPattern: "*.aact.json",
  },
  {
    name: "compose",
    load: true,
    // generate — scaffold path (Model → starter compose.yml для dev-команды);
    // round-trip покрытие также пригождается для тестов loader'а.
    generate: true,
    fix: false, // YAML не имеет meaningful range semantics для C4 edits
    defaultPattern: [
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
    ],
  },
];

describe("Format registry — capability contracts", () => {
  it("knownFormatNames matches CAPABILITIES_MATRIX (no orphans)", () => {
    const known = [...knownFormatNames()].toSorted();
    const expected = CAPABILITIES_MATRIX.map((r) => r.name).toSorted();
    expect(known).toEqual(expected);
  });

  it.each(CAPABILITIES_MATRIX)(
    "$name declares correct capabilities",
    async ({ name, load, generate, fix, defaultPattern }) => {
      const fmt = await loadFormat(name);

      // Format identity
      expect(fmt.name).toBe(name);
      if (defaultPattern !== undefined) {
        // Format может объявить string ИЛИ readonly string[] — для
        // массивов `toBe` не сработает (identity check), используем
        // `toEqual` который покрывает оба случая.
        expect(fmt.defaultPattern).toEqual(defaultPattern);
      }

      // Capability presence
      expect(canLoad(fmt)).toBe(load);
      expect(canGenerate(fmt)).toBe(generate);
      expect(canFix(fmt)).toBe(fix);

      // Non-declared capabilities ВООБЩЕ отсутствуют (`in` operator false),
      // не задаются как `undefined` stub. Это держит формат "честным" —
      // не utility класс с empty methods, а property-bag из реализованных.
      if (!load) expect("load" in fmt).toBe(false);
      if (!generate) expect("generate" in fmt).toBe(false);
      if (!fix) expect("fix" in fmt).toBe(false);
    },
  );

  it("loadFormat throws friendly error for unknown name", async () => {
    await expect(loadFormat("mystery")).rejects.toThrow(/Unknown format/);
  });

  it("loadFormat error lists all known formats (help-text contract)", async () => {
    try {
      await loadFormat("nope");
      expect.fail("expected loadFormat to throw");
    } catch (error) {
      const msg = String((error as Error).message);
      for (const { name } of CAPABILITIES_MATRIX) {
        expect(msg).toContain(name);
      }
    }
  });
});

describe("Format API — fix capability shape", () => {
  it.each(CAPABILITIES_MATRIX.filter((r) => r.fix))(
    "$name fix.syntax implements full FormatSyntax interface",
    async ({ name }) => {
      const fmt = await loadFormat(name);
      if (!canFix(fmt))
        throw new Error(`${name} declared fix but canFix=false`);
      const { syntax } = fmt.fix;

      // Smoke: each content-builder returns a non-empty string for
      // trivial input. Patterns are gone in v3 — edits anchor on
      // `SourceLocation` source ranges, not text search.
      expect(
        syntax.containerDecl({
          name: "svc",
          label: "Service",
          kind: "Container",
          external: false,
          description: "",
          tags: [],
          relations: [],
        }).length,
      ).toBeGreaterThan(0);
      expect(syntax.relationDecl("a", "b").length).toBeGreaterThan(0);
    },
  );
});

describe("Format API — generate capability shape", () => {
  it.each(CAPABILITIES_MATRIX.filter((r) => r.generate))(
    "$name.generate returns FormatOutput shape on empty model",
    async ({ name }) => {
      const fmt = await loadFormat(name);
      if (!canGenerate(fmt))
        throw new Error(`${name} declared generate but canGenerate=false`);

      const emptyModel = {
        elements: Object.freeze({}),
        boundaries: Object.freeze({}),
        rootBoundaryNames: Object.freeze([] as readonly string[]),
      };
      const output = fmt.generate(emptyModel);

      expect(output).toHaveProperty("files");
      expect(Array.isArray(output.files)).toBe(true);
      for (const f of output.files) {
        expect(typeof f.path).toBe("string");
        expect(typeof f.content).toBe("string");
      }
    },
  );
});

describe("Format API — load capability shape", () => {
  it.each(CAPABILITIES_MATRIX.filter((r) => r.load))(
    "$name.load returns LoadResult shape (rejects on missing file)",
    async ({ name }) => {
      const fmt = await loadFormat(name);
      if (!canLoad(fmt))
        throw new Error(`${name} declared load but canLoad=false`);

      // Missing file → ENOENT propagates (CLI handles, library users decide).
      await expect(
        fmt.load("./does-not-exist.aact-test-bogus"),
      ).rejects.toThrow();
    },
  );
});

describe("Format API — narrowing via type guards", () => {
  it("canLoad guard narrows .load to non-undefined", async () => {
    const fmt: Format = await loadFormat("plantuml");
    if (canLoad(fmt)) {
      // After narrow — calling fmt.load is type-safe без ! и без runtime check.
      await expect(
        fmt.load("./does-not-exist.aact-test-bogus"),
      ).rejects.toThrow();
    } else {
      expect.fail("plantuml should canLoad");
    }
  });

  it("canGenerate guard narrows .generate to non-undefined", async () => {
    const fmt: Format = await loadFormat("kubernetes");
    if (canGenerate(fmt)) {
      const output = fmt.generate({
        elements: Object.freeze({}),
        boundaries: Object.freeze({}),
        rootBoundaryNames: Object.freeze([] as readonly string[]),
      });
      expect(output.files).toEqual([]);
    } else {
      expect.fail("kubernetes should canGenerate");
    }
  });

  it("canFix guard narrows .fix to non-undefined", async () => {
    const fmt: Format = await loadFormat("structurizr");
    if (canFix(fmt)) {
      expect(fmt.fix.syntax).toBeDefined();
    } else {
      expect.fail("structurizr should canFix");
    }
  });
});

describe("format registry — source.options contract", () => {
  it("every built-in format declares a loadOptionsSchema (empty when it takes none)", async () => {
    for (const name of knownFormatNames()) {
      const format = await loadFormat(name);
      expect(format.loadOptionsSchema, name).toBeDefined();
    }
  });
});
