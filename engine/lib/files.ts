/** Reading and writing repo files. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { DynamicDay } from "../core/types.ts";

export const exists = existsSync;

export function isDirectory(file: string): boolean {
  return existsSync(file) && statSync(file).isDirectory();
}

/** All files below a folder, sorted by path. Empty if the folder does not exist. */
export function filesBelow(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** Names of the entries in a folder that match a pattern, sorted. Empty if the folder does not exist. */
export function namesIn(dir: string, pattern: RegExp): string[] {
  return isDirectory(dir) ? readdirSync(dir).filter((name) => pattern.test(name)).sort() : [];
}

/** Parse JSON. A UTF-8 byte order mark is allowed, as some utilities send one. */
export function parseJson<T = unknown>(data: Buffer | string): T {
  const text = typeof data === "string" ? data : data.toString("utf8");
  return JSON.parse(text.replace(/^﻿/, ""));
}

export function readJson<T = unknown>(file: string): T {
  return parseJson<T>(readFileSync(file));
}

/** Read a JSON file, or undefined if it does not exist. */
export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

/** Write bytes, creating folders. Text files end with a newline. */
export function writeFile(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(data);
  writeFileSync(file, bytes.at(-1) === 0x0a ? bytes : Buffer.concat([bytes, Buffer.from("\n")]));
}

export function writeJson(file: string, value: unknown): void {
  writeFile(file, JSON.stringify(value, null, 2));
}

/**
 * Write a VSE day document with one interval per line. That keeps files about half the size of
 * indented JSON and keeps git diffs readable.
 */
export function writeDayFile(file: string, document: DynamicDay): void {
  const { prices, ...head } = document;
  const lines = prices.map((interval) => JSON.stringify(interval)).join(",\n    ");
  writeFile(file, `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "prices": [\n    ${lines}\n  ]\n}\n`);
}
