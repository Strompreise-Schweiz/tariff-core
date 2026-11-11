/** Command line arguments and output, including GitHub Actions annotations. */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import type { Issue } from "../core/types.ts";

export const NO_UTILITY = "no config/source.json here and no utilities/<slug>/config/source.json";

/** Print a message and surface it as a GitHub Actions annotation. */
export function annotate(level: "error" | "warning", message: string): void {
  const line = process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `[${level}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Print the issues. Returns the number of errors. */
export function report(issues: Issue[], label: string): number {
  let errors = 0;
  for (const issue of issues) {
    if (issue.severity === "accepted") continue;
    const where = issue.tariff ?? issue.path ?? "";
    annotate(issue.severity, `${label} [${issue.code}] ${where}: ${issue.message}`);
    if (issue.severity === "error") errors += 1;
  }
  return errors;
}

/** Parse the arguments. --help prints usage and exits. */
export function parseCli<T extends ParseArgsOptionsConfig>(usage: string, options: T, args = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true });
    if ((parsed.values as { help?: boolean }).help) {
      console.log(usage.trim());
      process.exit(0);
    }
    return parsed;
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage.trim()}`);
    process.exit(2);
  }
}
