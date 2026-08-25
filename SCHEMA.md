# Dynamic tariff data — file layout & schema

Every org repo that uses this engine (e.g. `ekz`, `bkw`) produces the same
three-tier layout under `data/dynamic/`:

```
data/dynamic/raw/<year>/<date>.json          # byte-exact source API response
data/dynamic/vse/<year>/<date>.json          # same structure, Swiss local time
data/dynamic/normalized/<year>/<date>.json   # this project's own schema
```

`<date>` is always the **Europe/Zurich calendar day** these prices apply to,
derived from the source data — regardless of which timezone the source API
itself uses for its timestamps. This matters: some sources (e.g. BKW) publish
in UTC, and naively slicing the date out of a UTC string can label a file
with the wrong day.

## `raw/`

Untouched response body as returned by the organization's own API. Shape is
whatever that organization defines. Kept for provenance — if you need to
verify what was actually published on a given day, this is it.

## `vse/`

The raw payload re-emitted with all timestamps converted to Swiss local time
(Europe/Zurich, ISO-8601 with offset), matching the format shown in the
VSE/AES Handbuch "Dynamische Netznutzungstarife im Verteilnetz" (2025),
Kapitel 7.4. Structure and component keys are otherwise untouched — this
exists because not every source actually follows the VSE example format as-is
(e.g. BKW uses UTC `Z` timestamps instead of `+01:00`/`+02:00`).

## `normalized/`

This project's own schema, consistent across every organization:

```jsonc
{
  "schema_version": "1.0",
  "source": {
    "organization": "EKZ (Elektrizitätswerke des Kantons Zürich)",
    "organization_slug": "ekz",
    "country": "CH",
    "api_url": "https://api.tariffs.ekz.ch/v1/tariffs",
    "website": "https://www.ekz.ch",
    "publication_timestamp": "2025-12-18T14:41:44+01:00", // as reported by the source, if any
    "attribution": "Data sourced from ... archived by Strompreise-Schweiz (...)"
  },
  "retrieved_at": "2026-08-25T20:56:10+00:00", // UTC, when this repo fetched the data
  "date": "2026-08-26",                        // Europe/Zurich calendar date these prices apply to
  "tariff_type": "consumption",                // "consumption" (you pay) or "feed_in" (you're paid)
  "timezone": "UTC",                           // interval start/end below are UTC
  "currency": "CHF",
  "resolution_minutes": 15,
  "fixed_charges": {
    "metering": { "chf_per_month": 5.00 }      // non-time-varying, stated once per day, not per interval
  },
  "intervals": [
    {
      "start": "2026-08-25T22:00:00+00:00",
      "end":   "2026-08-25T22:15:00+00:00",
      "components": {
        "electricity":   { "chf_per_kwh": 0.0900 },
        "grid":          { "chf_per_kwh": 0.1098 },
        "integrated":    { "chf_per_kwh": 0.1998 },
        "regional_fees": { "chf_per_kwh": 0.0016 }
      },
      "total_chf_per_kwh": 0.1998
    }
    // ... one entry per interval covering the full day
  ]
}
```

Notes:

- `components` keys are whatever cost buckets the source organization
  reports (e.g. `electricity`, `grid`, `regional_fees`, `feed_in`). Not every
  organization reports the same buckets — treat a missing bucket as absent,
  not zero.
- `fixed_charges` holds any component that's a flat monthly amount
  (`CHF_m` in the source) rather than a per-kWh rate — pulled out once per
  day instead of being repeated in all 96 intervals.
- `total_chf_per_kwh` prefers the source's own `integrated` figure when
  present, otherwise falls back to `feed_in`. `null` if neither applies.
- `chf_per_kwh` values **can be negative** for genuinely market-based dynamic
  prices — don't assume non-negative when consuming this data.

## Adding a new organization

No per-organization code needed if the source follows the VSE wire format
(`{"publication_timestamp":..., "prices": [{"start_timestamp":...,
"end_timestamp":..., "<tariff_type>": [{"unit": "CHF_kWh"|"CHF_m",
"value":...}], ...}]}`) — the `generic_vse` normalizer in
[`engine/normalizers/generic_vse.py`](engine/normalizers/generic_vse.py)
already handles that shape and is used by both EKZ (consumption) and BKW
(feed_in) today.

In the calling org repo, just add `config/source.json`:

```jsonc
{
  "slug": "example",
  "name": "Example Energy AG",
  "country": "CH",
  "api_url": "https://api.tariffs.example.ch/v1/tariffs",
  "website": "https://www.example.ch",
  "normalizer": "generic_vse"
}
```

and a workflow that calls [`reusable-fetch.yml`](.github/workflows/reusable-fetch.yml)
(see `ekz`'s or `bkw`'s `.github/workflows/fetch-tariffs.yml` for the
one-line example).

If a source's raw response doesn't follow the VSE wire format at all, add a
new module under `engine/normalizers/` exposing the same three functions
(`local_date_of`, `to_vse`, `normalize`) and register it in
[`engine/normalizers/__init__.py`](engine/normalizers/__init__.py); point the
org's `config/source.json` at it via `"normalizer"`.

Before wiring up a new source, check that organization's API terms of use —
this project only redistributes data with attribution (see the calling
repo's own `data/LICENSE`); confirm the source allows that before adding it.
