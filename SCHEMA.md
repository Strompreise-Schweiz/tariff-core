# File layout and formats

Every utility has the same layout, in the root of its own repo or in `utilities/<slug>/` of the hub
repo `strompreise-schweiz.github.io`. The principle: **what the utility publishes is stored unchanged,
and everything published here is built from it plus the corrections of a person.**

```text
config/source.json                          where the data comes from                   person
curation/<year>.json                        corrections and products, with reasons      person

data/sources/<name>.json                    yearly file of the utility, unchanged       fetch.ts
data/sources/days/<id>/<year>/<date>.json   response of a day price API, unchanged      fetch.ts

data/tariffs/<year>.json                    yearly file, repaired and corrected         build.ts
data/tariffs/current.json                   copy of the current year, stable URL        build.ts
data/tariffs/<year>/<tariff>/<date>.json    day prices of a dynamic tariff of <year>.json  build.ts
data/tariffs/current/<tariff>.json          today + tomorrow of a dynamic tariff        build.ts

data/products/<id>/<year>.json              what a customer pays: components and total  build.ts
data/products/<id>/<year>/<date>.json       a product with a dynamic tariff, per 15 min build.ts
data/products/<id>/latest.json              today + tomorrow of such a product          build.ts

data/checks.json                            what is wrong with all of the above         build.ts
data/badges/vse-<version>.json              badges for the README                       build.ts
data/index.json                             all URLs of this utility                    build.ts
```

Three levels, each a folder:

| Folder | Holds | Changed by |
|---|---|---|
| `data/sources/` | What the utility publishes, byte for byte | nobody |
| `data/tariffs/` | The tariffs, repaired to VSE 1.0.1 and corrected. A dynamic tariff's day prices are next to the yearly file of its year, under the id of the tariff | automatic repairs, `curation/<year>.json` |
| `data/products/` | What a customer pays: which tariffs belong together, and their sum | `products` in `curation/<year>.json` |

Start with `data/products/`: the product with `"default": true` is what a household in the basic
supply pays without choosing anything.

`<date>` is always the Swiss calendar day the prices apply to. `build.ts` works offline and is
repeatable: it rebuilds every file from `data/sources/` and `curation/`, writes only what changed and
removes day files whose stored response is gone.

The hub repo also has `repositories.json`, the list of utilities with an own repo, from which
`build-site.ts` writes the overall `index.json` of the site
(schema: [`schemas/overall-index/v1.schema.json`](schemas/overall-index/v1.schema.json)). GitHub Pages
serves each utility's `data/` folder under `https://data.strompreise-schweiz.ch/<slug>/`, with the day
files of the current year only. `data/index.json` names the utility's `repository` and `site`.

Both indexes identify a utility by `vse_id` and `elcom_id`, `null` if not known. In the overall index,
`maintained_in` is `hub` or `own_repository`.

## Three tariff forms, two formats

The VSE knows three tariff forms. All three are in the yearly file, but the prices of a dynamic tariff
are not: they are published every day by an API, in the format of HDN 2025, chapter 7.4.

| `tariffForm` | Where the prices are | Rules checked |
|---|---|---|
| `constant` | `prices.energy` with one entry, `from` = `to` = `00:00` | One price, no time restriction |
| `multilevel` | `prices.energy` with several entries | Every minute of every month and weekday has exactly one price |
| `dynamic` | `prices.dynamic.url`: the day prices in `data/tariffs/<year>/<tariff>/` | URL required |

The fixed parts of a dynamic tariff (`base`, `refundStorage`) stay in the yearly file. Its day prices
are an addition to the yearly file: `tariffs/2026/<tariff>/` holds the days of the tariff `<tariff>`
in `tariffs/2026.json`.

## Input: `config/source.json`

Schema: [`schemas/source-config/v1.schema.json`](schemas/source-config/v1.schema.json).

