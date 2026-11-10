# Notes on the VSE documents

Own summary. The original documents are not redistributed here.

## Sources

| Document | Content |
|---|---|
| OpenAPI definition, [strom.ch/api-tariff-definition](https://www.strom.ch/api-tariff-definition) | Static tariffs, **binding** |
| NNMV 2025, annex 10 and chapter 7.3 | Static tariffs, example is illustrative only |
| FAQ machine-readable tariffs (2025) | Interpretations, states that OpenAPI is binding |
| HDN 2025, chapter 7 | Dynamic tariffs: API format and query parameters |
| HDN annexes 1 to 3 | Examples: Groupe E Vario, Swisspower, AEM |

## Legal background

Art. 7b StromVV: utilities publish network, electricity and fee tariffs by 31 August at a single
free address, machine-readable. Publishing on an API is voluntary for dynamic tariffs (HDN 7.6).
There is no legal requirement for a machine-readable electricity label (EKZ, January 2026).

## Differences between documents and real files

| Topic | OpenAPI | NNMV annex 10 | Seen in real files | Handling |
|---|---|---|---|---|
| Date | `2026-01-01` | `01.01.2026` | ISO at EKZ | Repaired |
| Operator | Top level | Per tariff | Top level at EKZ | Repaired |
| Base price | Object with unit | Number | Object at EKZ | Repaired |
| Energy | `prices.energy` | Nested `prices`, sometimes `prices.grid` | Direct list at EKZ | Repaired |
| Day | `weekdays` | `day: "*"` | `weekdays` at EKZ | Repaired |
| Sunday | `So` | `su` | `Su` at EKZ | Repaired to `So` |
| End of day | `00:00` (FAQ) | `00:00` | `23:59` at EKZ | Repaired to `00:00` |
| Refund | `prices.refundStorage` positive | `tariffType: refund` negative | `refundStorage` at EKZ | Repaired |
| Type | Enum | `" regional_fees "` with spaces | | Repaired |
| Voltage level | 2 to 7 | 2 to 7 | 0 at EW Uznach | Blocked, needs curation |
| End date | Date | Date | 2099 at EW Uznach | Blocked, needs curation |
| Prices vs PDF | | | HT/NT in JSON, single rate in PDF at EW Uznach | Only a person can see this |
| Several years | Not addressed | One document per utility | 2026 and 2027 in one file at EKZ | Split by year |
| Municipality no. | 5 digits | `352` | `12389` at EKZ | Any positive integer allowed |
| Extra fields | Allowed | | `standardBasegroup`, `url` at EKZ | Kept |
| Voltage level missing | Required | | Absent on 10 of 22 EKZ tariffs for 2027 (electricity, metering, fees) | Warning, not invented |
| Same name | "Should be unique" | Repeated across types | Repeated at EKZ | Own `id` |

## Dynamic tariffs

- Query: `base_url?tariff_type=&tariff_name=&start_timestamp=&end_timestamp=`. Any time zone is allowed.
- Without `tariff_name`, the standard tariff for the base customer group is returned, without
  timestamps the current day (HDN 7.4.1). At EKZ the archive shows this behaviour.
- Recommended: published between 12:00 and about 18:00 on the day before, in 15-minute or hourly values (HDN 5.3).
- Seen: Groupe E from 17:00, Swisspower by 16:00, EKZ from 18:00.
- Types (table 3): `electricity`, `feed_in`, `grid`, `integrated` (= grid + electricity), `regional_fees`.
- Example in HDN 7.4.1 uses `tariff_type=dso` for what table 3 calls `grid`.
- Prices can be negative (HDN 5.4.3, annex 1).
- Tariffs can differ by location or customer (HDN 5.5). EKZ has four clusters from 2027.
- If nothing is published, the tariff rules define a fallback (HDN 7.2). At EKZ the standard tariff applies if the API is not available by 20:00 the day before. This project does not apply fallbacks, so the data cannot show if one applied.
- Other Swiss APIs: the evcc project has templates for BKW, CKW, EKZ and Groupe E.
