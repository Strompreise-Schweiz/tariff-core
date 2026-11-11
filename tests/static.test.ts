import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { applyCuration, assignIds } from "../engine/core/curation.ts";
import { repairStatic } from "../engine/core/normalizers/static-vse.ts";
import { suggestProducts as suggest } from "../engine/core/products.ts";
import { coverageProblems, documentIssues } from "../engine/core/rules.ts";
import type { Issue, TariffDocument, TimePrice } from "../engine/core/types.ts";
import { publish } from "../engine/publish-static.ts";
import { ekzLike, price, readJsonFile, setNow, tempDir, writeJsonFile, type Obj } from "./helpers.ts";

/** Based on the example in NNMV annex 10, including its deviations from the OpenAPI. */
function nnmvLike(): Obj {
  const common = {
    dsoName: "Groupe E", dsoNumber: 10063012345, customerVoltageLevel: 7, customerType: "bis 100 MWh",
    startDate: "01.01.2026", endDate: "31.12.2026",
  };
  const day = (from: string, to: string, p: number) => ({ day: "*", from, to, price: p });
  return {
    tariffs: [
      { ...common, tariffType: "grid", tariffForm: "constant", tariffName: "Einheitstarif",
        prices: { base: 5.52, grid: [{ prices: [day("00:00", "00:00", 0.0802)] }], power: 0 } },
      { ...common, tariffType: "refund", tariffForm: "constant", tariffName: "Einheitstarif",
        prices: { base: 0, energy: [{ prices: [day("00:00", "00:00", -0.097)] }] } },
      { ...common, tariffType: "grid", tariffForm: "multilevel", tariffName: "Doppeltarif",
        prices: { base: 5.52, energy: [{ prices: [day("00:00", "07:00", 0.053), day("07:00", "21:00", 0.082), day("21:00", "00:00", 0.053)] }], power: 0 } },
      { ...common, tariffType: " regional_fees ", tariffForm: "constant", tariffName: "Abgaben",
        prices: { base: 0, municipalityTaxes: [{ municipalityNumber: 352, municipalityName: "Bolligen",
          prices: [day("00:00", "00:00", 0.015)], comment: "Maximum CHF 500 per year" }] } },
    ],
  };
}

function build(raw: Obj, curation: Obj = {}, year = 2026): [Obj, Issue[]] {
  const { document: repaired, repairs, problems } = repairStatic(raw);
  assert.deepEqual(problems, []);
  const { tariffs, applied, issues } = applyCuration(repaired.tariffs, curation);
  const document = {
    dsoName: repaired.dsoName, dsoNumber: repaired.dsoNumber, tariffs: assignIds(tariffs), products: curation.products ?? [],
    _meta: { schemaVersion: "1.0", year, source: [], repairs, overrides: applied },
  } as TariffDocument;
  return [document, [...issues, ...documentIssues(document, year)]];
}

const errors = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
const codes = (issues: Issue[]) => new Set(issues.map((i) => i.code));

test("real shape passes with repairs logged", () => {
  const [document, issues] = build(ekzLike());
  assert.deepEqual(errors(issues), []);
  assert.deepEqual(new Set(document._meta.repairs.map((r: Obj) => r.code)), new Set(["end_of_day_to_midnight", "weekday_spelling"]));
  const energy = document.tariffs[0].prices.energy[0];
  assert.equal(energy.to, "00:00");
  assert.ok(energy.weekdays.includes("So"));
});

test("unknown source fields survive", () => {
  const [document] = build(ekzLike());
  assert.equal(document.tariffs[0].standardBasegroup, true);
  assert.equal(document.tariffs[2].prices.refundStorage.url, "https://x.example/r");
});

