import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "node:test";

import { http } from "../engine/lib/http.ts";

/** Test fixtures are deliberately loose: many tests build broken files on purpose. */
export type Obj = Record<string, any>;

const originalFetch = http.fetchBytes;
const created: string[] = [];

/** A fresh temporary folder, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tariff-core-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  http.fetchBytes = originalFetch;
  delete process.env.TARIFF_ETL_NOW;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function setNow(value: string): void {
  process.env.TARIFF_ETL_NOW = value;
}

export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

export function readJsonFile(file: string): Obj {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Price entry valid all day and all year. */
export function price(value: number, extra: Obj = {}): Obj {
  return { months: [], weekdays: [], from: "00:00", to: "00:00", price: value, priceUnit: "CHF/kWh", ...extra };
}

/** Shape as published by EKZ (from a real file), with fictional values. */
export function ekzLike(): Obj {
  const t = (name: string, kind: string, form: string, prices: Obj, level = 7, customer = "Private up to 100 MWh") => ({
    tariffName: name, tariffType: kind, tariffForm: form, customerVoltageLevel: level,
    startDate: "2026-01-01", endDate: "2026-12-31", customerType: customer, comment: "ohne MwSt.",
    standardBasegroup: true, url: `https://example.ch/${name}`.replaceAll(" ", "-"), prices,
  });
  const winter = ["Jan", "Feb", "Mar", "Oct", "Nov", "Dec"];
  const summer = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
  const allDays = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const energy = ([[winter, 0.13], [summer, 0.09]] as [string[], number][])
    .map(([months, p]) => ({ months, weekdays: allDays, from: "00:00", to: "23:59", price: p, priceUnit: "CHF/kWh" }));
  return {
    dsoName: "Muster", dsoNumber: 10000000001, tariffs: [
      t("Energie Erneuerbar", "electricity", "multilevel", { base: { price: 3.0, priceUnit: "CHF/M" }, energy }),
      t("Energie Dynamisch", "electricity", "dynamic", {
        base: { price: 3.0, priceUnit: "CHF/M" },
        dynamic: { url: "https://api.example.ch/v1/tariffs?tariff_name=electricity_d" },
      }),
      t("Netz 400ST", "grid", "constant", {
        base: { price: 0.0, priceUnit: "CHF/M" }, energy: [price(0.1)],
        refundStorage: { price: 0.1, priceUnit: "CHF/kWh", url: "https://x.example/r" },
      }),
      t("Netz 400F", "grid", "constant", { energy: [price(0.09)] }),
      t("Netz 400D", "grid", "dynamic", { dynamic: { url: "https://api.example.ch/v1/tariffs?tariff_name=grid_d" } }),
      t("Messung", "metering", "constant", { base: { price: 5.0, priceUnit: "CHF/M" } }, 7, "All"),
      t("Abgaben", "regional_fees", "constant", {
        cantonalTaxes: [{ cantonName: "ZH", cantonEnergy: [price(0.0016)] }],
        municipalityTaxes: [{ municipalityNumber: 12389, municipalityName: "Menzingen", municipalityEnergy: [price(0.0049)] }],
      }, 7, "All"),
      t("Abgaben", "regional_fees", "constant", {
        cantonalTaxes: [{ cantonName: "ZH", cantonBase: { price: 66.67, priceUnit: "CHF/M" } }],
      }, 5, "All"),
    ],
  };
}
