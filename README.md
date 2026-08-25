# tariff-etl

Shared fetch/normalize engine for the [Strompreise Schweiz](https://github.com/Strompreise-Schweiz)
dynamic-tariff archives (e.g. [`ekz`](https://github.com/Strompreise-Schweiz/ekz),
[`bkw`](https://github.com/Strompreise-Schweiz/bkw)).

Each org repo stays thin — its own `config/source.json` plus a one-line
GitHub Actions workflow that calls the [reusable workflow](.github/workflows/reusable-fetch.yml)
defined here. This repo holds the actual logic (fetch → normalize → write),
so it only needs to be maintained in one place as more organizations are
added.

```
config/source.json  (in the calling repo)
        │
        ▼
tariff-etl/.github/workflows/reusable-fetch.yml   (checks out this repo + the caller)
        │
        ▼
tariff-etl/engine/fetch_and_normalize.py          (fetch, normalize, write data/dynamic/**)
        │
        ▼
git commit + push (back into the calling repo)
```

See [`SCHEMA.md`](SCHEMA.md) for the exact file layout and JSON schema this
produces, and its "Adding a new organization" section for how a new org repo
plugs in.

## Running it locally

From within a calling org repo (one that has its own `config/source.json`):

```bash
python3 /path/to/tariff-etl/engine/fetch_and_normalize.py
```

Stdlib-only, no dependencies to install.

## License

MIT — see [`LICENSE`](LICENSE). This repo contains only code/engine logic,
no archived tariff data.