```jsonc
{
  "slug": "ekz", "name": "EKZ", "vse_id": "CH10153012345", "elcom_id": 486,
  "tariffs": [                      // yearly files, VSE format
    { "name": "ekz-all", "url": "https://www.ekz.ch/.../tarife_ekz.json" }
  ],
  "prices": [                       // APIs with day prices, HDN 7.4 format
    { "id": "grid-400d", "name": "EKZ Netz 400D",
      "url": "https://api.tariffs.ekz.ch/v1/tariffs?tariff_name=grid_400D_inclFees",
      "valid_to": "2026-12-31" }
  ]
}
```

A price source belongs to the dynamic tariff whose `prices.dynamic.url` in the yearly file is its
`url`. That is how `build.ts` puts the days under the tariff and points the tariff to
`tariffs/current/<tariff>.json`. A dynamic tariff without a price source keeps the URL of the utility,
with the warning `dynamic_without_prices`. Days of a year whose yearly file has no tariff with that URL
stay in `data/sources/` and are listed under `withoutTariff` in `checks.json`.

`enabled: false` stops fetching. Stored days are still published.

## Input: `curation/<year>.json`

Schema: [`schemas/curation/v1.schema.json`](schemas/curation/v1.schema.json). Everything a person
changes. Every entry needs a `reason`:

| Key | Purpose | Example |
|---|---|---|
| `overrides` | Change fields of tariffs in the yearly file | Voltage level is 0 in the source, set 7 |
| `removeTariffs` | Drop a tariff | Test tariff in the source |
| `addTariffs` | Add a missing tariff | Metering tariff is not in the file |
| `prices` | Replace components of day prices | The API has no metering, add it from the price sheet |
| `products` | Which tariffs belong together, which is the default, the options per component | Electricity + grid + metering + fees |
| `acceptIssues` | Accept a known issue | The gap is really in the utility's tariff |

```jsonc
"prices": [{
  "prices": "grid-400d",            // id in config/source.json
  "from": "2026-07-01",             // optional, within the year of the file
  "to": "2026-12-31",
  "set": { "metering": [{ "unit": "CHF_m", "value": 6.9 }] },
  "reason": "Metering tariff from the price sheet"
}]
```

A rule that no longer matches anything is an error, so outdated corrections become visible.

A component of a product is a tariff id, or an object. Without `basis`, it is derived:
`standardBasegroup` if the utility marks the tariff, `only` if it is the only one, else `suggested`.
`"status": "verified"` on the product means a person checked all other components: they become
`curated` and need `sourceUrl`.

```jsonc
"products": [{
  "id": "standard", "name": "EKZ Energie Erneuerbar + EKZ Netz 400ST", "default": true,
  "components": {
    "electricity": "electricity-ekz-energie-erneuerbar",
    "grid": "grid-ekz-netz-400st-...-ne7",
    "metering": {
      "tariff": "metering-messung-direkt-netzebene-7",
      "options": ["metering-messung-indirekt-netzebene-7", "metering-virtueller-messpunkt"],
      "howToFind": "Depends on the connection. Direct metering is the usual case for a household."
    },
    "regional_fees": {
      "tariff": "regional-fees-...-94a342",   // the cantonal fee, in the total
      "byMunicipality": true                  // or { "tariffNames": [...] } to select the tariffs
    }
  }
}]
```

## Yearly file: `data/tariffs/<year>.json`

Schema: [`schemas/tariff-document/v1.schema.json`](schemas/tariff-document/v1.schema.json). A VSE file
(OpenAPI 1.0.1) with additions, so a program written for the VSE format can read it.

