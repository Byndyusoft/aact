/**
 * `structurizrFormat.load(path/to/workspace.dsl)` reads Structurizr
 * DSL sources directly through the chevrotain parser. This file
 * covers the DSL dispatch path — the JSON path is exercised
 * exhaustively by `load.test.ts`.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import path from "pathe";

import { IncludeNotFoundError } from "../../../src/formats/_shared/includeError";
import { load } from "../../../src/formats/structurizr/load";

const ECOMMERCE_DSL = path.resolve(
  __dirname,
  "../../../examples/ecommerce-structurizr/workspace.dsl",
);

describe("structurizrFormat.load — .dsl dispatch", () => {
  it("loads ecommerce workspace.dsl into a populated Model", async () => {
    const result = await load(ECOMMERCE_DSL);

    // Three internal systems (orders/inventory/fulfillment) each
    // gain a Boundary because they contain nested containers;
    // payment and notifications are leaf systems → Containers.
    // Model.elements keyed by DSL identifier (assignedIdentifier).
    expect(Object.keys(result.model.boundaries).sort()).toEqual([
      "fulfillment",
      "inventory",
      "orders",
    ]);
    expect(result.model.elements["payment"]?.kind).toBe("System");
    expect(result.model.elements["notifications"]?.kind).toBe("System");
    expect(result.model.elements["payment"]?.external).toBe(true);
    expect(result.model.elements["notifications"]?.external).toBe(true);

    // Container kinds resolved by name (CRUD → repo tag, DB → kind
    // ContainerDb when technology heuristic kicks in)
    expect(result.model.elements["orders_api"]?.kind).toBe("Container");
    expect(result.model.elements["orders_db"]?.kind).toBe("ContainerDb");
    expect(result.model.elements["orders_db"]?.technology).toBe("PostgreSQL");

    // Explicit relationships preserved with description, technology,
    // and default `Relationship` tag. relation.to references DSL ids.
    const ordersApi = result.model.elements["orders_api"];
    expect(ordersApi?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "orders_crud", description: "HTTP" }),
        expect.objectContaining({ to: "inventory_api", description: "HTTP" }),
        expect.objectContaining({
          to: "fulfillment_api",
          description: "HTTP",
        }),
      ]),
    );
  });

  it("throws with a readable message on DSL parse errors", async () => {
    // A `.dsl` file that doesn't exist — fs.readFile rejects, the
    // loader propagates. (Bad-syntax case is covered by parser-level
    // tests.)
    await expect(load("/nonexistent/path/workspace.dsl")).rejects.toThrow();
  });

  it("expands local !include files before parsing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-include-"));
    await writeFile(
      path.join(dir, "people.dsl"),
      'user = person "User"\n',
      "utf8",
    );
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {
        model {
          !include people.dsl
          api = softwareSystem "API"
          user -> api "uses"
        }
      }`,
      "utf8",
    );

    const result = await load(main);

    expect(result.model.elements.user?.relations[0]).toEqual(
      expect.objectContaining({ to: "api", description: "uses" }),
    );
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "include-not-expanded" }),
    );
  });

  it("expands local !include directories in stable filename order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-dir-include-"));
    const modelDir = path.join(dir, "model");
    await mkdir(modelDir);
    await writeFile(
      path.join(modelDir, "01-people.dsl"),
      'user = person "User"\n',
    );
    await writeFile(
      path.join(modelDir, "02-system.dsl"),
      'api = softwareSystem "API"\n',
    );
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {
        model {
          !include model
          user -> api "uses"
        }
      }`,
      "utf8",
    );

    const result = await load(main);

    expect(result.model.elements.user).toBeDefined();
    expect(result.model.elements.api).toBeDefined();
    expect(result.model.elements.user?.relations[0]?.to).toBe("api");
  });
});

describe("structurizrFormat.load — .dsl edge cases", () => {
  it("expands a quoted !include target", async () => {
    // A quoted include path exercises stripQuoted's trim + slice path
    // (load.ts:stripQuoted).
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-quoted-"));
    await writeFile(
      path.join(dir, "people.dsl"),
      'user = person "User"\n',
      "utf8",
    );
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {\r\n` +
        `        model {\r\n` +
        `          !include "people.dsl"\r\n` +
        `          api = softwareSystem "API"\r\n` +
        `          user -> api "uses"\r\n` +
        `        }\r\n` +
        `      }\r\n`,
      "utf8",
    );

    const result = await load(main);
    expect(result.model.elements.user).toBeDefined();
    expect(result.model.elements.user?.relations[0]?.to).toBe("api");
  });

  it("leaves a mismatched-quote !include target unstripped", async () => {
    // Value starts with `'` but does not end with `'` (it ends with
    // `"`), so stripQuoted's quote-pair check fails and it returns the
    // trimmed value verbatim (load.ts:215). The literal — including the
    // mismatched quotes — is then used as the include path, so we name
    // the included file to match exactly.
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-mismatch-"));
    const oddName = `'inc.dsl"`;
    await writeFile(path.join(dir, oddName), 'user = person "User"\n', "utf8");
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {\n  model {\n    !include ${oddName}\n  }\n}\n`,
      "utf8",
    );

    const result = await load(main);
    expect(result.model.elements.user).toBeDefined();
  });

  it("preserves CRLF line endings while expanding includes", async () => {
    // Source written with \r\n line endings drives the CRLF branch of
    // expandDslIncludes' per-line walk (load.ts:269).
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-crlf-"));
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {\r\n` +
        `  model {\r\n` +
        `    a = softwareSystem "A"\r\n` +
        `    b = softwareSystem "B"\r\n` +
        `    a -> b "calls"\r\n` +
        `  }\r\n` +
        `}\r\n`,
      "utf8",
    );

    const result = await load(main);
    expect(result.model.elements.a?.relations[0]?.to).toBe("b");
  });

  it("throws on a self-referential !include cycle", async () => {
    // A file that includes itself trips the cycle guard (load.ts:259).
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-cycle-"));
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {\n  model {\n    !include workspace.dsl\n  }\n}\n`,
      "utf8",
    );

    await expect(load(main)).rejects.toThrow(/include cycle detected/);
  });

  it("names the missing !include target, not the workspace that references it", async () => {
    // Regression: the ENOENT of an include used to reach the CLI
    // indistinguishable from a missing entry point, so the diagnostic
    // blamed workspace.dsl — a file that is right there.
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-missing-inc-"));
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {\n  model {\n    !include parts/missing.dsl\n  }\n}\n`,
      "utf8",
    );

    const error = await load(main).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(IncludeNotFoundError);
    expect((error as IncludeNotFoundError).site).toEqual({
      missingPath: path.join(dir, "parts", "missing.dsl"),
      target: "parts/missing.dsl",
      includedFrom: main,
      line: 3,
      column: 5,
    });
  });

  it("throws a truncated, readable summary when a .dsl has many parse errors", async () => {
    // More than five parse errors exercise the slice(0,5) summary plus
    // the "...and N more" tail and the thrown wrapper
    // (load.ts:488-496).
    const dir = await mkdtemp(path.join(tmpdir(), "aact-struct-parseerr-"));
    const main = path.join(dir, "workspace.dsl");
    await writeFile(
      main,
      `workspace {
  model {
    a = @@@ "X"
    b = !!! "Y"
    c = ### "Z"
    d = $$$ "W"
    e = %%% "V"
    f = ^^^ "U"
    g = &&& "T"
  }
}`,
      "utf8",
    );

    await expect(load(main)).rejects.toThrow(/Failed to parse Structurizr DSL/);
    await expect(load(main)).rejects.toThrow(/and \d+ more\./);
  });
});
