# Stable URLs and limits

## URLs

Use the own domain. It stays the same whether a utility lives in the hub repo or in its own repo:

```text
https://data.strompreise-schweiz.ch/index.json                        every utility
https://data.strompreise-schweiz.ch/<slug>/index.json                 all URLs of one utility
https://data.strompreise-schweiz.ch/<slug>/tariffs/current.json
https://data.strompreise-schweiz.ch/<slug>/dynamic/<id>/latest.json
```

The site is GitHub Pages: the hub repo `strompreise-schweiz.github.io` is the organization site with the
own domain, each org repo a project site under `/<repo>/`. It serves the dynamic archive of the current
year only, because a Pages site is limited to 1 GB.

The same files are also in git, including all archive years:

```text
https://raw.githubusercontent.com/Strompreise-Schweiz/<slug>/main/data/...                                    own repo
https://raw.githubusercontent.com/Strompreise-Schweiz/strompreise-schweiz.github.io/main/utilities/<slug>/data/...   hub
```

These contain the repo name and change when a utility moves.

## raw.githubusercontent.com

The URL stays the same while the content changes. Observed response headers:
`cache-control: max-age=300` (so up to 5 minutes old) and `access-control-allow-origin: *` (usable from a browser).

## Limits

GitHub applies rate limits to unauthenticated requests to `raw.githubusercontent.com` since May 2025.
It publishes no number for this, and responses have no rate-limit headers. A 429 response is the signal.

- Limits apply per client address, not per file. One system fetching a few files a day is unproblematic.
- Unlimited fetching is not possible. A server that fetches hundreds of files, or many users behind
  one address, can hit the limit.
- Consumers should cache the file and fetch it only as needed.

## When usage grows

| Option | Limit | Note |
|---|---|---|
| `raw.githubusercontent.com` | Unpublished, per address | Free. Not meant as an API. |
| GitHub Pages | 100 GB per month (soft), 1 GB per site, can return 429 | Own domain possible. Not meant as hosting for a commercial service. |
| Cloudflare in front of GitHub | Per Cloudflare plan | Cached, so GitHub sees few requests |

With up to about 90 KB per `latest.json` (a tariff with several components), 100 GB is roughly one million fetches a month.

## Own domain: the only URL that stays yours

A URL on `raw.githubusercontent.com` ties all consumers to GitHub and to the repo name. The own domain
must be live before the first external user. Then the backend can change, for example to Cloudflare in
front of GitHub, without changing a URL.

Setting it up, once:

1. DNS: a `CNAME` record `data.strompreise-schweiz.ch` pointing to `strompreise-schweiz.github.io`.
2. Hub repo: Settings > Pages > Source "GitHub Actions", custom domain `data.strompreise-schweiz.ch`, "Enforce HTTPS".
3. Each org repo: Settings > Pages > Source "GitHub Actions". No own domain: it inherits the hub's.
4. Verify the domain for the organization under Settings > Pages, so nobody else can claim it.
