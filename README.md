# tariff-core

The central repository of [Strompreise Schweiz](https://github.com/Strompreise-Schweiz): schemas,
validation, fetching and publishing. Each organization has its own repo that holds only
configuration, corrections and data, and calls the reusable workflows defined here.

```text
tariff-core                         org repo (ekz, bkw, ...)
  schemas/                         config/source.json
  engine/                          curation/<year>.json
  .github/workflows/reusable-*  <- .github/workflows/*.yml (one line each)
                                   data/**  (generated)
```

| Pipeline | Runs | Script | Result |
|---|---|---|---|
| Dynamic | Daily, in the evening | `engine/fetch_and_normalize.py` | `data/dynamic/<id>/latest.json` and archive |
| Static | Weekly, and on changes to `curation/` | `engine/publish_static.py` | `data/tariffs/<year>.json`, `current.json` |
| Validation | On push | `engine/validate.py` | Fails on errors |

## Documentation

- [`SCHEMA.md`](SCHEMA.md): file layout and formats
- [`docs/decisions.md`](docs/decisions.md): why it is built this way
- [`docs/scheduling.md`](docs/scheduling.md): timing of GitHub Actions and external triggers
- [`docs/stable-urls.md`](docs/stable-urls.md): URLs, limits and hosting
- [`docs/vse-notes.md`](docs/vse-notes.md): how the VSE documents and real files differ
- [`docs/adding-organization.md`](docs/adding-organization.md): adding an organization

## Running it locally

From the root of an org repo, with `tariff-core` next to it:

```bash
python3 -m venv ../.venv && source ../.venv/bin/activate   # once per shell
pip install -r ../tariff-core/requirements.txt
python3 ../tariff-core/engine/fetch_and_normalize.py     # dynamic (stdlib only)
python3 ../tariff-core/engine/publish_static.py          # static
python3 ../tariff-core/engine/validate.py                # checks
python3 ../tariff-core/engine/suggest_products.py 2026   # product proposals
```

Tests, from this repo: `pip install -r requirements.txt pytest && python -m pytest tests`

## License

MIT, see [`LICENSE`](LICENSE). This repo contains code only, no tariff data.
