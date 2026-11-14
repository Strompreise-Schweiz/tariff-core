# File layout and formats

Every utility has the same layout, in the root of its own repo or in `utilities/<slug>/` of the hub
repo `strompreise-schweiz.github.io`. The principle: **what the utility publishes is stored unchanged,
and everything published here is built from it plus the corrections of a person.**

```text
config/source.json                         where the data comes from               person
curation/<year>.json                       corrections and products, with reasons  person

data/sources/tariffs/<name>.json           yearly file of the utility, unchanged    fetch.ts
data/sources/prices/<id>/<year>/<date>.json  API response, unchanged                fetch.ts

data/tariffs/<year>.json                   yearly file, repaired and corrected      build.ts
data/tariffs/current.json                  copy of the current year, stable URL     build.ts
data/prices/<id>/<year>/<date>.json        day prices of one API, corrected         build.ts
data/prices/<id>/latest.json               today + tomorrow, stable URL             build.ts
data/products/<id>/<year>/<date>.json      every component of a product per 15 min  build.ts
data/products/<id>/latest.json             today + tomorrow, stable URL             build.ts
data/checks.json                           what is wrong with all of the above      build.ts
data/badges/vse-<version>.json             badges for the README                    build.ts
data/index.json                            all URLs of this utility                 build.ts
```

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
| `dynamic` | `prices.dynamic.url`: the day prices in `data/prices/<id>/` | URL required |

The fixed parts of a dynamic tariff (`base`, `refundStorage`) stay in the yearly file.

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
`url`. That is how `build.ts` points the tariff to the day prices of this project. A dynamic tariff
without a price source keeps the URL of the utility, with the warning `dynamic_without_prices`.

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
| `products` | Which tariffs belong together | Electricity + grid + metering + fees |
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
        "url": "https://data.strompreise-schweiz.ch/ekz/prices/grid-400d/latest.json",
        "sourceUrl": "https://api.tariffs.ekz.ch/v1/tariffs?tariff_name=grid_400D_inclFees"  // ADDED
      }
    }
  }],
  "products": [{                    // ADDED: which tariffs belong together
    "id": "energie-dynamisch-netz-400d",
    "name": "EKZ Energie Dynamisch + Netz 400D",
    "selection": {                  // optional: the customer must belong to this group
      "kind": "grid-cluster", "value": "1", "howToFind": "Shown in myEKZ"
    },
    "status": "verified",           // suggested | verified
    "sourceUrl": "https://...",     // required when verified
    "components": {
      "electricity": "electricity-...",
      "grid": "grid-...",
      "metering": "metering-...",
      "regional_fees": "regional-fees-..."
    }
  }],
  "_meta": {                        // ADDED: how the file was built
    "schemaVersion": "2.0",         // format of this project
    "vseVersion": "1.0.1",          // VSE definition the file follows
    "generator": { "name": "tariff-core", "version": "4.0.0", "url": "..." },
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

## Day prices: `data/prices/<id>/` and `data/products/<id>/`

Schema: [`schemas/price-day/v1.schema.json`](schemas/price-day/v1.schema.json). The format of HDN 2025,
chapter 7.4, one file per Swiss calendar day, without query parameters. Always in quarter hours: an
hourly value of the API becomes four equal quarter-hour values (HDN 5.3).

- **`prices/<id>/`**: what one API sends, with the corrections of `curation/<year>.json` applied.
  `prices.dynamic.url` of the yearly file points here.
- **`products/<id>/`**: for each product with a dynamic tariff, every component a customer pays per
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
    "prices": ["electricity-dynamic", "grid-400d"],
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

`latest.json` holds today and, once published, tomorrow. `_meta.days[]` says which days it holds and
whether each is complete.

## Checks: `data/checks.json` and `/status.html`

Everything that is wrong, in one place, written by `build.ts` without timestamps:

```jsonc
{
  "summary": { "errors": 0, "warnings": 10, "accepted": 0, "incompleteDays": 1 },
  "sources": {
    "tariffs": [{ "name": "ekz-all", "url": "...", "sha256": "...",
                  "vse": { "1.0.0": {...}, "1.0.1": {...} } }],   // the file of the utility vs. VSE
    "prices": [{ "id": "grid-400d", "url": "...", "enabled": true, "days": 6, "first": "...", "last": "..." }]
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
  "prices": [{ "id": "electricity-dynamic", "days": 7,
               "incomplete": [{ "date": "2026-11-14", "issues": ["96 of 96 intervals have no price per kWh"] }] }],
  "products": [{ "id": "...", "year": 2026, "days": 6, "incomplete": [...], "notes": [] }]
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
files of every utility and shows them in one table.
