/**
 * Checks a document against an OpenAPI definition of the VSE, such as schemas/vse/ch-electricity-tariffs-openapi-1.0.1.yaml.
 * Information only: whether a utility's file follows the standard does not decide what this project
 * publishes. No Node APIs: pass the parsed OpenAPI document.
 */
import { Ajv, type ErrorObject } from "ajv";
import ajvFormats from "ajv-formats";

export const VSE_VERSIONS = ["1.0.0", "1.0.1"] as const;
export type VseVersion = (typeof VSE_VERSIONS)[number];

export interface OpenApiDocument {
  info: { version: string };
  components: { schemas: Record<string, unknown> };
}

/** Errors with the same rule and path, with array indices replaced by *. */
export interface ErrorGroup {
  path: string;
  message: string;
  count: number;
}

export interface Conformance {
  valid: boolean;
  errors: number;
  /** The most frequent groups of errors, at most MAX_GROUPS. */
  summary: ErrorGroup[];
}

const MAX_GROUPS = 10;

type AddFormats = (ajv: Ajv) => Ajv;
const addFormats = ((ajvFormats as unknown as { default?: AddFormats }).default ?? ajvFormats) as unknown as AddFormats;

function describe(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "enum") return `${error.message}: ${(params.allowedValues as unknown[]).join(", ")}`;
  return error.message ?? error.keyword;
}

/** A function that checks a tariff file against the TariffSubmission schema of the definition. */
export function vseValidator(spec: OpenApiDocument): (document: unknown) => Conformance {
  // OpenAPI 3.0 schemas are close to JSON Schema draft 7. Ajv knows nullable, and strict: false
  // lets it skip the OpenAPI-only keywords such as example.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({ $id: "vse", components: spec.components });
  const validate = ajv.getSchema("vse#/components/schemas/TariffSubmission");
  if (!validate) throw new Error(`no TariffSubmission in VSE definition ${spec.info.version}`);
  return (document) => {
    if (validate(document)) return { valid: true, errors: 0, summary: [] };
    const groups = new Map<string, ErrorGroup>();
    for (const error of validate.errors ?? []) {
      const path = error.instancePath.slice(1).replace(/\/\d+(?=\/|$)/g, "/*");
      const message = describe(error);
      const key = `${path}\n${message}`;
      const group = groups.get(key) ?? { path, message, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    const summary = [...groups.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, MAX_GROUPS);
    return { valid: false, errors: validate.errors?.length ?? 0, summary };
  };
}
