/**
 * Proposes which tariffs form a product, because the VSE format has no link between electricity,
 * grid, metering and regional_fees. A person checks each proposal against the price sheet. No Node APIs.
 */
import { slugify } from "./json.ts";
import type { Product, Tariff, TariffDocument } from "./types.ts";

/** A tariff without a voltage level is not tied to one, so it fits any level. */
function fits(tariff: Tariff, level: number | undefined): boolean {
  return tariff.customerVoltageLevel === undefined || level === undefined || tariff.customerVoltageLevel === level;
}

/** Candidates with status "suggested", matched on voltage level, customer group and dynamic or not. */
export function suggestProducts(document: TariffDocument): Product[] {
  const { tariffs } = document;
  return tariffs.filter((t) => t.tariffType === "electricity").flatMap((electricity) => {
    const isDynamic = electricity.tariffForm === "dynamic";
    const grids = tariffs.filter((grid) => grid.tariffType === "grid" && fits(grid, electricity.customerVoltageLevel)
      && grid.customerType === electricity.customerType && (grid.tariffForm === "dynamic") === isDynamic);
    return grids.map((grid): Product => {
      const level = grid.customerVoltageLevel;
      const components: Product["components"] = { electricity: electricity.id, grid: grid.id };
      for (const slot of ["metering", "regional_fees"] as const) {
        const match = tariffs.find((t) => t.tariffType === slot && fits(t, level));
        if (match) components[slot] = match.id;
      }
      return {
        id: slugify(`${electricity.tariffName} ${grid.tariffName}`, 80) + (level ? `-ne${level}` : ""),
        name: `${electricity.tariffName} + ${grid.tariffName}`,
        status: "suggested",
        components,
      };
    });
  });
}
