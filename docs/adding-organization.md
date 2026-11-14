# Adding an organization

1. Find the utility's file. ElCom publishes the links as linked data on
   [LINDAS](https://lindas-cached.cluster.ldbar.ch/sparql/). Check the license terms of the source.
2. Decide where the utility lives. It is never split between both:
   - **Hub repo** (default): no day prices, maintained by this project. Create `utilities/<slug>/` in
     `strompreise-schweiz.github.io` with `config/source.json` and `curation/`.
   - **Own repo**: the utility has day prices or maintains its data itself. Create a repo from
     [`utility-template`](https://github.com/Strompreise-Schweiz/utility-template), enable Pages with
     source "GitHub Actions", and add it to `repositories.json` in the hub repo.

   The folder or repo name becomes `slug` and part of the public URL, so choose carefully.
3. Fill in `config/source.json`. The VSE identifier is on the VSE website. The ElCom number (`elcom_id`)
   is the last part of the operator URL on LINDAS, `https://energy.ld.admin.ch/elcom/electricityprice/operator/<elcom_id>`.
   For a utility with an own repo, add both also to its entry in `repositories.json`.
   Enter the yearly file under `tariffs`.
4. Run locally, from the root of the utility's repo or of the hub repo:

   ```bash
   node ../tariff-core/engine/fetch.ts
   node ../tariff-core/engine/build.ts
   node ../tariff-core/engine/validate.ts
   ```

5. Resolve what `data/checks.json` lists:
   - Format deviation that recurs: add a repair to `engine/core/tariff-file.ts` with a test.
   - Wrong data at one utility: add an override with a reason to `curation/<year>.json`. Consider telling the utility.
   - The tariff really is that way: add it to `acceptIssues` with a reason.

   After a change to `curation/`, `build.ts` alone is enough.
6. Propose products, check them against the price sheet, and add them to `curation/<year>.json`:

   ```bash
   node ../tariff-core/engine/suggest-products.ts 2026
   ```

   In the hub, run `suggest-products.ts` from `utilities/<slug>/`.
7. For dynamic tariffs, the URL is in `prices.dynamic.url` of the yearly file. Add an entry per tariff
   under `prices` in `config/source.json`, with exactly that `url`: that is how the tariff finds its day
   prices. Then start "Update prices" by hand under Actions. A product with a dynamic tariff gets a day
   file per day in `data/products/<id>/`. A utility in the hub that gets day prices moves to an own repo
   first: remove its hub folder, create the repo with the same name and add it to `repositories.json`.
   Its URLs on the own domain stay the same.
8. Show the VSE conformance badges: in the hub, add a row to the table in its README; in an own repo,
   add the badges from the template README. `build.ts` writes the badge files.
