/**
 * Products from curation/<year>.json in their published form: every component with the tariff in
 * the total, where that choice comes from (basis), and the options a customer may have instead.
 * No Node APIs.
 */
import type { Basis, CuratedProduct, Issue, Product, ProductComponent, Tariff, TariffType } from "./types.ts";

const STANDARD_TYPES: TariffType[] = ["electricity", "grid"];

/** A tariff without a voltage level is not tied to one, so it fits any level. */
export function fitsLevel(tariff: Tariff, level: number | undefined): boolean {
  return tariff.customerVoltageLevel === undefined || level === undefined || tariff.customerVoltageLevel === level;
}

/** The tariffs a customer of a product could have for one component: same type, same voltage level. */
export function candidates(tariffs: Tariff[], slot: TariffType, level: number | undefined): Tariff[] {
  return tariffs.filter((t) => t.tariffType === slot && fitsLevel(t, level));
}

/** Where a choice comes from, if the curation does not say. */
function derivedBasis(slot: TariffType, tariff: Tariff | undefined, tariffs: Tariff[], level: number | undefined, checked: boolean): Basis {
  if (tariff && STANDARD_TYPES.includes(slot) && tariff.standardBasegroup === true) return "standardBasegroup";
  if (tariff && candidates(tariffs, slot, level).length === 1) return "only";
  return checked ? "curated" : "suggested";
}

/**
 * Resolve the products of a year. Returns the products in published form and the issues of the
 * curation, such as a basis that does not hold.
 */
export function resolveProducts(curated: CuratedProduct[], tariffs: Tariff[]): { products: Product[]; issues: Issue[] } {
  const byId = new Map(tariffs.map((t) => [t.id, t]));
  const issues: Issue[] = [];
  const products = curated.map((product): Product => {
    const error = (code: string, message: string) => issues.push({ severity: "error", code, tariff: product.id, message });
    const checked = product.status === "verified";
    const gridId = typeof product.components.grid === "string" ? product.components.grid : product.components.grid?.tariff;
    const level = gridId ? byId.get(gridId)?.customerVoltageLevel : undefined;
    const components: Product["components"] = {};
    for (const [slot, value] of Object.entries(product.components) as [TariffType, CuratedProduct["components"][TariffType]][]) {
      const given = typeof value === "string" ? { tariff: value } : { ...value! };
      const tariff = given.tariff ? byId.get(given.tariff) : undefined;
      const basis = given.basis ?? derivedBasis(slot, tariff, tariffs, level, checked);
      if (basis === "standardBasegroup" && tariff?.standardBasegroup !== true) {
        error("basis_not_standard", `${slot}: ${given.tariff} has no standardBasegroup`);
      }
      if (basis === "only" && candidates(tariffs, slot, level).length !== 1) {
        error("basis_not_only", `${slot}: the yearly file has ${candidates(tariffs, slot, level).length} ${slot} tariffs for this level`);
      }
      if (basis === "curated" && !given.sourceUrl && !product.sourceUrl) {
        error("curated_without_source", `${slot}: a curated choice needs sourceUrl, on the component or the product`);
      }
      if (!given.tariff && !(slot === "regional_fees" && given.byMunicipality)) {
        error("component_without_tariff", `${slot} needs a tariff`);
      }
      const component: ProductComponent = { ...given, basis };
      components[slot] = component;
    }
    const status = Object.values(components).some((c) => c.basis === "suggested") ? "suggested" : "verified";
    return { ...product, status, components };
  });
  return { products, issues };
}

/** The tariff ids of a product: the ones in the total and the options. */
export function productTariffIds(product: Product): { slot: TariffType; id: string; option: boolean }[] {
  return (Object.entries(product.components) as [TariffType, ProductComponent][]).flatMap(([slot, component]) => [
    ...(component.tariff ? [{ slot, id: component.tariff, option: false }] : []),
    ...(component.options ?? []).map((id) => ({ slot, id, option: true })),
  ]);
}
