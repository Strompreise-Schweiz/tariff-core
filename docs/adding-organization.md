# Adding an organization

1. Find the utility's file. ElCom publishes the links as linked data on
   [LINDAS](https://lindas-cached.cluster.ldbar.ch/sparql/). Check the license terms of the source.
2. Decide where the utility lives. It is never split between both:
   - **Hub repo** (default): constant and multilevel tariffs only, maintained by this project. Create
     `utilities/<slug>/` in `strompreise-schweiz.github.io` with `config/source.json` and `curation/`.
   - **Own repo**: the utility has dynamic tariffs or maintains its data itself. Create a repo from
     [`utility-template`](https://github.com/Strompreise-Schweiz/utility-template), enable Pages with
     source "GitHub Actions", and add it to `repositories.json` in the hub repo.

   The folder or repo name becomes `slug` and part of the public URL, so choose carefully.
3. Fill in `config/source.json`. The VSE identifier is on the VSE website.
4. Run locally, from the root of the utility's repo or of the hub repo:

   ```bash
   node ../tariff-core/engine/publish-static.ts
   node ../tariff-core/engine/validate.ts
   ```

5. Resolve the errors in `data/tariffs/<year>.report.json`:
   - Format deviation that recurs: add a repair to `engine/core/normalizers/static-vse.ts` with a test.
   - Wrong data at one utility: add an override with a reason to `curation/<year>.json`. Consider telling the utility.
   - The tariff really is that way: add it to `acceptIssues` with a reason.
6. Propose products, check them against the price sheet, and add them to `curation/<year>.json`:

   ```bash
   node ../tariff-core/engine/suggest-products.ts 2026
   ```

   In the hub, run `suggest-products.ts` from `utilities/<slug>/`.
7. For dynamic tariffs, the URL is in `prices.dynamic.url` of the yearly file. Add an entry per tariff in
   `dynamic`, then start the workflow once by hand under Actions. A utility in the hub that gets a
   dynamic tariff moves to an own repo first: remove its hub folder, create the repo with the same name
   and add it to `repositories.json`. Its URLs on the own domain stay the same.
8. Show the VSE conformance badges: in the hub, add a row to the table in its README; in an own repo,
   add the badges from the template README. Publishing writes `data/vse-conformance.json` and the badge files.
