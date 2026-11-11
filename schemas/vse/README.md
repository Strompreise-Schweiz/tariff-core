# VSE OpenAPI definitions for static tariffs

The binding format for the machine-readable tariff files of Swiss utilities, published by the VSE
(Verband Schweizerischer Elektrizitätsunternehmen) at
[strom.ch/api-tariff-definition](https://www.strom.ch/api-tariff-definition). The content is kept
unchanged. The VSE file names do not contain the version, and the newer one carries a download suffix
(`_0`), so the files here keep the VSE name and add the version from `info.version`.

| File | Version | Original file name |
|---|---|---|
| [`ch-electricity-tariffs-openapi-1.0.0.yaml`](ch-electricity-tariffs-openapi-1.0.0.yaml) | 1.0.0 | `ch-electricity-tariffs-openapi` |
| [`ch-electricity-tariffs-openapi-1.0.1.yaml`](ch-electricity-tariffs-openapi-1.0.1.yaml) | 1.0.1 | `2026-ch-electricity-tariffs-openapi_0` |

## Changes from 1.0.0 to 1.0.1

| Topic | 1.0.0 | 1.0.1 |
|---|---|---|
| `customerVoltageLevel` | Required for every tariff | Optional, required for `tariffType` `grid` only (stated in the description, not enforced by the schema) |
| `standardBasegroup` | Not defined | New boolean, default `false`: the standard tariff of the basic customer group, at most one per `electricity` and `grid` |
| Sunday in `weekdays` | `So` | `Su` |
| `weekdays` | Required in a time-based price | Optional |
| `from` and `to` | Format `HH:MM` only | `from` must be less than `to`. `00:00` is the start, `23:59` the end of the day (stated in the description, not enforced by the schema) |
| Price units | `CHF/kWh`, `CHF/kW`, `CHF/kW/M`, `CHF/kVarh`, `CHF/M`, `CHF` | Adds `CHF/kW/Y`, Swiss francs per kilowatt per year |
| `power` | Unit `CHF/kW/M` | Unit `CHF/kW/M` or `CHF/kW/Y` |
| `municipalityNumber` | 10000 to 99999, the historical 5-digit number | 1 to 99999, the number of the Federal Statistical Office |

Unchanged in both: constant prices are one entry with empty `months` and `weekdays` and `from` =
`to` = `00:00`. In 1.0.1 this contradicts the rule that `from` must be less than `to`.

## How this project uses them

- **Writing:** the files of this project follow 1.0.1 and say so in `_meta.vseVersion`. The own schema
  [`tariff-document`](../tariff-document/v1.schema.json) is 1.0.1 with additive fields. Time windows:
  the end of the day is `23:59`, `from` is less than `to`, and a window across midnight is split in two.
  A whole day is `00:00` to `00:00` or `00:00` to `23:59`, kept as the source writes it.
- **Reading:** sources may follow 1.0.0 or 1.0.1. The repairs in
  [`engine/core/normalizers/static-vse.ts`](../../engine/core/normalizers/static-vse.ts) write `So` as
  `Su`, and the 1.0.1 rules are looser in every other point, so a 1.0.0 file needs no other change. The
  meaning of `municipalityNumber` changed from the historical to the current number of the Federal
  Statistical Office, which no program can convert: the value is kept as published.
- **Checking:** every file is checked against both versions when static tariffs are published:

  - **sources:** the files as the utility published them, in `data/static/raw/` or `curation/`
  - **published:** the files of this project, `data/tariffs/<year>.json`

The result is in `data/vse-conformance.json` of each utility, and in the badges
`data/badges/vse-<version>.json`, which a README shows through shields.io. It is information only and
does not block publication: the semantic rules of this project, in
[`engine/core/rules.ts`](../../engine/core/rules.ts), decide that.

To check a file yourself, the definitions work with any OpenAPI 3.0 tool, or with
[`engine/core/vse.ts`](../../engine/core/vse.ts).
