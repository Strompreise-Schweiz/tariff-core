# Strompreise Schweiz

Open data on Swiss electricity tariffs. `tariff-core` holds all logic. Utilities with constant and
multilevel tariffs only live in the hub repo, one folder each under `utilities/<slug>/`. Utilities with
dynamic tariffs, or that maintain their data themselves, have their own repo. Both hold configuration,
corrections and data. See `README.md`, `SCHEMA.md` and `docs/decisions.md`.

## Repos

The workspace folder holds all repos side by side:

- `tariff-core`: schemas, engine, reusable workflows, tests
- `strompreise-schweiz.github.io`: hub repo with utilities without dynamic tariffs, GitHub Pages
  organization site with the own domain and the overall index
- `utility-template`: template for a utility with its own repo
- `ekz`, `bkw`, `groupe-e`: utilities with their own repo
- `.github`: organization profile

## Working agreements

- Everything written to the repos is in English. Tariff names and other source data stay as published.
- Philipp makes the commits himself unless he asks otherwise. Do not commit or push by default.
- Each repo has its own git history. Group changes per repo and name the order when repos depend on
  each other: `tariff-core` first, because org repos use its workflows from `main`.
- Never edit `data/**` by hand, it is generated. To fix data, change `curation/<year>.json`.
- Never invent tariff values. Mark what is missing or incomplete.

## Domain rules

- The binding format is the VSE OpenAPI definition, see `docs/vse-notes.md`. Own additions are only
  additive, so a published file stays a valid VSE file.
- Tariff forms: `constant`, `multilevel`, `dynamic`.
- Tariff types: `electricity`, `grid`, `metering`, `regional_fees`.
- Static prices exclude VAT. Price windows are Swiss wall-clock time.
- Dynamic timestamps are Swiss local time with an offset. A day has 23, 24 or 25 hours, so do not
  hardcode 96 intervals.
- Sources deviate from the standard. Add repairs to `engine/core/normalizers/static-vse.ts`, log each one,
  and add a test with the deviation as a fixture.

## Commands

```bash
npm test && npm run typecheck                         # in tariff-core
node ../tariff-core/engine/publish-static.ts          # in an org repo
node ../tariff-core/engine/fetch-and-normalize.ts     # in an org repo
node ../tariff-core/engine/validate.ts                # in an org repo
node ../tariff-core/engine/build-site.ts              # in an org repo, site in _site/
```

The scripts also run in the hub repo root and then process every folder under `utilities/`.

The engine is TypeScript, run directly by Node.js 26 (`.nvmrc`) without a build step. Use only
erasable TypeScript syntax (no `enum`, no parameter properties) and import with the `.ts` extension.
File names are kebab-case.

- `engine/core/` must not use Node APIs, so a website can import it. Swiss time comes from `Intl`.
- `engine/lib/` holds the Node helpers, the scripts are directly in `engine/`.
- The dynamic pipeline and `build-site.ts` use Node built-ins only. `validate.ts` and
  `publish-static.ts` also need `ajv` (`npm install` in tariff-core).
- Types of the published files are in `engine/core/types.ts` and follow the schemas.
- Archived day files from before 2.0 have no `_meta`. They are real history and stay as they are.

## Reference documents

The VSE PDFs are not in git, because the handbook does not permit redistribution. They are in the
`reference/` folder of the workspace, if present. `docs/vse-notes.md` has the relevant points.
