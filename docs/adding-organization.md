# Adding an organization

1. Find the utility's file. ElCom publishes the links as linked data on
   [LINDAS](https://lindas-cached.cluster.ldbar.ch/sparql/). Check the license terms of the source.
2. Create a repo from [`utility-template`](https://github.com/Strompreise-Schweiz/utility-template).
   Its name becomes `slug`. Repo names are part of the public URLs, so choose carefully.
3. Fill in `config/source.json`. The VSE identifier is on the VSE website.
4. Run locally:

   ```bash
   python3 ../tariff-core/engine/publish_static.py
   ```

5. Resolve the errors in `data/tariffs/<year>.report.json`:
   - Format deviation that recurs: add a repair to `engine/normalizers/static_vse.py` with a test.
   - Wrong data at one utility: add an override with a reason to `curation/<year>.json`. Consider telling the utility.
   - The tariff really is that way: add it to `acceptIssues` with a reason.
6. Propose products, check them against the price sheet, and add them to `curation/<year>.json`:

   ```bash
   python3 ../tariff-core/engine/suggest_products.py 2026
   ```

7. For dynamic tariffs, the URL is in `prices.dynamic.url` of the yearly file. Add an entry per tariff in
   `dynamic`, then start the workflow once by hand under Actions.
