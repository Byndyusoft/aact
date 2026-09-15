/**
 * Raised when a local `!include` target doesn't exist on disk.
 *
 * Both include-expanding loaders (C4-PlantUML, Structurizr DSL) read the
 * entry-point file and then recursively read whatever it pulls in. A
 * plain ENOENT from that recursion is indistinguishable from ENOENT on
 * the entry point itself, so the CLI used to report "Architecture file
 * not found: <entry point>" while the entry point was sitting right
 * there — the one file the user did NOT need to fix. This error carries
 * the missing target plus the exact directive site that referenced it,
 * so the diagnostic names the file to create.
 */
export interface IncludeSite {
  /** Absolute path the directive resolved to — the file that's missing. */
  readonly missingPath: string;
  /** Target exactly as written in the directive. */
  readonly target: string;
  /** Absolute path of the file holding the directive. */
  readonly includedFrom: string;
  /** 1-based line of the directive inside `includedFrom`. */
  readonly line: number;
  /** 1-based column of the `!` inside `includedFrom`. */
  readonly column: number;
}

export class IncludeNotFoundError extends Error {
  readonly site: IncludeSite;

  constructor(site: IncludeSite, formatLabel: string) {
    super(
      `${formatLabel} !include target not found: ${site.missingPath} ` +
        `(included from ${site.includedFrom}:${site.line}:${site.column} as "${site.target}")`,
    );
    this.name = "IncludeNotFoundError";
    this.site = site;
  }
}

const isEnoent = (err: unknown): err is NodeJS.ErrnoException =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Maps whatever a recursive include expansion threw onto the error to
 * re-throw: the ENOENT of *this* directive's target becomes an
 * `IncludeNotFoundError`. Errors from deeper levels (already an
 * `IncludeNotFoundError`, parse failures, cycles) pass through untouched,
 * so the innermost site wins.
 */
export const toIncludeError = (
  error: unknown,
  site: IncludeSite,
  formatLabel: string,
): unknown => {
  if (error instanceof IncludeNotFoundError) return error;
  if (isEnoent(error)) return new IncludeNotFoundError(site, formatLabel);
  return error;
};