test("NNMV example is repaired", () => {
  const [document, issues] = build(nnmvLike());
  assert.deepEqual(errors(issues), []);
  assert.equal(document.dsoNumber, 10063012345);
  const grid = document.tariffs[0];
  assert.equal(grid.startDate, "2026-01-01");
  assert.deepEqual(grid.prices.base, { price: 5.52, priceUnit: "CHF/M" });
  assert.equal(grid.prices.energy[0].price, 0.0802);
  assert.ok(!("power" in grid.prices));
  assert.equal(grid.prices.refundStorage.price, 0.097);
  assert.ok(!document.tariffs.some((t: Obj) => t.tariffType === "refund"));
  const fee = document.tariffs.find((t: Obj) => t.tariffType === "regional_fees");
  assert.equal(fee.prices.municipalityTaxes[0].municipalityEnergy[0].price, 0.015);
  assert.ok(fee.prices.municipalityTaxes[0].municipalityComment.startsWith("Maximum"));
});

test("the dso number from the tariffs becomes an integer", () => {
  const { repairs } = repairStatic(nnmvLike());
  assert.equal(repairs.find((r) => r.code === "dso_number_to_integer")?.detail, 'converted "10063012345" to an integer');
});

function uznachLike(): Obj {
  const raw = ekzLike();
  for (const tariff of raw.tariffs) {
    tariff.customerVoltageLevel = 0;
    tariff.endDate = "2099-12-31";
  }
  return raw;
}

test("defects from a real utility block publication", () => {
  // Defects Philipp found at EW Uznach: voltage level 0 and end date 2099.
  const [, issues] = build(uznachLike());
  assert.ok(issues.some((i) => i.code === "schema" && i.path?.includes("customerVoltageLevel")));
});

test("curation fixes defects and records the reason", () => {
  const curation = {
    overrides: ["electricity", "grid", "metering", "regional_fees"].map((kind) => ({
      match: { tariffType: kind }, set: { customerVoltageLevel: 7, endDate: "2026-12-31" }, reason: "Price sheet 2026",
    })),
    acceptIssues: [],
  };
  const [document, issues] = build(uznachLike(), curation);
  assert.deepEqual(errors(issues), []);
  assert.equal(document._meta.overrides[0].reason, "Price sheet 2026");
});

test("a stale curation rule is an error", () => {
  const [, issues] = build(ekzLike(), { overrides: [{ match: { tariffName: "does not exist" }, set: { comment: "x" }, reason: "r" }] });
  const stale = issues.find((i) => i.code === "curation_no_match");
  assert.equal(stale?.message, 'override matches nothing: {"tariffName":"does not exist"}');
});

test("a dotted override replaces prices", () => {
  const curation = { overrides: [{ match: { tariffName: "Netz 400F" }, set: { "prices.energy": [price(0.2)] }, reason: "JSON differs from the PDF" }] };
  const [document] = build(ekzLike(), curation);
  assert.equal(document.tariffs.find((t: Obj) => t.tariffName === "Netz 400F").prices.energy[0].price, 0.2);
});

function single(form: string, prices: Obj): Obj {
  return {
    tariffs: [{ tariffName: "T", tariffType: "grid", tariffForm: form, customerVoltageLevel: 7,
      startDate: "2026-01-01", endDate: "2026-12-31", customerType: "A", prices }],
    dsoName: "M", dsoNumber: 10000000001,
  };
}

const HASHED_IDS = ["regional-fees-abgaben-ne5-96b460", "regional-fees-abgaben-ne5-5f9da1"];

const formCases: [string, Obj, string][] = [
  ["constant", { energy: [price(0.1), price(0.2)] }, "constant_with_several_prices"],
  ["constant", { energy: [price(0.1, { from: "07:00", to: "20:00" })] }, "constant_with_time_window"],
  ["multilevel", { energy: [price(0.1, { from: "07:00", to: "20:00" }), price(0.2, { from: "21:00", to: "07:00" })] }, "energy_time_gap"],
  ["multilevel", { energy: [price(0.1, { from: "07:00", to: "21:00" }), price(0.2, { from: "20:00", to: "07:00" })] }, "energy_time_overlap"],
  ["constant", { energy: [price(28.8)] }, "implausible_energy_price"],
];
for (const [form, prices, code] of formCases) {
  test(`form rule ${code}`, () => {
    const [, issues] = build(single(form, prices));
    assert.ok(codes(errors(issues)).has(code));
  });
}

