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

So `suggest-products.ts` proposes combinations and a person verifies them against the price sheet.
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

`tariff-core` holds schemas, validation, engine and workflows. It replaced `supplier-data-validation`,
which has been deleted.

## Hub repo for utilities without dynamic tariffs

Most utilities will not maintain their data themselves; this project does it for them. Switzerland has
about 600 grid operators, and one repo per utility does not scale for that:

- Constant and multilevel tariffs change about once a year. A repo without commits for 60 days loses its
  scheduled workflows, so the weekly check would stop unnoticed.
- A change to the workflow files would have to be repeated in every repo.
- There would be no list of all utilities.

So a utility lives in exactly one place:

- **Own repo** if it has dynamic tariffs or maintains its data itself. Dynamic tariffs commit every day
  and grow the archive by about 70 MB per tariff and year, and an outage at one utility stays in its repo.
- **Hub repo** `strompreise-schweiz.github.io` otherwise, in `utilities/<slug>/` with the same layout as
  an own repo. One workflow run covers all of them, and corrections arrive as pull requests.

The engine accepts both: run from a repo root it processes either the one utility or every folder
under `utilities/`. `validate.ts` rejects enabled dynamic tariffs in the hub and a folder name that
differs from `slug`. A utility is never split between both places.

## Own domain through GitHub Pages

URLs on `raw.githubusercontent.com` contain the repo name, so moving a utility between the hub and an
own repo would break every consumer. The hub repo is therefore the organization site of GitHub Pages
and carries the own domain `data.strompreise-schweiz.ch`. Org repos are project sites, which GitHub
serves under the same domain at `/<repo>/`. `build-site.ts` gives both the same layout:

```text
https://data.strompreise-schweiz.ch/index.json            every utility
https://data.strompreise-schweiz.ch/<slug>/index.json     one utility, hub or own repo
```

Moving a utility means removing its hub folder and enabling Pages in its repo, or the reverse.
No URL changes. A Pages site is limited to 1 GB, so it serves the dynamic archive of the current year
only. Older years stay in git and on `raw.githubusercontent.com`.

## Repository names

Utility repos and hub folders use the name of the company, shortened where the short form is the
established name (`ekz`, `bkw`, `groupe-e`, `elektrizitaetswerk-wangen`). Infrastructure repos start with
`tariff-` or `utility-`. These names are part of the public URLs, so they do not change once consumers use them.

## TypeScript on Node.js for the whole engine

Until November 2026 the engine was Python. It moved to TypeScript so that the same validation runs in
the workflows, locally and in the browser, for example on a website that checks a file before upload.
A website in JavaScript would otherwise need a second implementation of the semantic checks (time
coverage, product references), and two implementations drift apart. The rest of the engine moved too,
so the project has one language and one toolchain.

- Node.js 26 runs the `.ts` files directly, without a build step. The version is pinned in `.nvmrc`,
  the major version Vercel uses by default.
- `engine/core/` uses no Node APIs. Swiss time comes from `Intl`, which every browser has, and the
  short hash in tariff ids is FNV-1a, because Web Crypto has no synchronous hash.
- Dependencies stay few: `ajv` and `ajv-formats` for JSON Schema. The dynamic pipeline and the site
  build need no packages.
- Nothing was in production yet, so the move did not keep Python's quirks. Run on copies of all
  repos, the new engine produced the same tariff data, products and issue codes. Ids of tariffs that
  share a name got a new hash suffix, and messages are worded differently.

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

## A broken tariff is left out, not the whole year

A tariff with an error of its own is removed from the published file and listed in `_meta.excluded`
with its problems. The rest of the year is published. Before, one broken tariff blocked the year: at
BKW in November 2026, a municipality number `#N/A` in 9 of about 1000 tariffs kept all of them back.

Errors of the document as a whole still block it, because they make every tariff doubtful: a wrong
operator number, ids that are not unique, a correction that no longer matches, or a curated product
that needs a left-out tariff. A year in which every tariff has an error is blocked too, so no empty
file replaces a good one. The status page shows how many tariffs were left out.
