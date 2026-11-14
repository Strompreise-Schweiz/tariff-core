# Strompreise Schweiz

Open data on Swiss electricity tariffs. `tariff-core` holds all logic. Utilities without day prices
live in the hub repo, one folder each under `utilities/<slug>/`. Utilities with day prices (dynamic
tariffs), or that maintain their data themselves, have their own repo. See `README.md`, `SCHEMA.md` and
`docs/decisions.md`.

Every utility has four places: `config/source.json` (where the data comes from), `curation/<year>.json`
(what a person changes, with reasons), `data/checks.json` (what is wrong) and `data/` (what is
published). `fetch.ts` stores what the utility publishes unchanged in `data/sources/`; `build.ts` makes
everything else from there and from `curation/`, offline.

## Repos

The workspace folder holds all repos side by side:

- `tariff-core`: schemas, engine, reusable workflows, tests
- `strompreise-schweiz.github.io`: hub repo with utilities without day prices, GitHub Pages
  organization site with the own domain and the overall index
- `utility-template`: template for a utility with its own repo
- `ekz`, `bkw`, `groupe-e`: utilities with their own repo
- `.github`: organization profile

## Working agreements

- Everything written to the repos is in English. Tariff names and other source data stay as published.
- Philipp makes the commits himself unless he asks otherwise. Do not commit or push by default.
- Each repo has its own git history. Group changes per repo and name the order when repos depend on
  each other: `tariff-core` first, because org repos use its workflows from `main`.
- Never edit `data/**` by hand, it is generated (except `data/supplier.json` and the logo in the hub).
  To fix data, change `curation/<year>.json`.
- Never invent tariff values. Mark what is missing or incomplete.

## Domain rules

- The binding format is the VSE OpenAPI definition. The versions are in `schemas/vse/`, the differences
  to real files in `docs/vse-notes.md`. Own additions are only additive, so a published file stays a
  valid VSE file. `data/checks.json` shows per utility which versions its files follow. Own files are
  written in 1.0.1, sources in 1.0.0 are read and converted (`So` becomes `Su`).
- Tariff forms: `constant`, `multilevel`, `dynamic`.
- Tariff types: `electricity`, `grid`, `metering`, `regional_fees`.
- Prices exclude VAT. Price windows are Swiss wall-clock time, written as in VSE 1.0.1: the
  day ends at `23:59`, `from` < `to`, a window across midnight is split in two.
- Timestamps of day prices are Swiss local time with an offset. A day has 23, 24 or 25 hours, so do not
  hardcode 96 intervals.
- Sources deviate from the standard. Add repairs to `engine/core/tariff-file.ts` (yearly file) or
  `engine/core/price-day.ts` (day prices), log each one, and add a test with the deviation as a fixture.
- Day files are always quarter hours. A day is complete only if every quarter hour has a price per kWh.

## Commands

```bash
npm test && npm run typecheck                         # in tariff-core
node ../tariff-core/engine/fetch.ts                   # in an org repo: download into data/sources/
node ../tariff-core/engine/build.ts                   # in an org repo: build data/ (offline)
node ../tariff-core/engine/validate.ts                # in an org repo
node ../tariff-core/engine/build-site.ts              # in an org repo, site in _site/
```

The scripts also run in the hub repo root and then process every folder under `utilities/`.

The engine is TypeScript, run directly by Node.js 26 (`.nvmrc`) without a build step. Use only
erasable TypeScript syntax (no `enum`, no parameter properties) and import with the `.ts` extension.
File names are kebab-case.

- `engine/core/` must not use Node APIs, so a website can import it. Swiss time comes from `Intl`.
- `engine/lib/` holds the Node helpers, the scripts are directly in `engine/`.
- `fetch.ts` and `build-site.ts` use Node built-ins only. `build.ts` and `validate.ts` also need
  `ajv` and `yaml` (`npm install` in tariff-core).
- Types of the published files are in `engine/core/types.ts` and follow the schemas.
- `data/sources/` is real history. Never delete or rewrite a stored response; `build.ts` derives
  everything else from it.

## Reference documents

The VSE PDFs are not in git, because the handbook does not permit redistribution. They are in the
`reference/` folder of the workspace, if present. `docs/vse-notes.md` has the relevant points.
