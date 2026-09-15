import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

// End-to-end CLI tests. These spawn the built CLI binary (`dist/cli/index.mjs`)
// as a real subprocess in a clean temp directory, exercising the same code
// path that `npx aact` triggers for end users. Catches package-level
// regressions that unit tests miss: bin shebang, exports field, runtime
// resolution of bundled deps, init-template correctness, exit codes, etc.
//
// The full demo loop (`init` → `check` reports a violation → `check --fix`
// applies it → `check` reports clean) is the user-facing contract for
// the Quick Start in the README and the SKILL.md workflow A.

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli", "index.mjs");

let workDir: string;

beforeAll(async () => {
  // Make sure the CLI is built. Test assumes consumer has run `pnpm build`
  // (CI typically does). If dist/ is stale we skip rather than build
  // implicitly — building inside tests masks build failures.
  try {
    await fs.access(CLI_PATH);
  } catch {
    throw new Error(
      `CLI not built at ${CLI_PATH}. Run \`pnpm build\` before \`pnpm test:e2e\`.`,
    );
  }
});

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "aact-e2e-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

const runCli = (args: string[]) =>
  execa("node", [CLI_PATH, ...args], { cwd: workDir, reject: false });

describe("aact init", () => {
  it("creates aact.config.ts and architecture.puml in cwd", async () => {
    const result = await runCli(["init"]);
    expect(result.exitCode).toBe(0);

    const files = await fs.readdir(workDir);
    expect(files).toContain("aact.config.ts");
    expect(files).toContain("architecture.puml");
  });

  it("config template uses `import type` so npx flow works without local install", async () => {
    await runCli(["init"]);
    const config = await fs.readFile(
      path.join(workDir, "aact.config.ts"),
      "utf8",
    );
    expect(config).toContain('import type { AactConfig } from "aact"');
    // Should NOT contain runtime `import { defineConfig }` — that would
    // require resolving "aact" at runtime and break the npx-only flow.
    expect(config).not.toMatch(/^import\s*\{\s*defineConfig\s*\}/m);
  });

  it("does not overwrite existing files on re-run", async () => {
    await runCli(["init"]);
    await fs.writeFile(
      path.join(workDir, "aact.config.ts"),
      "// user-modified",
    );
    const result = await runCli(["init"]);
    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(workDir, "aact.config.ts"),
      "utf8",
    );
    expect(config).toBe("// user-modified");
  });

  it("--json emits envelope with created paths", async () => {
    const result = await runCli(["init", "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("init");

    const data = envelope.data as Record<string, unknown>;
    const created = data.created as Array<Record<string, unknown>>;
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.kind).sort()).toEqual([
      "architecture",
      "config",
    ]);
  });

  it("--json reports skipped entries on second run", async () => {
    await runCli(["init"]);
    const result = await runCli(["init", "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    expect((data.created as unknown[]).length).toBe(0);
    expect((data.skipped as unknown[]).length).toBe(2);
  });
});

describe("aact check", () => {
  interface JsonEditLocation {
    readonly file: string;
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  }

  interface JsonEdit {
    readonly kind: string;
    readonly range?: JsonEditLocation;
    readonly anchor?: JsonEditLocation;
    readonly content?: string;
  }

  interface JsonFix {
    readonly ruleId: string;
    readonly edits: readonly JsonEdit[];
  }

  const editKey = (edit: JsonEdit): string => {
    const loc = edit.range ?? edit.anchor;
    if (!loc) throw new Error(`edit ${edit.kind} has no location`);
    return `${edit.kind}:${loc.file}:${loc.start.offset}:${loc.end.offset}:${edit.content ?? ""}`;
  };

  it("reports the seeded CRUD violation from the starter architecture", async () => {
    await runCli(["init"]);
    const result = await runCli(["check"]);
    // Default starter has one intentional CRUD violation.
    expect(result.exitCode).toBe(1);
    const output = (result.stdout + result.stderr).toLowerCase();
    expect(output).toContain("crud");
    expect(output).toContain("orders");
  });

  it("emits a friendly error and exits 2 when source file is missing", async () => {
    await runCli(["init"]);
    await fs.rm(path.join(workDir, "architecture.puml"));
    const result = await runCli(["check"]);
    // Tool error (missing source) → exit 2; distinct from domain failure (exit 1)
    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/architecture file not found/i);
    // Should NOT be a raw Node stack trace.
    expect(output).not.toContain("at Object.<anonymous>");
  });

  it("--json emits a v1 envelope with violations and summary", async () => {
    await runCli(["init"]);
    const result = await runCli(["check", "--json"]);
    expect(result.exitCode).toBe(1);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("check");
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(1);

    const data = envelope.data as Record<string, unknown>;
    expect(data.mode).toBe("check");
    expect(Array.isArray(data.violations)).toBe(true);
    expect((data.violations as unknown[]).length).toBeGreaterThan(0);
    expect(data).toHaveProperty("suggestedFixes");
    expect(data).toHaveProperty("summary");
  });

  it("--dry-run exits 1 when violations remain (Codex P1 fix)", async () => {
    await runCli(["init"]);
    const result = await runCli(["check", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    expect(data.mode).toBe("dry-run");
  });

  it("--dry-run deduplicates identical starter edits across rules", async () => {
    await runCli(["init"]);
    const result = await runCli(["check", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    const fixes = data.suggestedFixes as readonly JsonFix[];
    const edits = fixes.flatMap((fix) => fix.edits);
    const editKeys = edits.map(editKey);

    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.ruleId).toBe("crud");
    expect(new Set(editKeys).size).toBe(editKeys.length);
  });

  it("--fix exits 0 when all violations are fixed", async () => {
    await runCli(["init"]);
    const result = await runCli(["check", "--fix", "--json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    expect(data.mode).toBe("fix");
    expect(data.violations).toEqual([]);
    expect(data.summary).toMatchObject({ failed: 0, violations: 0 });
    const fixesApplied = data.fixesApplied as Record<string, unknown>;
    expect(fixesApplied).toBeDefined();
    expect(fixesApplied.remaining).toBe(0);
    expect(fixesApplied.count).toBe(1);
    expect(fixesApplied.before).toMatchObject({
      summary: { failed: 2, violations: 2 },
    });
    const diagnostics = envelope.diagnostics as
      | readonly { readonly kind: string }[]
      | undefined;
    expect(diagnostics?.some((d) => d.kind === "fix.editConflict")).toBe(false);
  });

  it("--help prints the available options", async () => {
    const result = await runCli(["check", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--fix");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--json");
  });
});

describe("aact analyze", () => {
  it("renders metrics as text by default", async () => {
    await runCli(["init"]);
    const result = await runCli(["analyze"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Elements:");
    expect(result.stdout).toContain("Relations:");
    expect(result.stdout).toContain("Databases:");
    expect(result.stdout).toContain("Cycles:");
  });

  it("--json emits a v1 envelope on stdout with AnalysisReport data", async () => {
    await runCli(["init"]);
    const result = await runCli(["analyze", "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("analyze");
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);

    const data = envelope.data as Record<string, unknown>;
    expect(data).toHaveProperty("elementsCount");
    expect(data).toHaveProperty("elementsByKind");
    expect(data).toHaveProperty("relationsByStyle");
    expect(data).toHaveProperty("databases");
    expect(data).toHaveProperty("boundaries");
    expect(data).toHaveProperty("fanIn");
    expect(data).toHaveProperty("fanOut");
    expect(data).toHaveProperty("cycles");

    const meta = envelope.meta as Record<string, unknown>;
    expect(meta).toHaveProperty("aactVersion");
    expect(meta).toHaveProperty("durationMs");
    expect(typeof meta.durationMs).toBe("number");
  });

  it("--json exits 2 on missing source file (tool error, not domain failure)", async () => {
    await runCli(["init"]);
    await fs.rm(path.join(workDir, "architecture.puml"));
    const result = await runCli(["analyze", "--json"]);

    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();

    const diag = (envelope.diagnostics as Array<Record<string, unknown>>)[0];
    expect(diag.kind).toBe("model.sourceNotFound");
  });

  it("--json exits 2 when no config / config schema invalid (tool error)", async () => {
    // c12 returns {} when no config file is found; valibot then rejects on
    // the missing `source` field. Either kind signals a tool-level failure
    // distinct from domain violations.
    const result = await runCli(["analyze", "--json"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const kind = (envelope.diagnostics as Array<Record<string, unknown>>)[0]
      .kind;
    expect(kind).toMatch(/^config\.(missingSource|invalidSchema|loadFailed)$/);
  });
});

describe("aact model", () => {
  it("renders the normalized model as text by default", async () => {
    await runCli(["init"]);
    const result = await runCli(["model"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Elements:");
    expect(result.stdout).toContain("Boundaries:");
    expect(result.stdout).toContain("Relations:");
  });

  it("--json emits a v1 envelope on stdout with full Model + issues", async () => {
    await runCli(["init"]);
    const result = await runCli(["model", "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("model");
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);

    const data = envelope.data as Record<string, unknown>;
    expect(data).toHaveProperty("model");
    expect(data).toHaveProperty("issues");
    const model = data.model as Record<string, unknown>;
    expect(model).toHaveProperty("elements");
    expect(model).toHaveProperty("boundaries");
    expect(model).toHaveProperty("rootBoundaryNames");
  });

  it("--json survives a pipe larger than the 64 KB pipe buffer", async () => {
    // Regression: `process.exit` right after an async write dropped
    // everything stdout still had buffered, so a piped consumer got the
    // envelope cut at exactly 65536 bytes — invalid JSON. Only a real
    // subprocess with a piped stdout reproduces it; a TTY or a file
    // redirect writes synchronously and hides the bug.
    const containers = Array.from(
      { length: 300 },
      (_, i) =>
        `  Container(svc${i}, "Service ${i}", "Node.js", "Does thing ${i} with a description long enough to inflate the payload")`,
    ).join("\n");
    const relations = Array.from(
      { length: 299 },
      (_, i) => `Rel(svc${i}, svc${i + 1}, "calls ${i}", "HTTP/JSON")`,
    ).join("\n");
    await fs.writeFile(
      path.join(workDir, "big.puml"),
      `@startuml\nSystem_Boundary(sb, "Shop") {\n${containers}\n}\n${relations}\n@enduml\n`,
    );

    const result = await runCli(["model", "big.puml", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as { model: { elements: object } };
    expect(Object.keys(data.model.elements)).toHaveLength(300);
  });

  it("--json names the missing !include, not the entry point", async () => {
    await fs.writeFile(
      path.join(workDir, "main.puml"),
      `@startuml\n!include partials/missing.puml\nContainer(api, "API")\n@enduml\n`,
    );

    const result = await runCli(["model", "main.puml", "--json"]);

    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      diagnostics: {
        kind: string;
        message: string;
        context: Record<string, string>;
      }[];
    };
    const diagnostic = envelope.diagnostics[0];
    expect(diagnostic.kind).toBe("model.includeNotFound");
    expect(diagnostic.message).toContain("partials/missing.puml");
    expect(diagnostic.context.includedFrom).toContain("main.puml");
    expect(diagnostic.context.line).toBe("2");
  });

  it("--json exits 2 on missing source file (model command never crashes)", async () => {
    await runCli(["init"]);
    await fs.rm(path.join(workDir, "architecture.puml"));
    const result = await runCli(["model", "--json"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.data).toBeNull();
  });
});

describe("aact diff", () => {
  const SIMPLE_PUML = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
Container(svc, "Service")
@enduml`;

  const SIMPLE_PUML_PLUS = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
Container(svc, "Service")
Container(extra, "Extra")
@enduml`;

  it("exits 0 when models are identical", async () => {
    await fs.writeFile(path.join(workDir, "a.puml"), SIMPLE_PUML);
    const result = await runCli(["diff", "a.puml", "a.puml"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No structural changes");
  });

  it("exits 1 and shows added element when models differ structurally", async () => {
    await fs.writeFile(path.join(workDir, "base.puml"), SIMPLE_PUML);
    await fs.writeFile(path.join(workDir, "curr.puml"), SIMPLE_PUML_PLUS);
    const result = await runCli(["diff", "base.puml", "curr.puml"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("extra");
    expect(result.stdout).toContain("Element");
  });

  it("--json emits a v1 envelope with DiffData shape", async () => {
    await fs.writeFile(path.join(workDir, "base.puml"), SIMPLE_PUML);
    await fs.writeFile(path.join(workDir, "curr.puml"), SIMPLE_PUML_PLUS);
    const result = await runCli(["diff", "base.puml", "curr.puml", "--json"]);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("changes");
    expect(data).toHaveProperty("baseline");
    expect(data).toHaveProperty("current");
    const summary = data.summary as Record<string, unknown>;
    expect(summary).toHaveProperty("headline");
    expect(summary).toHaveProperty("bySeverity");
  });

  it("falls back to aact.config.ts source when current is omitted", async () => {
    await runCli(["init"]);
    // Use init's architecture.puml as baseline; current is implicit
    // from config (same file → no diff).
    const baselinePath = path.join(workDir, "architecture.puml");
    const result = await runCli(["diff", baselinePath]);
    expect(result.exitCode).toBe(0);
  });

  it("--json envelope.meta.configPath reflects resolved aact.config.ts when current is implicit", async () => {
    await runCli(["init"]);
    const baselinePath = path.join(workDir, "architecture.puml");
    const result = await runCli(["diff", baselinePath, "--json"]);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const meta = envelope.meta as Record<string, unknown>;
    expect(meta.configPath).toMatch(/aact\.config\.ts$/);
  });

  it("exits 2 (tool error) when baseline file does not exist", async () => {
    const result = await runCli(["diff", "no-such-file.puml", "x.puml"]);
    expect(result.exitCode).toBe(2);
  });

  it("--with-patch includes RFC 6902 patch in the envelope", async () => {
    await fs.writeFile(path.join(workDir, "base.puml"), SIMPLE_PUML);
    await fs.writeFile(path.join(workDir, "curr.puml"), SIMPLE_PUML_PLUS);
    const result = await runCli([
      "diff",
      "base.puml",
      "curr.puml",
      "--json",
      "--with-patch",
    ]);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;
    expect(data).toHaveProperty("patch");
    expect(Array.isArray(data.patch)).toBe(true);
  });

  it("rejects --rename-threshold values with numeric suffixes", async () => {
    await fs.writeFile(path.join(workDir, "a.puml"), SIMPLE_PUML);
    const result = await runCli([
      "diff",
      "a.puml",
      "a.puml",
      "--rename-threshold",
      "0.7abc",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const diag = (envelope.diagnostics as Array<Record<string, unknown>>)[0];
    expect(diag.kind).toBe("config.invalidSchema");
  });
});

describe("aact check --fix demo loop", () => {
  it("init → check reports violation → fix applies → re-check is clean", async () => {
    await runCli(["init"]);

    const firstCheck = await runCli(["check"]);
    expect(firstCheck.exitCode).toBe(1);

    const archBefore = await fs.readFile(
      path.join(workDir, "architecture.puml"),
      "utf8",
    );

    const fixResult = await runCli(["check", "--fix"]);
    expect(fixResult.exitCode).toBe(0);

    // The fix surface is the file write — consola's "Applied N fix(es)"
    // message goes through a TTY-aware path that swallows when piped, so
    // we assert observable state instead of stdout text.
    const archAfter = await fs.readFile(
      path.join(workDir, "architecture.puml"),
      "utf8",
    );
    expect(archAfter).not.toBe(archBefore);
    expect(archAfter).toContain("orders_repo"); // new repo container injected

    const secondCheck = await runCli(["check"]);
    expect(secondCheck.exitCode).toBe(0);
  });
});

describe("aact check — customRules", () => {
  // Inline custom rule в config — без "aact" runtime import'а (тестовый
  // tempdir без `npm install`). Реальные user'ы импортят defineRule из
  // "aact" — see examples/custom-rules/.
  const inlineRuleConfig = `
const noDeprecatedTag = {
  name: "noDeprecatedTag",
  description: "Containers must not carry deprecated tag",
  check(model) {
    return Object.values(model.elements)
      .filter((c) => c.tags.includes("deprecated"))
      .map((c) => ({ target: c.name, targetKind: "element" as const, message: 'has "deprecated" tag' }));
  },
};

export default {
  source: "./architecture.puml",
  customRules: [noDeprecatedTag],
  rules: { crud: false, acl: false, acyclic: false, dbPerService: false },
};
`;

  const archWithDeprecated = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

Container(svc_a, "Service A", "Node.js")
Container(legacy_svc, "Legacy", "Java 6", $tags="deprecated")

Rel(svc_a, legacy_svc, "HTTP")
@enduml
`;

  it("runs inline custom rule and reports its violations", async () => {
    await fs.writeFile(path.join(workDir, "aact.config.ts"), inlineRuleConfig);
    await fs.writeFile(
      path.join(workDir, "architecture.puml"),
      archWithDeprecated,
    );

    const result = await runCli(["check"]);
    expect(result.exitCode).toBe(1);
    const output = (result.stdout + result.stderr).toLowerCase();
    expect(output).toContain("nodeprecatedtag");
    expect(output).toContain("legacy_svc");
  });

  it("passes when custom rule disabled via rules.<name>: false", async () => {
    const disabledConfig = inlineRuleConfig.replace(
      "rules: { crud: false",
      "rules: { noDeprecatedTag: false, crud: false",
    );
    await fs.writeFile(path.join(workDir, "aact.config.ts"), disabledConfig);
    await fs.writeFile(
      path.join(workDir, "architecture.puml"),
      archWithDeprecated,
    );

    const result = await runCli(["check"]);
    expect(result.exitCode).toBe(0);
  });

  it("errors when custom rule name collides with built-in", async () => {
    const conflictConfig = `
const collide = {
  name: "acl",
  description: "collides with built-in",
  check: () => [],
};
export default {
  source: "./architecture.puml",
  customRules: [collide],
};
`;
    await fs.writeFile(path.join(workDir, "aact.config.ts"), conflictConfig);
    await fs.writeFile(
      path.join(workDir, "architecture.puml"),
      archWithDeprecated,
    );

    const result = await runCli(["check"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/conflicts with existing built-in/i);
  });

  it("rejects an unknown rule name in config.rules (exit 2)", async () => {
    const configWithTypo = `
export default {
  source: "./architecture.puml",
  rules: { typoRule: true, crud: false },
};
`;
    await fs.writeFile(path.join(workDir, "aact.config.ts"), configWithTypo);
    await fs.writeFile(
      path.join(workDir, "architecture.puml"),
      archWithDeprecated,
    );

    const result = await runCli(["check"]);
    const output = result.stdout + result.stderr;
    expect(result.exitCode).toBe(2);
    expect(output).toContain("typoRule");
  });
});

describe("aact rule list", () => {
  it("lists built-in rules without config", async () => {
    const result = await runCli(["rule", "list"]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Built-in");
    expect(output).toContain("acl");
    expect(output).toContain("acyclic");
  });

  it("includes custom rules from loaded config", async () => {
    const inlineRuleConfig = `
const noLegacy = {
  name: "noLegacy",
  description: "no legacy",
  check: () => [],
};
export default {
  source: "./architecture.puml",
  customRules: [noLegacy],
};
`;
    await fs.writeFile(path.join(workDir, "aact.config.ts"), inlineRuleConfig);
    await fs.writeFile(
      path.join(workDir, "architecture.puml"),
      "@startuml\n@enduml\n",
    );

    const result = await runCli(["rule", "list"]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Custom");
    expect(output).toContain("noLegacy");
  });

  it("emits a v1 envelope with rules[] when --json flag set", async () => {
    const result = await runCli(["rule", "list", "--json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("rule list");

    const data = envelope.data as Record<string, unknown>;
    const rules = data.rules as Array<Record<string, unknown>>;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules[0]).toHaveProperty("ruleId");
    expect(rules[0]).toHaveProperty("source");
    expect(rules[0]).toHaveProperty("enabled");
    expect(rules[0]).toHaveProperty("hasFix");

    const summary = data.summary as Record<string, unknown>;
    expect(summary.total).toBeGreaterThan(0);
  });

  it("--config exits 2 when config file is broken (no silent fallback)", async () => {
    await fs.writeFile(
      path.join(workDir, "broken.config.ts"),
      "export default { source: 123 };",
    );
    const result = await runCli([
      "rule",
      "list",
      "--config",
      "./broken.config.ts",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.exitCode).toBe(2);
  });
});

describe("aact generate", () => {
  it("streams plantuml to stdout by default (UNIX pipe)", async () => {
    await runCli(["init"]);
    const result = await runCli(["generate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@startuml");
    expect(result.stdout).toContain("@enduml");
  });

  it("writes plantuml to --output file", async () => {
    await runCli(["init"]);
    const outFile = path.join(workDir, "out.puml");
    const result = await runCli(["generate", "--output", outFile]);
    expect(result.exitCode).toBe(0);
    const written = await fs.readFile(outFile, "utf8");
    expect(written).toContain("@startuml");
  });

  it("accepts a positional source without a config file", async () => {
    await runCli(["init"]);
    await fs.rm(path.join(workDir, "aact.config.ts"));

    const outFile = path.join(workDir, "positional.puml");
    const result = await runCli([
      "generate",
      "architecture.puml",
      "--output",
      outFile,
      "--json",
    ]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("generate");
    expect(envelope.ok).toBe(true);

    const written = await fs.readFile(outFile, "utf8");
    expect(written).toContain("@startuml");
  });

  it("--json + --output emits envelope on stdout, artefact on disk", async () => {
    await runCli(["init"]);
    const outFile = path.join(workDir, "out.puml");
    const result = await runCli(["generate", "--json", "--output", outFile]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("generate");
    expect(envelope.ok).toBe(true);

    const data = envelope.data as Record<string, unknown>;
    expect(data.outputSink).toBe("file");
    expect(data.outputPath).toBe(outFile);

    const written = await fs.readFile(outFile, "utf8");
    expect(written).toContain("@startuml");
  });

  it("--json without --output exits 2 (stdout collision)", async () => {
    await runCli(["init"]);
    const result = await runCli(["generate", "--json"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const diag = (envelope.diagnostics as Array<Record<string, unknown>>)[0];
    expect(diag.kind).toBe("config.outputCollidesWithJson");
  });

  it("config output.mode json without --output exits 2 (stdout collision)", async () => {
    await runCli(["init"]);
    await fs.writeFile(
      path.join(workDir, "aact.config.ts"),
      'export default { source: "./architecture.puml", output: { mode: "json" } };\n',
    );
    // No --json flag — the collision must be caught from config.output.mode.
    const result = await runCli(["generate"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const diag = (envelope.diagnostics as Array<Record<string, unknown>>)[0];
    expect(diag.kind).toBe("config.outputCollidesWithJson");
  });
});

describe("aact skill", () => {
  it("defaults to install and accepts install options", async () => {
    const targetRoot = path.join(workDir, "skills");
    const result = await runCli(["skill", "--dry-run", "--target", targetRoot]);

    expect(result.exitCode).toBe(0);
    await expect(
      fs.access(path.join(targetRoot, "aact-architect")),
    ).rejects.toThrow();
  });

  it("--json emits envelope with plans (dry-run, no fs side-effects)", async () => {
    const targetRoot = path.join(workDir, "skills");
    const result = await runCli([
      "skill",
      "--dry-run",
      "--target",
      targetRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe("skill install");

    const data = envelope.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.skill).toBe("aact-architect");
    expect(data.repo).toMatch(/^https?:\/\//);

    const plans = data.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0].action).toBe("installed");
    expect(plans[0].kind).toBe("shared");

    await expect(
      fs.access(path.join(targetRoot, "aact-architect")),
    ).rejects.toThrow();
  });
});

describe("aact --help / --version", () => {
  it("--help lists the user-facing subcommands", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("check");
    expect(result.stdout).toContain("analyze");
    expect(result.stdout).toContain("generate");
    expect(result.stdout).toContain("skill");
  });

  it("--help reports a version that matches package.json", async () => {
    const result = await runCli(["--help"]);
    const pkg = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(result.stdout).toContain(pkg.version);
  });
});
