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

A scheduler outside GitHub can start the workflow through the API. The start is then close to the
requested time, although the job can still wait for a runner. The cron entries stay as a fallback.

Example with a Cloudflare Worker with a cron trigger. It needs a fine-grained token with
`Actions: write` on the org repos, stored as a secret:

```js
const REPOS = ["ekz", "bkw"];

export default {
  async scheduled(event, env) {
    for (const repo of REPOS) {
      const response = await fetch(
        `https://api.github.com/repos/Strompreise-Schweiz/${repo}/actions/workflows/fetch-dynamic.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "strompreise-schweiz-scheduler",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      if (!response.ok) console.error(repo, response.status);
    }
  },
};
```

Cloudflare cron triggers run in UTC. 18:35 Swiss time is `35 17` in winter and `35 16` in summer. Set
both; the second run changes nothing.

## Other behaviour

- GitHub disables scheduled workflows in a public repo after 60 days without repository activity.
  Repos with dynamic tariffs commit daily. Utilities with constant and multilevel tariffs only live in
  the hub repo, which stays active as long as any of them changes. If it is ever disabled, the GitHub
  notification and the "Enable workflow" button handle that case.
- Runs in one repo do not overlap, because the workflow sets `concurrency`.