```jsonc
{
  "dsoName": "EKZ",                 // VSE 1.0.1
  "dsoNumber": 10153012345,         // VSE
  "tariffs": [{                     // VSE, unknown source fields are kept
    "id": "grid-ekz-netz-400d-ne7", // ADDED: stable key, tariffName is not unique
    "tariffName": "EKZ Netz 400D",
    "tariffType": "grid",           // electricity | grid | metering | regional_fees
    "tariffForm": "dynamic",        // constant | multilevel | dynamic
    "customerVoltageLevel": 7,
    "customerType": "...",
    "startDate": "2026-01-01",
    "endDate": "2026-12-31",
    "prices": {
      "base": { "price": 0, "priceUnit": "CHF/M" },
      "dynamic": {
        "url": "https://data.strompreise-schweiz.ch/ekz/tariffs/current/grid-ekz-netz-400d-ne7.json",
        "sourceUrl": "https://api.tariffs.ekz.ch/v1/tariffs?tariff_name=grid_400D_inclFees"  // ADDED
      }
    }
  }],
  "products": [{                    // ADDED: which tariffs belong together
    "id": "energie-dynamisch-netz-400d",
    "name": "EKZ Energie Dynamisch + Netz 400D",
    "default": false,               // true: the standard product of a household, one per year
    "selection": {                  // optional: the customer must belong to this group
      "kind": "grid-cluster", "value": "1", "howToFind": "Shown in myEKZ"
    },
    "status": "suggested",          // verified when no component is suggested
    "components": {                 // each with where its choice comes from, see below
      "electricity": { "tariff": "electricity-...", "basis": "standardBasegroup" },
      "grid": { "tariff": "grid-...", "basis": "only" },
      "metering": { "tariff": "metering-...", "basis": "suggested", "options": ["metering-..."] },
      "regional_fees": { "tariff": "regional-fees-...", "basis": "curated", "sourceUrl": "https://...", "byMunicipality": true }
    }
  }],
  "_meta": {                        // ADDED: how the file was built
    "schemaVersion": "2.0",         // format of this project
    "vseVersion": "1.0.1",          // VSE definition the file follows
    "generator": { "name": "tariff-core", "version": "5.0.0", "url": "..." },
    "year": 2026,
    "pricesExcludeVat": true,
    "source": [{ "name": "ekz-all", "url": "...", "sha256": "..." }],
    "repairs": [...],               // automatic repairs of deviations from the VSE format
    "corrections": [...]            // what curation/<year>.json changed, with the reasons
  }
}
```

The issues of the year are in `data/checks.json`, not in the file.

Several parallel variants of a tariff, such as EKZ grid clusters, are separate tariffs and products,
each with its own URL. See `docs/decisions.md`.

The `from` and `to` values are Swiss wall-clock time and do not change at a clock change.

## Product year: `data/products/<id>/<year>.json`

Schema: [`schemas/product/v1.schema.json`](schemas/product/v1.schema.json). One file per product and
year with everything a customer pays, excluding VAT. Short values stay on one line, so a person can
read it.

```jsonc
{
  "id": "standard",
  "name": "EKZ Energie Erneuerbar + EKZ Netz 400ST",
  "year": 2026,
  "status": "suggested",            // suggested | verified
  "default": true,                  // the standard product of a household
  "note": "...",
  "total": {
    "fixed": {                      // per month
      "electricity": [{"unit": "CHF_m", "value": 3}],
      "metering": [{"unit": "CHF_m", "value": 5}],
      "total": [{"unit": "CHF_m", "value": 8}]
    },
    "windows": [{                   // per kWh, by Swiss wall-clock time
      "months": ["Jan", "Feb", "Mar", "Oct", "Nov", "Dec"],
      "weekdays": ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
      "from": "00:00", "to": "23:59",
      "electricity": [{"unit": "CHF_kWh", "value": 0.133}],
      "grid": [{"unit": "CHF_kWh", "value": 0.1098}],
      "regional_fees": [{"unit": "CHF_kWh", "value": 0.0016}],
      "total": [{"unit": "CHF_kWh", "value": 0.2444}]
    }],
    "dynamic": []                   // components whose price per kWh changes daily
  },
  "missing": [],                    // components without a tariff, not in the total
  "municipalities": [{              // municipal fees, by BFS number: add those of your municipality
    "number": 12389, "name": "Menzingen", "tariffs": ["regional-fees-..."],
    "fixed": [], "energy": [{"unit": "CHF_kWh", "value": 0.0049}], "comments": ["..."]
  }],
  "components": {
    "electricity": { "basis": "standardBasegroup", "tariff": {...} },
    "grid": { "basis": "standardBasegroup", "tariff": {...} },
    "metering": {
      "basis": "suggested", "tariff": {...}, "howToFind": "...",
      "options": [{ "id": "metering-messung-indirekt-netzebene-7", "tariffName": "...", "fixed": [{"unit": "CHF_m", "value": 25}] }]
    },
    "regional_fees": { "basis": "suggested", "tariff": {...}, "byMunicipality": true }
  },
  "_meta": { "tariffs": "tariffs/2026.json", "days": null, "notes": [] }
}
```

