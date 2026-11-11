# tariff-core

The central repository of [Strompreise Schweiz](https://github.com/Strompreise-Schweiz): schemas,
validation, fetching and publishing. It holds code only. The data lives in two kinds of repos, which
hold only configuration, corrections and generated data and call the reusable workflows defined here:

- **Hub repo** [`strompreise-schweiz.github.io`](https://github.com/Strompreise-Schweiz/strompreise-schweiz.github.io):
  all utilities with constant and multilevel tariffs only, one folder each under `utilities/<slug>/`.
- **Own repo** per utility with dynamic tariffs, or one that maintains its data itself (`ekz`, `bkw`, ...).

```text
tariff-core                         hub repo / own repo
  schemas/                         [utilities/<slug>/]config/source.json
  engine/                          [utilities/<slug>/]curation/<year>.json
  .github/workflows/reusable-*  <- .github/workflows/*.yml (one line each)
                                   [utilities/<slug>/]data/**  (generated)
```

All of it is served under one domain, see [`docs/stable-urls.md`](docs/stable-urls.md).

| Pipeline | Runs | Script | Result |
|---|---|---|---|
| Dynamic | Daily, in the evening | `engine/fetch-and-normalize.ts` | `data/dynamic/<id>/latest.json` and archive |
| Static | Weekly, and on changes to `curation/` | `engine/publish-static.ts` | `data/tariffs/<year>.json`, `current.json` |
| Validation | On push | `engine/validate.ts` | Fails on errors |
| Site | After each data change | `engine/build-site.ts` | GitHub Pages under `data.strompreise-schweiz.ch` |

## Documentation

- [`SCHEMA.md`](SCHEMA.md): file layout and formats
- [`docs/decisions.md`](docs/decisions.md): why it is built this way
- [`docs/scheduling.md`](docs/scheduling.md): timing of GitHub Actions and external triggers
- [`docs/stable-urls.md`](docs/stable-urls.md): URLs, limits and hosting
- [`docs/vse-notes.md`](docs/vse-notes.md): how the VSE documents and real files differ
- [`docs/adding-organization.md`](docs/adding-organization.md): adding an organization

## Running it locally

The engine is TypeScript and runs directly on Node.js 26, without a build step. The version is pinned
in [`.nvmrc`](.nvmrc), the same major version Vercel uses by default. Once, in this repo:

```bash
nvm install && nvm use    # Node.js from .nvmrc
npm install
```

On Ubuntu and WSL, Node.js 26 needs `libatomic1`: `sudo apt install libatomic1`.

Then from the root of an org repo or of the hub repo, with `tariff-core` next to it. In the hub, every
utility under `utilities/` is processed:

```bash
node ../tariff-core/engine/fetch-and-normalize.ts     # dynamic (no dependencies)
node ../tariff-core/engine/publish-static.ts          # static
node ../tariff-core/engine/validate.ts                # checks
node ../tariff-core/engine/suggest-products.ts 2026   # product proposals (in the hub: from utilities/<slug>/)
node ../tariff-core/engine/build-site.ts              # site preview in _site/ (no dependencies)
```

Each script prints its options with `--help`. Tests, from this repo: `npm test` and `npm run typecheck`.

## Code layout

```text
engine/
  core/        runs in Node and in the browser: types, repairs, curation, products, validation
  lib/         Node only: files, repo layout and URLs, HTTP, command line
  *.ts         the scripts the workflows run
```

A website imports [`engine/core/index.ts`](engine/core/index.ts) to check a file with the same rules
and issue codes as the workflows.

## License

MIT, see [`LICENSE`](LICENSE). This repo contains code only, no tariff data.
