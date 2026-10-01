# How this dashboard gets deployed

**Cloudflare deploys it automatically from `claude/news-feed-loading-yx55qa`.**
Pushing to that branch is the deploy. There is no deploy button, no workflow to
run, and no API token in this repository.

This is written down because it was not, and that cost something: a GitHub
Actions deploy workflow sat in `.github/workflows/deploy.yml` and failed every
time it was run, because the `CLOUDFLARE_API_TOKEN` secret it wanted had never
been set. Reading that failure, I told the user the branch was not deployed.
It was. The branch had been live the whole time, put there by Cloudflare's Git
integration, which nothing in the repo mentioned.

A failed deploy workflow means the workflow could not authenticate. It does
not mean the code is not live. Those are different facts.

## Confirming what is actually serving

The Worker stamps every response with its own build:

```
curl -sI https://drec-oncall-updates-site.lacey-wood.workers.dev/api/outages/nsw \
  | grep -i x-worker-build
```

Compare that against `WORKER_BUILD` in `src/worker.js`. If they match, the
branch is live. Actions → **Live check** → Run workflow does the same
comparison and prints both, and it needs no credential because it only reads.

The page carries the same stamp in `EXPECTED_WORKER_BUILD` and shows a "Worker
out of date" warning when the two disagree. `test/build_stamp.test.mjs` pins
them together so the warning cannot go stale again — it was wrong for seven
builds because nothing checked.

## What the CI workflow is, and is not

`.github/workflows/ci.yml` runs the whole test suite on every push to every
branch. It holds no credential and deploys nothing.

It is a smoke alarm, not a gate. Because Cloudflare deploys straight from the
branch, a push reaches production whether CI passes or not — CI only tells you
quickly that it should not have. Closing that gap means changing the deploy
side: either point Cloudflare's Git integration at a branch that only receives
merges from reviewed pull requests, or turn the integration off and deploy with
`wrangler deploy` from a workflow that runs after the tests. Both are decisions
for whoever owns the Cloudflare account.

## Deploying by hand, if the Git integration is ever off

```
npx wrangler deploy
```

Secrets already set with `wrangler secret put` survive a deploy, so
`SCRAPE_TOKEN` is not re-sent and must never be committed here.