- Each component has a `basis`, where its choice comes from:

  | `basis` | Meaning |
  |---|---|
  | `standardBasegroup` | the utility marks the tariff as standard (VSE 1.0.1, electricity and grid only) |
  | `only` | the yearly file has one tariff of this type for the voltage level of the grid tariff |
  | `curated` | a person chose it and checked it, `sourceUrl` on the component or the product |
  | `suggested` | proposed, not checked |

  `status` is `verified` when no component is `suggested`.
- `options` are the other tariffs of a component a customer may have, such as transformer metering,
  each alone with its prices. The total uses `tariff`.
- With `byMunicipality`, the municipal fees are not in the total but in `municipalities`, one entry
  per BFS number as in `municipalityTaxes` of VSE, summed over the selected tariffs. A fee for
  everybody, such as a cantonal one, stays in the total. `_meta.notes` names the fees in neither.
- `windows` cuts the time windows of all components into one set, so each window has one price per
  component. Months and weekdays with the same prices are grouped. As in VSE 1.0.1, the day ends at
  `23:59` and a window across midnight is split.
- A dynamic component has no price per kWh in `windows`: see `dynamic` and the day files in
  `_meta.days`. Its fixed prices are in `fixed`.
- Regional fees that differ by municipality are left out, `_meta.notes` says so.
- A year has at most one product with `"default": true` (`several_default_products` is an error).
  None is the warning `no_default_product`. `suggest-products.ts` proposes the pair that the utility
  marks with `standardBasegroup` as the product `standard`.

## Day prices: `data/tariffs/<year>/<tariff>/` and `data/products/<id>/<year>/`

Schema: [`schemas/price-day/v1.schema.json`](schemas/price-day/v1.schema.json). The format of HDN 2025,
chapter 7.4, one file per Swiss calendar day, without query parameters. Always in quarter hours: an
hourly value of the API becomes four equal quarter-hour values (HDN 5.3).

- **`tariffs/<year>/<tariff>/`**: what the API of a dynamic tariff sends, with the corrections of
  `curation/<year>.json` applied. `prices.dynamic.url` of the tariff points to
  `tariffs/current/<tariff>.json`. If several tariffs use the same API, each gets the days.
- **`products/<id>/<year>/`**: for each product with a dynamic tariff, every component a customer pays per
  quarter hour. The day prices of its dynamic tariffs, and from the yearly file everything else: base
  prices, metering, fees, fixed energy or grid prices.

