/**
 * Instants with their UTC offset, and Swiss calendar days. A Swiss day lasts 23, 24 or 25 hours.
 *
 * Uses Intl for the Europe/Zurich offset, which every browser has. No Node APIs.
 */

/** One instant, and the offset in minutes east of UTC it is shown with. */
export interface Moment {
  ms: number;
  offset: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ISO 8601 timestamp. A timestamp without offset is rejected: during the autumn clock
 * change the local hour 02:00-03:00 occurs twice, so it cannot identify one instant.
 */
export function parseTimestamp(value: string): Moment {
  const match = ISO.exec(value);
  if (!match) throw new Error(`invalid timestamp: ${value}`);
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone] = match;
  if (!zone) throw new Error(`timestamp without UTC offset: ${value}`);
  const offset = zone === "Z" ? 0
    : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const wall = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second, Math.floor(Number(`0.${fraction}`) * 1000));
  const check = new Date(wall);
  if (check.getUTCDate() !== +day || check.getUTCHours() !== +hour || check.getUTCMinutes() !== +minute) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return { ms: wall - offset * 60_000, offset };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 with offset, such as 2026-07-02T00:00:00+02:00. */
export function formatTimestamp({ ms, offset }: Moment, precision: "seconds" | "minutes" = "seconds"): string {
  const wall = new Date(ms + offset * 60_000);
  const sign = offset < 0 ? "-" : "+";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const seconds = precision === "seconds" ? `:${pad(wall.getUTCSeconds())}` : "";
  return `${wall.toISOString().slice(0, 16)}${seconds}${zone}`;
}

/** UTC with Z and whole seconds, such as 2026-07-01T22:00:00Z. */
export function formatUtcZ(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function inUtc(ms: number): Moment {
  return { ms, offset: 0 };
}

const zurichFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "longOffset" });

/** Offset of Swiss time at an instant, in minutes: 60 in winter, 120 in summer. */
export function zurichOffset(ms: number): number {
  const name = zurichFormat.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

export function inZurich(ms: number): Moment {
  return { ms, offset: zurichOffset(ms) };
}

/** Swiss calendar date of an instant, YYYY-MM-DD. */
export function zurichDate(ms: number): string {
  return formatTimestamp(inZurich(ms)).slice(0, 10);
}

/** Swiss wall-clock hour of an instant, 0 to 23. */
export function zurichHour(ms: number): number {
  return Number(formatTimestamp(inZurich(ms)).slice(11, 13));
}

/** YYYY-MM-DD plus a number of days. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function zurichMidnight(day: string): Moment {
  const [year, month, date] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date);
  // Midnight is never inside a Swiss clock change, which happens between 02:00 and 03:00.
  const offset = zurichOffset(wall - zurichOffset(wall) * 60_000);
  return { ms: wall - offset * 60_000, offset };
}

/** Start and end of a Swiss calendar day. */
export function dayBounds(day: string): [Moment, Moment] {
  return [zurichMidnight(day), zurichMidnight(addDays(day, 1))];
}