test("a dynamic tariff needs a url", () => {
  const [, issues] = build(single("dynamic", { base: { price: 1, priceUnit: "CHF/M" } }));
  assert.ok(issues.some((i) => i.code === "schema"));
});

test("an overnight window covers the day", () => {
  const entries = [price(0.1, { from: "07:00", to: "21:00" }), price(0.05, { from: "21:00", to: "07:00" })];
  assert.deepEqual(coverageProblems(entries as TimePrice[]), { gaps: [], overlaps: [] });
});

test("a weekend low tariff covers the week", () => {
  const weekday = ["Mo", "Tu", "We", "Th", "Fr"];
  const entries = [
    price(0.1, { weekdays: weekday, from: "07:00", to: "20:00" }),
    price(0.05, { weekdays: weekday, from: "20:00", to: "07:00" }),
    price(0.05, { weekdays: ["Sa", "So"] }),
  ];
  assert.deepEqual(coverageProblems(entries as TimePrice[]), { gaps: [], overlaps: [] });
});

test("duplicate names get distinct ids", () => {
  const raw = ekzLike();
  raw.tariffs.push({ ...structuredClone(raw.tariffs.at(-1)), customerType: "Above 500 MWh" });
  const [document, issues] = build(raw);
  const ids = document.tariffs.map((t: Obj) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(errors(issues), []);
});

test("ids are stable", () => {
  const ids = build(ekzLike())[0].tariffs.map((t: Obj) => t.id);
  assert.deepEqual(ids, build(ekzLike())[0].tariffs.map((t: Obj) => t.id));
  assert.deepEqual(ids.slice(-2), ["regional-fees-abgaben-ne7", "regional-fees-abgaben-ne5"]);
  // A change here renames published tariffs, which breaks references in curation/<year>.json.
  const raw = ekzLike();
  raw.tariffs.push({ ...structuredClone(raw.tariffs.at(-1)), customerType: "Above 500 MWh" });
  delete raw.tariffs.at(-1).url;
  assert.deepEqual(build(raw)[0].tariffs.slice(-2).map((t: Obj) => t.id), HASHED_IDS);
});

test("suggestions pair static and dynamic correctly", () => {
  const [document] = build(ekzLike());
  assert.deepEqual(new Set(suggest(document as TariffDocument).map((p) => p.name)),
    new Set(["Energie Erneuerbar + Netz 400ST", "Energie Erneuerbar + Netz 400F", "Energie Dynamisch + Netz 400D"]));
});

test("product rules", () => {
  const [document] = build(ekzLike());
  const ids = Object.fromEntries(document.tariffs.filter((t: Obj) => t.customerVoltageLevel === 7).map((t: Obj) => [t.tariffName, t.id]));
  document.products = [{ id: "p", name: "P", status: "verified", components: { electricity: ids["Netz 400ST"], grid: "missing" } }];
  const found = codes(errors(documentIssues(document as TariffDocument, 2026)));
  for (const code of ["product_wrong_slot", "product_unknown_tariff", "verified_without_source"]) assert.ok(found.has(code), code);
});

function repo(source: Obj | string): string {
  const root = tempDir();
  writeJsonFile(path.join(root, "curation/source.json"), source);
  writeJsonFile(path.join(root, "config/source.json"), {
    slug: "muster", name: "Muster", vse_id: "CH10000000001", dynamic: [],
    static: { sources: [{ name: "main", file: "curation/source.json" }] },
  });
  setNow("2026-11-02T10:00:00Z");
  return root;
}

test("a multi-year source is split by year", async () => {
  // EKZ publishes 2026 and 2027 in one file.
  const raw = ekzLike();
  const nextYear = { ...structuredClone(raw.tariffs[0]), startDate: "2027-01-01", endDate: "2027-12-31" };
  raw.tariffs.push(nextYear);
  const root = repo(raw);
  assert.equal(await publish(root), 0);
  assert.equal(readJsonFile(path.join(root, "data/tariffs/2027.json")).tariffs.length, 1);
  assert.deepEqual(readFileSync(path.join(root, "data/tariffs/current.json")), readFileSync(path.join(root, "data/tariffs/2026.json")));
  const index = readJsonFile(path.join(root, "data/index.json"));
  assert.deepEqual(Object.keys(index.static.years), ["2026", "2027"]);
});

test("a failed year keeps the previous file online", async () => {
  const root = repo(ekzLike());
  assert.equal(await publish(root), 0);
  const good = readFileSync(path.join(root, "data/tariffs/2026.json"));
  writeJsonFile(path.join(root, "curation/source.json"), uznachLike());
  assert.equal(await publish(root), 1);
  assert.deepEqual(readFileSync(path.join(root, "data/tariffs/2026.json")), good);
  assert.equal(readJsonFile(path.join(root, "data/tariffs/2026.report.json")).published, false);
});

test("a rerun writes nothing", async () => {
  const root = repo(ekzLike());
  await publish(root);
  const first = readFileSync(path.join(root, "data/tariffs/2026.json"));
  setNow("2026-11-03T10:00:00Z");
  await publish(root);
  assert.deepEqual(readFileSync(path.join(root, "data/tariffs/2026.json")), first);
});

test("a source with a byte order mark is read", async () => {
  const root = repo(`﻿${JSON.stringify(ekzLike())}`);
  assert.equal(await publish(root), 0);
});

/** Shape of the EKZ 2027 data: four grid clusters, no voltage level on electricity, metering and fees. */
function ekz2027Like(): Obj {
  const raw = ekzLike();
  const tariffs = raw.tariffs.filter((t: Obj) => ["Energie Dynamisch", "Messung"].includes(t.tariffName)
    || (t.tariffName === "Abgaben" && t.customerVoltageLevel === 7));
  for (const tariff of tariffs) delete tariff.customerVoltageLevel;
  const template = raw.tariffs.find((t: Obj) => t.tariffName === "Netz 400D");
  for (let cluster = 1; cluster <= 4; cluster++) {
    tariffs.push({ ...structuredClone(template), tariffName: `Netz 400D Cluster ${cluster}`,
      prices: { dynamic: { url: `https://api.example.ch/v1/tariffs?tariff_name=grid_400D${cluster}_inclFees` } } });
  }
  raw.tariffs = tariffs;
  return raw;
}

test("a missing voltage level warns and is not invented", () => {
  const [document, issues] = build(ekz2027Like());
  assert.deepEqual(errors(issues), []);
  assert.ok(codes(issues).has("missing_voltage_level"));
  const energy = document.tariffs.find((t: Obj) => t.tariffType === "electricity");
  assert.ok(!("customerVoltageLevel" in energy));
  assert.equal(energy.id, "electricity-energie-dynamisch");
});

test("each cluster becomes its own product", () => {
  const [document] = build(ekz2027Like());
  const products = suggest(document as TariffDocument);
  assert.deepEqual(new Set(products.map((p) => p.components.grid)), new Set([1, 2, 3, 4].map((n) => `grid-netz-400d-cluster-${n}-ne7`)));
  assert.deepEqual(new Set(products.map((p) => p.components.electricity)), new Set(["electricity-energie-dynamisch"]));
});

test("a product selection is valid", () => {
  const [document] = build(ekz2027Like());
  const product: Obj = suggest(document as TariffDocument)[0];
  product.selection = { kind: "grid-cluster", value: "1", howToFind: "Shown in myEKZ" };
  document.products = [product];
  assert.deepEqual(errors(documentIssues(document as TariffDocument, 2026)), []);
});
