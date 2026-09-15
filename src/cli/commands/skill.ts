import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";

import type { ArgsDef } from "citty";
import { defineCommand } from "citty";
import path from "pathe";

import { version } from "../../../package.json";
import type { Renderer } from "../output";
import { ToolError } from "../output";
import type { ExecuteResult } from "../run";
import { cliCommand } from "../run";
import { jsonArg } from "../sharedArgs";

const skillName = "aact-architect";
const markerFileName = ".aact-skill.json";
// The skill lives in its own repo so it can be updated without a CLI
// release. Byndyusoft/aact-architect-skill does not exist yet — point at
// the published one until the skill repo is transferred to the org, or
// `aact skill install` fails on a 404 clone.
const defaultRepo = "https://github.com/ChS23/aact-architect-skill.git";
const defaultRef = "main";

const clientValues = [
  "shared",
  "codex",
  "cursor",
  "copilot",
  "claude",
  "cline",
  "all",
] as const;

type ClientValue = (typeof clientValues)[number];
type TargetKind = "shared" | "claude" | "cline";

interface SkillMarker {
  readonly managedBy: "aact";
  readonly skill: typeof skillName;
  readonly client: TargetKind;
  readonly repo: string;
  readonly ref: string;
  readonly aactVersion: string;
  readonly installedAt: string;
}

export interface SkillInstallArgs {
  readonly client?: string;
  readonly codex?: boolean;
  readonly cursor?: boolean;
  readonly copilot?: boolean;
  readonly claude?: boolean;
  readonly cline?: boolean;
  readonly all?: boolean;
  readonly target?: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly force?: boolean;
  readonly "dry-run"?: boolean;
}

export interface InstallPlan {
  readonly kind: TargetKind;
  readonly label: string;
  readonly rootDir: string;
  readonly skillDir: string;
}

// -----------------------------------------------------------------------------
// Public data shape (envelope.data for `aact skill`)
// -----------------------------------------------------------------------------

export type SkillAction = "installed" | "updated" | "reinstalled";

export interface SkillPlanResult {
  readonly kind: TargetKind;
  readonly label: string;
  readonly skillDir: string;
  readonly action: SkillAction;
}

export interface SkillData {
  readonly skill: string;
  readonly repo: string;
  readonly ref: string;
  readonly dryRun: boolean;
  readonly plans: readonly SkillPlanResult[];
}

// -----------------------------------------------------------------------------
// Git runner injection (preserved for tests)
// -----------------------------------------------------------------------------

interface GitOptions {
  readonly cwd?: string;
}

type GitRunner = (
  args: readonly string[],
  options?: GitOptions,
) => Promise<void>;

interface InstallRuntime {
  readonly git: GitRunner;
  readonly now: () => Date;
}

const targetLabels: Record<TargetKind, string> = {
  shared: "Agent Skills",
  claude: "Claude Code",
  cline: "Cline",
};

const defaultRoots: Record<TargetKind, string> = {
  shared: "~/.agents/skills",
  claude: "~/.claude/skills",
  cline: "~/.cline/skills",
};

const sharedClientValues = new Set<ClientValue>([
  "shared",
  "codex",
  "cursor",
  "copilot",
]);

const defaultRuntime: InstallRuntime = {
  git: (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- This CLI intentionally invokes the user's git binary to clone/update the skill repository.
        "git",
        [...args],
        { cwd: options?.cwd },
        (error, _stdout, stderr) => {
          if (error) {
            const reason = stderr.trim() || error.message;
            reject(new Error(`git ${args.join(" ")} failed: ${reason}`));
            return;
          }
          resolve();
        },
      );
    }),
  now: () => new Date(),
};

// -----------------------------------------------------------------------------
// Plan resolution (unchanged from prior behaviour)
// -----------------------------------------------------------------------------

const isClientValue = (value: string): value is ClientValue =>
  clientValues.includes(value as ClientValue);

const expandHome = (input: string): string => {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
};

const resolveRootDir = (rootOrSkillDir: string): string => {
  const resolved = path.resolve(expandHome(rootOrSkillDir));
  return path.basename(resolved) === skillName
    ? path.dirname(resolved)
    : resolved;
};

const toSkillDir = (rootDir: string): string => path.join(rootDir, skillName);

const normalizeKind = (client: ClientValue): TargetKind[] => {
  if (client === "all") return ["shared", "claude", "cline"];
  if (sharedClientValues.has(client)) return ["shared"];
  if (client === "claude" || client === "cline") return [client];
  return ["shared"];
};

