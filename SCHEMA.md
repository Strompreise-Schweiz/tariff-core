# File layout and formats

Every utility has the same layout, in the root of its own repo or in `utilities/<slug>/` of the hub
repo `strompreise-schweiz.github.io`. The principle: **the published files are VSE files with
additional fields.** A program written for the VSE format can read them. One exception: if the source
omits `customerVoltageLevel`, it stays absent and `_meta.issues` reports it.

```text
data/index.json                          all URLs of this organization
data/tariffs/<year>.json                 static tariffs of one year
data/tariffs/current.json                copy of the current year, stable URL
data/tariffs/<year>.report.json          only if the year has errors
data/static/raw/<source>.json            byte-exact source
data/dynamic/<id>/latest.json            today + tomorrow, stable URL
data/dynamic/<id>/raw/<year>/<date>.json          byte-exact source
data/dynamic/<id>/vse/<year>/<date>.json          VSE format, Swiss local time
data/dynamic/<id>/normalized/<year>/<date>.json   own format, UTC
```

`<date>` is always the Swiss calendar day the prices apply to.

The hub repo also has `repositories.json`, the list of utilities with an own repo, from which
`build_site.py` writes the overall `index.json` of the site. GitHub Pages serves each utility's `data/`
folder under `https://data.strompreise-schweiz.ch/<slug>/`, with the dynamic archive of the current year only.
`data/index.json` names the utility's `repository` and `site`.

## Three tariff forms

| `tariffForm` | Where the prices are | Rules checked by `validate.py` |
|---|---|---|
| `constant` | `prices.energy` with one entry, `from` = `to` = `00:00` | One price, no time restriction |
| `multilevel` | `prices.energy` with several entries | Every minute of every month and weekday has exactly one price |
| `dynamic` | `prices.dynamic.url` in the yearly file, prices in `data/dynamic/<id>/` | URL required |

The fixed parts of a dynamic tariff (`base`, `refundStorage`) stay in the yearly file.

## Static: `data/tariffs/<year>.json`

Schema: [`schemas/tariff-document/v1.schema.json`](schemas/tariff-document/v1.schema.json).

```jsonc
{
  "dsoName": "EKZ",                 // VSE
  "dsoNumber": 10153012345,         // VSE
  "tariffs": [{                     // VSE, unknown source fields are kept
    "id": "grid-ekz-netz-400st-ne7",  // ADDED: stable key, tariffName is not unique
    "tariffName": "EKZ Netz 400ST",
    "tariffType": "grid",           // electricity | grid | metering | regional_fees
    "tariffForm": "constant",       // constant | multilevel | dynamic
    "customerVoltageLevel": 7,
    "customerType": "...",
    "startDate": "2026-01-01",
    "endDate": "2026-12-31",
    "prices": { "base": {...}, "energy": [...] }
  }],
  "products": [{                    // ADDED: which tariffs belong together
    "id": "ekz-standard",
    "name": "Standard tariff",
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
  "_meta": {                        // ADDED
    "year": 2026,
    "source": [...],                // URL and SHA-256 of the source
    "pricesExcludeVat": true,
    "repairs": [...],               // automatic format repairs
    "overrides": [...],             // manual corrections with reasons
    "issues": [...]                 // warnings and accepted issues
  }
}
```

Several parallel variants of a tariff, such as EKZ grid clusters, are separate tariffs and products,
each with its own URL. See `docs/decisions.md`.

A product's total energy price is the sum of its components. The regional fees depend on the
municipality, so the consumer selects the entry. Prices exclude VAT.

The `from` and `to` values are Swiss wall-clock time and do not change at a clock change.

## Dynamic: `latest.json` and `vse/`

Schema: [`schemas/dynamic-day/v1.schema.json`](schemas/dynamic-day/v1.schema.json).

```jsonc
{
  "publication_timestamp": "2026-11-01T17:02:00+01:00",
  "_meta": {
    "valid_from": "2026-11-02T00:00:00+01:00",
    "valid_to": "2026-11-04T00:00:00+01:00",
    "days": [{"date": "2026-11-02", "complete": true}, {"date": "2026-11-03", "complete": true}]
  },
  "prices": [{
    "start_timestamp": "2026-11-02T00:00:00+01:00",
    "end_timestamp": "2026-11-02T00:15:00+01:00",
    "grid": [{"unit": "CHF_kWh", "value": 0.1098}, {"unit": "CHF_m", "value": 0.0}]
  }]
}
```

Rules for consumers:

- Parse the offset. Never compare timestamps as text across a clock change.
- A day has 92 intervals in March, 96 normally and 100 in October (with 15-minute values).
- Check `_meta.days[].complete`. Incomplete days are published as delivered and never filled in.
- Prices can be negative.
- `integrated` = `grid` + `electricity`. Do not add it to them, also not its `CHF_m` values.
- Missing components are absent, not zero.
- `_meta.additions` lists what was added to the source data.

`normalized/` contains the same data with UTC timestamps and deduplicated monthly charges. See the
`normalize` function in [`engine/normalizers/generic_vse.py`](engine/normalizers/generic_vse.py).

## Input: `config/source.json` and `curation/<year>.json`

Schemas: [`schemas/source-config/`](schemas/source-config/v1.schema.json) and
[`schemas/curation/`](schemas/curation/v1.schema.json).

`curation/<year>.json` holds everything a person adds. Every entry needs a `reason`:

| Key | Purpose | Example |
|---|---|---|
| `overrides` | Change fields | Voltage level is 0 in the source, set 7 |
| `removeTariffs` | Drop an entry | Test tariff in the source |
| `addTariffs` | Add a missing entry | Metering tariff is not in the file |
| `products` | Product mapping | Electricity + grid + metering + fees |
| `acceptIssues` | Accept a known issue | The gap is really in the utility's tariff |

A rule that no longer matches anything is an error, so outdated corrections become visible.

Issues that block publication are listed in `engine/validate.py`. A year with errors is not
published: the previous file stays online and `<year>.report.json` shows the reasons.
