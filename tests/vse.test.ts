import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { checkAllVersions } from "../engine/lib/conformance.ts";
import { publish } from "../engine/publish-static.ts";
import { ekzLike, price, readJsonFile, setNow, tempDir, writeJsonFile } from "./helpers.ts";

/** A file that follows 1.0.0 to the letter. */
function strict100() {
  return {
    dsoName: "Muster", dsoNumber: 10000000001, tariffs: [{
      tariffName: "Netz", tariffType: "grid", tariffForm: "constant", customerVoltageLevel: 7, customerType: "A",
      startDate: "2026-01-01", endDate: "2026-12-31", prices: { energy: [price(0.1)] },
    }],
  };
}

test("Sunday is So in 1.0.0 and Su in 1.0.1", () => {
  const file = strict100();
  assert.deepEqual([checkAllVersions(file)["1.0.0"].valid, checkAllVersions(file)["1.0.1"].valid], [true, true]);
  file.tariffs[0].prices.energy[0].weekdays = ["Su"];
  const results = checkAllVersions(file);
  assert.equal(results["1.0.0"].valid, false);
  assert.equal(results["1.0.1"].valid, true);
  assert.deepEqual(results["1.0.0"].summary[0], { path: "tariffs/*/prices/energy/*/weekdays/*", message: "must be equal to one of the allowed values: Mo, Tu, We, Th, Fr, Sa, So", count: 1 });
});

test("1.0.1 no longer requires a voltage level, and adds CHF/kW/Y", () => {
  const file: Record<string, any> = strict100();
  delete file.tariffs[0].customerVoltageLevel;
  file.tariffs[0].prices.power = [price(5, { priceUnit: "CHF/kW/Y" })];
  const results = checkAllVersions(file);
  assert.equal(results["1.0.0"].errors, 2);
  assert.equal(results["1.0.1"].valid, true);
});

test("errors are grouped by rule and path", () => {
  const file = strict100();
  file.tariffs.push({ ...file.tariffs[0], startDate: "01.01.2026" }, { ...file.tariffs[0], startDate: "02.01.2026" });
  const { errors, summary } = checkAllVersions(file)["1.0.1"];
  assert.equal(errors, 2);
  assert.deepEqual(summary, [{ path: "tariffs/*/startDate", message: 'must match format "date"', count: 2 }]);
});

test("publishing records the conformance of source and output, with badges", async () => {
  const root = tempDir();
  writeJsonFile(path.join(root, "curation/source.json"), ekzLike());
  writeJsonFile(path.join(root, "config/source.json"), {
    slug: "muster", name: "Muster", vse_id: "CH10000000001", dynamic: [],
    static: { sources: [{ name: "main", file: "curation/source.json" }] },
  });
  setNow("2026-11-02T10:00:00Z");
  assert.equal(await publish(root), 0);
  const report = readJsonFile(path.join(root, "data/vse-conformance.json"));
  // The source writes Su and 23:59 like EKZ: wrong in 1.0.0, right in 1.0.1.
  assert.deepEqual([report.sources[0].results["1.0.0"].valid, report.sources[0].results["1.0.1"].valid], [false, true]);
  // The published file is written in 1.0.1, with Su.
  assert.deepEqual(report.published.map((p: any) => [p.file, p.results["1.0.0"].valid, p.results["1.0.1"].valid]), [["tariffs/2026.json", false, true]]);
  assert.deepEqual(readJsonFile(path.join(root, "data/badges/vse-1.0.1.json")), { schemaVersion: 1, label: "VSE 1.0.1", message: "valid", color: "brightgreen" });
  assert.equal(readJsonFile(path.join(root, "data/badges/vse-1.0.0.json")).message, "invalid");
  assert.ok(readJsonFile(path.join(root, "data/index.json")).vse_conformance.endsWith("/data/vse-conformance.json"));
});
