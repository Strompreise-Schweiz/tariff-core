/**
 * Everything that also runs in the browser: types, repairs, curation, product proposals and
 * validation. A website imports from here to check a file with the same rules as the workflows.
 */
export * from "./types.ts";
export { applyCuration, assignIds } from "./curation.ts";
export { suggestProducts } from "./products.ts";
export { repairStatic } from "./normalizers/static-vse.ts";
export { applyWaivers, coverageProblems, documentIssues, dynamicDayIssues, hubIssues, schemaIssues, tariffIssues } from "./rules.ts";
