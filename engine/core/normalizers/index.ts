import * as genericVse from "./generic-vse.ts";

export type DynamicNormalizer = typeof genericVse;

/** Maps "normalizer" in config/source.json to its module. */
export const DYNAMIC_NORMALIZERS: Record<string, DynamicNormalizer> = {
  generic_vse: genericVse,
};

export { repairStatic } from "./static-vse.ts";
