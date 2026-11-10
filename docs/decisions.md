# Decisions

## Published files are VSE files with additions

The FAQ of the VSE makes the OpenAPI definition binding. OpenAPI objects allow additional fields, so
`id`, `products` and `_meta` do not break a VSE consumer. An own format would have made this project
incompatible with the tools that utilities and energy management systems already use.

## Products are curated, not derived

The VSE format has no link between `electricity`, `grid`, `metering` and `regional_fees`. EKZ confirmed
in January 2026 that the assignment follows from the tariff type, and that the base price belongs to
energy and not to the grid. This does not decide which of several grid tariffs goes with which energy
tariff. `tariffName` is not unique either: EKZ repeats names across voltage levels.

So `suggest_products.py` proposes combinations and a person verifies them against the price sheet.
`status` shows which is which. A wrong automatic assignment would cause wrong invoices, so it must
not look verified.


## Clusters are parallel tariffs

EKZ splits its dynamic grid tariff into four clusters from 2027. A cluster groups transformer stations with
a similar load pattern. It is not a region: EKZ names no municipalities, assigns customers per tariff year,
and shows the assignment in myEKZ. So this project cannot derive a cluster from an address.

Each cluster is therefore one tariff with its own `id` and stable URL, and one product with a `selection`
field saying how a customer finds out which applies. The tariffs carry `valid_from` and `valid_to` in
`config/source.json`, because the tariff names can change at the turn of the year. Other utilities with local
differentiation (HDN 5.5) work the same way. If a utility publishes a mapping one day, it fits in `selection`.

## One repo for everything shared

`tariff-core` holds schemas, validation, engine and workflows. It replaces `supplier-data-validation`.

## Repository names

Utility repos use the name of the company, shortened where the short form is the established name
(`ekz`, `bkw`, `groupe-e`, `elektrizitaetswerk-wangen`). Infrastructure repos start with `tariff-` or
`utility-`. Repo names are part of the public URLs, so they do not change once consumers use them.

## Python instead of Node for validation

The fetch pipeline was already in Python. One language keeps the semantic checks (time coverage,
product references) next to the schema checks.

## Swiss local time with offset for publishing

The VSE format uses Swiss local time. That is fine, because with an offset every timestamp identifies
exactly one instant: `2026-10-25T02:30:00+02:00` and `2026-10-25T02:30:00+01:00` are one hour apart.
It also fits how the data is used: tariff days, invoices and price sheets follow the Swiss calendar.

- Publishing: Swiss local time with mandatory offset (`vse/`, `latest.json`).
- Computing across sources: UTC (`normalized/`).
- Static windows such as "07:00 to 20:00": wall-clock time without offset. High tariff starts at 07:00
  in summer and winter. Converting these to UTC would be wrong.

Local time without an offset is rejected, because the hour from 02:00 to 03:00 exists twice in October.

The risk lies in the handling of clock changes. On 2026-10-25, a 25-hour day, EKZ and BKW both delivered
96 intervals instead of 100. The last hour is missing. Such days are now flagged as incomplete.

## Source omissions are reported, not filled

EKZ omits the voltage level on electricity, metering and fee tariffs for 2027, although the OpenAPI requires it.
Setting a level would be a guess, so the field stays absent and a warning appears in `_meta.issues`. Here the
published file is less strict than the OpenAPI, and strict VSE consumers may reject those entries.

## Incomplete days are flagged, not filled

Filling gaps would produce prices the utility never published. The day is published as delivered with
`complete: false`, and the run shows a warning.

## Request a specific day

The old fetcher called the API without parameters and took whatever came back. That had two effects:

- A run delayed past midnight lost a day. All five missing EKZ days (2026-08-27 to 2026-10-12) match
  BKW runs after midnight on the following date.
- EKZ answered with its standard tariff and today's date. The archive up to November 2026 therefore
  holds one price per day and not the dynamic tariff.

The fetcher now names `tariff_name` and the day, and looks back three days to close gaps.
