# Scheduling

## What GitHub Actions guarantees

No start time is guaranteed. The GitHub documentation states that the `schedule` event can be delayed
during high load and that queued jobs may be dropped.

Measured in this project with a cron of 17:30 UTC (August to November 2026):

| | EKZ | BKW |
|---|---|---|
| Runs | 64 | 68 |
| Median delay | 2 h 58 min | 3 h 04 min |
| 90th percentile | 4 h 17 min | 4 h 36 min |
| Longest | 8 h 03 min | 8 h 03 min |

Measured from `retrieved_at` in the archive.

## What is set up

Three runs per evening in `Europe/Zurich` (`timezone:` key, available since March 2026). They are
idempotent: if the data is there, nothing changes and nothing is committed.

The run fails if tomorrow's data is missing after 21:00. GitHub then notifies the person who last changed the schedule, depending on their notification settings.
Set `alert_after_hour` per tariff if a utility publishes later.

## For a reliable time: external trigger

A scheduler outside GitHub can start `fetch-dynamic.yml` through the `workflow_dispatch` API. The start
is then close to the requested time, although the job can still wait for a runner. The scheduler needs
a fine-grained token with `Actions: write` on the org repos. The cron entries stay as a fallback, and
runs are idempotent, so an extra run changes nothing.

## Other behaviour

- GitHub disables scheduled workflows in a public repo after 60 days without repository activity.
  Repos with dynamic tariffs commit daily. Utilities with constant and multilevel tariffs only live in
  the hub repo, which stays active as long as any of them changes. If it is ever disabled, the GitHub
  notification and the "Enable workflow" button handle that case.
- Runs in one repo do not overlap, because the workflow sets `concurrency`.