const selectedKinds = (args: SkillInstallArgs): TargetKind[] => {
  const out = new Set<TargetKind>();

  if (args.all) {
    for (const kind of normalizeKind("all")) out.add(kind);
  }

  if (args.client) {
    if (!isClientValue(args.client)) {
      throw new ToolError(
        "config.invalidSchema",
        `Unknown skill client "${args.client}". Expected one of: ${clientValues.join(", ")}.`,
        { client: args.client },
      );
    }
    for (const kind of normalizeKind(args.client)) out.add(kind);
  }

  if (args.codex) out.add("shared");
  if (args.cursor) out.add("shared");
  if (args.copilot) out.add("shared");
  if (args.claude) out.add("claude");
  if (args.cline) out.add("cline");

  if (out.size === 0) out.add("shared");
  return [...out];
};

export const createInstallPlans = (args: SkillInstallArgs): InstallPlan[] => {
  const kinds = selectedKinds(args);
  if (args.target && kinds.length > 1) {
    throw new ToolError(
      "config.missingOutputPath",
      "--target can be used with a single client target only. Remove --all or install clients one by one.",
    );
  }

  return kinds.map((kind) => {
    const rootDir = resolveRootDir(args.target ?? defaultRoots[kind]);
    return {
      kind,
      label: targetLabels[kind],
      rootDir,
      skillDir: toSkillDir(rootDir),
    };
  });
};

// -----------------------------------------------------------------------------
// Filesystem + git plumbing
// -----------------------------------------------------------------------------

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const readMarker = async (skillDir: string): Promise<SkillMarker | null> => {
  try {
    const content = await fs.readFile(
      path.join(skillDir, markerFileName),
      "utf8",
    );
    const parsed = JSON.parse(content) as Partial<SkillMarker>;
    if (parsed.managedBy === "aact" && parsed.skill === skillName) {
      return parsed as SkillMarker;
    }
  } catch {
    // Missing or malformed marker means the directory is unmanaged.
  }
  return null;
};

const writeMarker = async (
  plan: InstallPlan,
  repo: string,
  ref: string,
  runtime: InstallRuntime,
): Promise<void> => {
  const marker: SkillMarker = {
    managedBy: "aact",
    skill: skillName,
    client: plan.kind,
    repo,
    ref,
    aactVersion: version,
    installedAt: runtime.now().toISOString(),
  };
  await fs.writeFile(
    path.join(plan.skillDir, markerFileName),
    JSON.stringify(marker, undefined, 2) + "\n",
  );
};

const ensureSkillFile = async (skillDir: string): Promise<void> => {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!(await pathExists(skillFile))) {
    throw new ToolError(
      "skill.unmanagedDir",
      `Installed repository does not contain ${skillName}/SKILL.md at ${skillFile}.`,
      { skillDir },
    );
  }
};

const cloneSkill = async (
  plan: InstallPlan,
  repo: string,
  ref: string,
  runtime: InstallRuntime,
): Promise<void> => {
  await fs.mkdir(plan.rootDir, { recursive: true });
  await runtime.git([
    "clone",
    "--depth",
    "1",
    "--branch",
    ref,
    repo,
    plan.skillDir,
  ]);
  await ensureSkillFile(plan.skillDir);
};

const updateSkill = async (
  plan: InstallPlan,
  repo: string,
  ref: string,
  runtime: InstallRuntime,
): Promise<void> => {
  const marker = await readMarker(plan.skillDir);
  if (!marker) {
    throw new ToolError(
      "skill.unmanagedDir",
      `${plan.skillDir} already exists and is not managed by aact. Use --force to overwrite it.`,
      { skillDir: plan.skillDir },
    );
  }
  if (marker.repo !== repo) {
    throw new ToolError(
      "skill.repoMismatch",
      `${plan.skillDir} is managed by aact but was installed from ${marker.repo}. Use --force to reinstall from ${repo}.`,
      {
        skillDir: plan.skillDir,
        existingRepo: marker.repo,
        requestedRepo: repo,
      },
    );
  }
  if (!(await pathExists(path.join(plan.skillDir, ".git")))) {
    throw new ToolError(
      "skill.unmanagedDir",
      `${plan.skillDir} is managed by aact but is not a git checkout. Use --force to reinstall it.`,
      { skillDir: plan.skillDir },
    );
  }

  await runtime.git(["fetch", "--depth", "1", "origin", ref], {
    cwd: plan.skillDir,
  });
  await runtime.git(["checkout", "--force", "FETCH_HEAD"], {
    cwd: plan.skillDir,
  });
  await ensureSkillFile(plan.skillDir);
};

// -----------------------------------------------------------------------------
// Per-plan execution
// -----------------------------------------------------------------------------

interface PlanExecution {
  readonly action: SkillAction;
}

