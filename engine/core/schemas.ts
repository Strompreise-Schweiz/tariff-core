/**
 * JSON Schema checks with Ajv. The schemas are imported as modules, so this file runs unchanged in
 * Node and in a bundled website. No Node APIs.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";

import curation from "../../schemas/curation/v1.schema.json" with { type: "json" };
import dynamicDay from "../../schemas/dynamic-day/v1.schema.json" with { type: "json" };
import overallIndex from "../../schemas/overall-index/v1.schema.json" with { type: "json" };
import sourceConfig from "../../schemas/source-config/v1.schema.json" with { type: "json" };
import supplier from "../../schemas/supplier/v1.schema.json" with { type: "json" };
import tariffDocument from "../../schemas/tariff-document/v1.schema.json" with { type: "json" };

import type { Issue } from "./types.ts";

export const SCHEMAS = {
  curation,
  "dynamic-day": dynamicDay,
  "overall-index": overallIndex,
  "source-config": sourceConfig,
  supplier,
  "tariff-document": tariffDocument,
};

export type SchemaName = keyof typeof SCHEMAS;

// ajv-formats is CommonJS: Node passes module.exports as default, bundlers may pass the namespace.
type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats = ((ajvFormats as unknown as { default?: AddFormats }).default ?? ajvFormats) as unknown as AddFormats;

let ajv: Ajv2020 | undefined;
const validators = new Map<SchemaName, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  if (!ajv) {
    // strict: false, because the schemas carry annotations such as $comment and examples.
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
  }
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.getSchema(SCHEMAS[name].$id);
    if (!validate) throw new Error(`schema ${name} not found`);
    validators.set(name, validate);
  }
  return validate;
}

function message(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const text = error.message ?? error.keyword;
  if (error.keyword === "additionalProperties") return `${text}: ${params.additionalProperty}`;
  if (error.keyword === "enum") return `${text}: ${JSON.stringify(params.allowedValues)}`;
  return text;
}

/** Schema violations of a document, sorted by path such as tariffs/3/startDate. */
export function schemaIssues(instance: unknown, name: SchemaName): Issue[] {
  const validate = validatorFor(name);
  if (validate(instance)) return [];
  return (validate.errors ?? [])
    .map((error): Issue => ({
      severity: "error",
      code: "schema",
      path: error.instancePath.slice(1).replaceAll("~1", "/").replaceAll("~0", "~"),
      message: message(error),
    }))
    .sort((a, b) => a.path!.localeCompare(b.path!, "en", { numeric: true }));
}
