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
- Sources deviate from the standard. Add repairs to `engine/normalizers/static_vse.py`, log each one,
  and add a test with the deviation as a fixture.

## Commands

```bash
python -m pytest tests                                  # in tariff-core
python3 ../tariff-core/engine/publish_static.py          # in an org repo
python3 ../tariff-core/engine/fetch_and_normalize.py     # in an org repo
python3 ../tariff-core/engine/validate.py                # in an org repo
python3 ../tariff-core/engine/build_site.py              # in an org repo, site in _site/
```

The scripts also run in the hub repo root and then process every folder under `utilities/`.

The engine for dynamic tariffs uses the Python standard library only. `validate.py` and
`publish_static.py` also need `jsonschema`.

## Reference documents

The VSE PDFs are not in git, because the handbook does not permit redistribution. They are in the
`reference/` folder of the workspace, if present. `docs/vse-notes.md` has the relevant points.
