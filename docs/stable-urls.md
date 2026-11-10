# Stable URLs and limits

## URLs

```text
https://raw.githubusercontent.com/Strompreise-Schweiz/<org>/main/data/dynamic/<id>/latest.json
https://raw.githubusercontent.com/Strompreise-Schweiz/<org>/main/data/tariffs/current.json
https://raw.githubusercontent.com/Strompreise-Schweiz/<org>/main/data/index.json
```

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

A URL on `raw.githubusercontent.com` ties all consumers to GitHub and to the repo name. Publishing
`https://data.strompreise-schweiz.ch/<org>/dynamic/<id>/latest.json` before the first external user
makes the backend replaceable without changing the URL.
