/** Reading the stored responses of a price source in data/sources/days/<id>/. */
import { readFileSync } from "node:fs";

import { checkDay, readResponse, splitByDay, type ApiResponse } from "../core/price-day.ts";
import type { DayCheck, PriceInterval, PriceSource } from "../core/types.ts";
import { exists, parseJson } from "./files.ts";
import { dayPath, paths } from "./repo.ts";

export interface StoredDay {
  publication_timestamp: string | null;
  prices: PriceInterval[];
  notes: string[];
  check: DayCheck;
}

/** The intervals of one day in a response, and their check. A response can hold several days. */
export function dayOf(bytes: Buffer, source: PriceSource, day: string): StoredDay {
  const raw = parseJson<ApiResponse>(bytes);
  const { prices, notes } = readResponse(raw, source);
  const ofDay = splitByDay(prices).get(day) ?? [];
  return { publication_timestamp: raw.publication_timestamp ?? null, prices: ofDay, notes, check: checkDay(day, ofDay) };
}

/** The stored response for a day, read and checked, or undefined if there is none. */
export function storedDay(root: string, source: PriceSource, day: string): StoredDay | undefined {
  const file = dayPath(paths.daySources(root, source.id), day);
  return exists(file) ? dayOf(readFileSync(file), source, day) : undefined;
}
