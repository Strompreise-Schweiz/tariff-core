/**
 * Proposes which tariffs form a product, because the VSE format has no link between electricity,
 * grid, metering and regional_fees. A person checks each proposal against the price sheet. No Node APIs.
 */
import { candidates, fitsLevel } from "./product-spec.ts";
import { slugify } from "./json.ts";
import type { CuratedProduct, Tariff, TariffDocument } from "./types.ts";

type Component = CuratedProduct["components"]["metering"];

/** The first candidate in the total, the others as options. */
function withOptions(found: Tariff[]): Component {
  if (found.length === 1) return found[0].id;
  return { tariff: found[0].id, options: found.slice(1).map((t) => t.id) };
}

/** Municipal fees are listed per municipality. A fee for everybody, such as a cantonal one, is in the total. */
function regionalFees(found: Tariff[]): Component {
  const municipal = found.filter((t) => t.prices.municipalityTaxes?.length);
  if (!municipal.length) return withOptions(found);
  const general = found.filter((t) => !t.prices.municipalityTaxes?.length);
  return { ...(general.length ? { tariff: general[0].id } : {}), byMunicipality: true };
}

/**
 * Candidates with status "suggested", matched on voltage level, customer group and dynamic or not.
 * Metering and regional fees: the first tariff that fits, the others as options, and municipal fees
 * per municipality. The combination of the electricity and grid tariff the utility marks with
 * standardBasegroup (VSE 1.0.1) is proposed as the default product, with the id "standard".
 */
export function suggestProducts(document: TariffDocument): CuratedProduct[] {
  const { tariffs } = document;
  const byId = new Map(tariffs.map((t) => [t.id, t]));
  const products = suggestPairs(tariffs);
  // Only an unambiguous pair is the default: VSE 1.0.1 allows one standard tariff per type.
  const standard = products.filter((p) => byId.get(p.components.electricity as string)?.standardBasegroup === true
    && byId.get(p.components.grid as string)?.standardBasegroup === true);
  if (standard.length === 1) Object.assign(standard[0], { id: "standard", default: true });
  return products;
}

function suggestPairs(tariffs: Tariff[]): CuratedProduct[] {
  return tariffs.filter((t) => t.tariffType === "electricity").flatMap((electricity) => {
    const isDynamic = electricity.tariffForm === "dynamic";
    const grids = tariffs.filter((grid) => grid.tariffType === "grid" && fitsLevel(grid, electricity.customerVoltageLevel)
      && grid.customerType === electricity.customerType && (grid.tariffForm === "dynamic") === isDynamic);
    return grids.map((grid): CuratedProduct => {
      const level = grid.customerVoltageLevel;
      const components: CuratedProduct["components"] = { electricity: electricity.id, grid: grid.id };
      const metering = candidates(tariffs, "metering", level);
      if (metering.length) components.metering = withOptions(metering);
      const fees = candidates(tariffs, "regional_fees", level);
      if (fees.length) components.regional_fees = regionalFees(fees);
      return {
        id: slugify(`${electricity.tariffName} ${grid.tariffName}`, 80) + (level ? `-ne${level}` : ""),
        name: `${electricity.tariffName} + ${grid.tariffName}`,
        status: "suggested",
        components,
      };
    });
  });
}