const installOnePlan = async (
  plan: InstallPlan,
  args: SkillInstallArgs,
  runtime: InstallRuntime,
): Promise<PlanExecution> => {
  const repo = args.repo ?? defaultRepo;
  const ref = args.ref ?? defaultRef;
  const dryRun = args["dry-run"] ?? false;
  const force = args.force ?? false;
  const exists = await pathExists(plan.skillDir);

  // Decide which action this plan will (or would) perform.
  let action: SkillAction;
  if (!exists) action = "installed";
  else if (force) action = "reinstalled";
  else action = "updated";

  if (dryRun) {
    return { action };
  }

  if (exists && force) {
    await fs.rm(plan.skillDir, { recursive: true, force: true });
  }

  if (exists && !force) {
    await updateSkill(plan, repo, ref, runtime);
    await writeMarker(plan, repo, ref, runtime);
    return { action: "updated" };
  }

  await cloneSkill(plan, repo, ref, runtime);
  await writeMarker(plan, repo, ref, runtime);
  return { action: exists && force ? "reinstalled" : "installed" };
};

// -----------------------------------------------------------------------------
// Pure executor
// -----------------------------------------------------------------------------

export const executeSkill = async (
  args: SkillInstallArgs,
  runtime: InstallRuntime = defaultRuntime,
): Promise<ExecuteResult<SkillData>> => {
  const repo = args.repo ?? defaultRepo;
  const ref = args.ref ?? defaultRef;
  const dryRun = args["dry-run"] ?? false;
  const plans = createInstallPlans(args);

  const results: SkillPlanResult[] = [];
  for (const plan of plans) {
    const exec = await installOnePlan(plan, args, runtime);
    results.push({
      kind: plan.kind,
      label: plan.label,
      skillDir: plan.skillDir,
      action: exec.action,
    });
  }

  return {
    data: {
      skill: skillName,
      repo,
      ref,
      dryRun,
      plans: results,
    },
    exitCode: 0,
  };
};

// Backward-compatible export (kept for any external test that imported it).
export const installAgentSkill = async (
  args: SkillInstallArgs,
  runtime: InstallRuntime = defaultRuntime,
): Promise<void> => {
  await executeSkill(args, runtime);
};

// -----------------------------------------------------------------------------
// Text rendering — mirrors current consola.info / consola.success messages
// -----------------------------------------------------------------------------

export const renderSkillText: Renderer<SkillData> = (envelope, sink) => {
  const { data } = envelope;
  sink.write(
    `Installing community ${data.skill} skill from ${data.repo} (${data.ref})\n`,
  );
  for (const plan of data.plans) {
    if (data.dryRun) {
      sink.write(
        `ℹ [dry run] ${plan.action} ${data.skill} for ${plan.label}: ${plan.skillDir}\n`,
      );
    } else {
      const verbs: Record<SkillAction, string> = {
        installed: "Installed",
        updated: "Updated",
        reinstalled: "Reinstalled",
      };
      sink.write(
        `✔ ${verbs[plan.action]} ${data.skill} for ${plan.label}: ${plan.skillDir}\n`,
      );
    }
  }
};

// -----------------------------------------------------------------------------
// Command definition
// -----------------------------------------------------------------------------

const installArgs = {
  ...jsonArg,
  client: {
    type: "enum",
    description:
      "Client target: shared, codex, cursor, copilot, claude, cline, all",
    options: [...clientValues],
  },
  codex: {
    type: "boolean",
    description: "Install into the shared ~/.agents/skills path used by Codex",
  },
  cursor: {
    type: "boolean",
    description: "Install into the shared ~/.agents/skills path used by Cursor",
  },
  copilot: {
    type: "boolean",
    description:
      "Install into the shared ~/.agents/skills path used by GitHub Copilot",
  },
  claude: {
    type: "boolean",
    description: "Install into ~/.claude/skills for Claude Code",
  },
  cline: {
    type: "boolean",
    description: "Install into ~/.cline/skills for Cline",
  },
  all: {
    type: "boolean",
    description: "Install shared, Claude Code, and Cline targets",
  },
  target: {
    type: "string",
    description: "Custom skills root or full skill directory",
  },
  repo: {
    type: "string",
    description: "Skill repository URL",
    default: defaultRepo,
  },
  ref: {
    type: "string",
    description: "Git branch or tag to install",
    default: defaultRef,
  },
  force: {
    type: "boolean",
    description: "Overwrite an existing unmanaged skill directory",
  },
  "dry-run": {
    type: "boolean",
    description: "Show target directories without writing files",
  },
} satisfies ArgsDef;

const install = cliCommand({
  name: "skill install",
  meta: {
    name: "install",
    description: "Install the community aact-architect skill for AI agents",
  },
  args: installArgs,
  renderText: renderSkillText,
  execute: (ctx) => executeSkill(ctx.args as SkillInstallArgs),
});

export const skill = defineCommand({
  meta: {
    name: "skill",
    description: "Install agent skills for aact workflows",
  },
  args: installArgs,
  default: "install",
  subCommands: { install },
});