```jsonc
{
  "publication_timestamp": "2026-11-12T17:49:53+01:00",
  "_meta": {
    "product": "energie-dynamisch-netz-400d",
    "date": "2026-11-13",
    "complete": true,               // every quarter hour has a price per kWh
    "components": { "electricity": "...", "grid": "...", "metering": "..." },
    "tariffs": "tariffs/2026.json",
    "year": "products/energie-dynamisch-netz-400d/2026.json",
    "notes": []                     // what could not be included, such as municipal fees
  },
  "prices": [{
    "start_timestamp": "2026-11-13T00:00:00+01:00",
    "end_timestamp": "2026-11-13T00:15:00+01:00",
    "electricity": [{ "unit": "CHF_m", "value": 3 }, { "unit": "CHF_kWh", "value": 0.12328 }],
    "grid":        [{ "unit": "CHF_m", "value": 0 }, { "unit": "CHF_kWh", "value": 0.1011 }],
    "metering":    [{ "unit": "CHF_m", "value": 5 }],
    "integrated":  [{ "unit": "CHF_kWh", "value": 0.22438 }]
  }]
}
```

Rules for a product day:

- A dynamic tariff contributes what its API sends. A price of the yearly file is added only for a
  unit the API does not send. EKZ sends the monthly base in the API, so it is not counted twice.
- `integrated` is the sum of the prices per kWh of `electricity`, `grid` and `regional_fees`. The
  monthly amounts (`CHF_m`) stay separate and are not converted.
- `metering` is an addition: HDN table 3 has no such type.
- Power prices are written as `CHF_kW_m` or `CHF_kW_y`.
- Regional fees that differ by municipality are left out, because a product does not say which
  municipality applies. `_meta.notes` says so.

Rules for consumers:

- Parse the offset. Never compare timestamps as text across a clock change.
- A day has 92 quarter hours in March, 96 normally and 100 in October.
- Check `_meta.complete`. Incomplete days are published as delivered and never filled in.
- Prices can be negative. Prices exclude VAT.
- Missing components are absent, not zero.

`tariffs/current/<tariff>.json` and `products/<id>/latest.json` hold today and, once published,
tomorrow. `_meta.days[]` says which days it holds and
whether each is complete.

## Checks: `data/checks.json` and `/status.html`

Everything that is wrong, in one place, written by `build.ts` without timestamps:

```jsonc
{
  "summary": { "errors": 0, "warnings": 10, "accepted": 0, "incompleteDays": 1 },
  "sources": {
    "tariffs": [{ "name": "ekz-all", "url": "...", "sha256": "...",
                  "vse": { "1.0.0": {...}, "1.0.1": {...} } }],   // the file of the utility vs. VSE
    "days": [{ "id": "grid-400d", "url": "...", "enabled": true, "days": 6, "first": "...", "last": "..." }]
  },
  "tariffs": [{                     // one entry per year
    "year": 2026,
    "published": true,              // false: errors, the previous file stays online
    "online": true,
    "repairs": [...],
    "issues": [...],                // errors, warnings, accepted issues with their codes
    "excluded": [...],              // tariffs left out because of errors of their own
    "vse": {...}                    // the published file vs. VSE
  }],
  "days": [{ "id": "electricity-dynamic",
             "tariffs": ["2026/electricity-ekz-energie-dynamisch"],   // where the days are published
             "days": 7,
             "incomplete": [{ "date": "2026-11-14", "issues": ["96 of 96 intervals have no price per kWh"] }],
             "withoutTariff": [] }],                                  // days of a year without such a tariff
  "products": [{ "id": "standard", "year": 2026, "default": true, "status": "suggested",
                 "missing": [], "dynamic": [], "days": 0, "incomplete": [], "notes": [] }]
}
```

The VSE results group the errors by rule and path, with array indices as `*`, and list the ten most
frequent groups. Information only, they do not block anything. `data/badges/vse-<version>.json` holds
the result for the files of the utility in the [shields.io endpoint format](https://shields.io/badges/endpoint-badge).

Issues that block a year are listed in [`engine/core/rules.ts`](engine/core/rules.ts). An error of a
single tariff does not block the year: the tariff is left out and listed under `excluded`, for example
a municipality number `#N/A`. Errors of the document as a whole block it, as does a year in which every
tariff has an error.

The hub site serves [`/status.html`](site/status.html), which reads the `checks.json` and `latest.json`
files of every utility and shows them in one table, starting with the standard product.
