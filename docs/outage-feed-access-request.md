# Outage data access request — draft

Four distributors serve a bot challenge to automated requests for their public
outage page, so the dashboard shows only third-party totals for them:

| Operator | State | Protection | What we currently show |
|---|---|---|---|
| SA Power Networks | SA | Imperva Incapsula | aggregator customer total, no towns |
| Essential Energy | NSW | Cloudflare | aggregator customer total, no towns |
| Horizon Power | WA | Cloudflare | nothing |
| Power and Water Corporation | NT | Cloudflare | nothing |

Their challenge has not been bypassed and will not be. This asks them to let
us through the front door instead.

**Send from a Suncorp address, from a named person.** An unattributed request
is unlikely to be actioned, and the business purpose is the part that carries
the weight.

## Ask for the feed first, the allowlist second

Put the feed request first in the email. It is less work for them than a WAF
change, it removes the need for any allowlist, and three of their peers
already do it:

- **Endeavour Energy** publishes an Opendatasoft portal at
  `data.endeavourenergy.com.au` (`outagecustomerlive`, `plannedoutagecustomer`).
- **Energex and Ergon** publish current outage areas as open ArcGIS feature
  services, which is how this dashboard reads Queensland despite both sites
  being challenged.
- **Western Power** publishes `WP_Outage_Prod` the same way.

Naming those precedents matters: it turns "please make an exception for us"
into "please do what your peers already do".

## Technical specifics to include

Vague requests get declined. These are the real numbers.

- **Frequency:** one request per operator per 15–20 minutes — roughly 3–4 per
  hour, under 100 per day. The cron runs every 5 minutes and outage refreshes
  are sharded, so no operator is polled more often than that.
- **What is read:** the public outage list page only. No authenticated
  endpoint, no customer data, no address lookups, no form submissions.
- **Identification:** a dedicated User-Agent, and a shared secret header if
  they prefer. Current string:
  `Mozilla/5.0 (compatible; NewsRadar/1.0; +https://drec-oncall-updates-site.lacey-wood.workers.dev)`
  — worth replacing with one naming Suncorp before sending.
- **Do not offer an IP allowlist.** This runs on Cloudflare Workers, whose
  egress addresses are not fixed. Promising a stable IP would be a promise we
  cannot keep, and the allowlist would fail intermittently afterwards — which
  is worse than being blocked outright, because it fails silently. Ask for
  User-Agent or header-based identification.

## Draft

> **Subject:** Access to your public outage data — Suncorp emergency response dashboard
>
> Hello,
>
> I work at Suncorp, where we run an internal dashboard used by our disaster
> response team to see which communities are affected during severe weather.
> It combines emergency warnings, fire and flood incidents, and electricity
> outages, and it helps us position resources and contact affected customers
> sooner.
>
> We read the public outage information that distributors publish. Several of
> your peers make this straightforward — Endeavour Energy publishes an open
> data portal, and Energex, Ergon and Western Power publish their current
> outage areas as open ArcGIS feature services. We read all of those without
> difficulty.
>
> Requests to your outage page are served a bot-protection challenge. We have
> not attempted to work around it, and we won't — it is your access control to
> set. Instead I would like to ask for one of two things:
>
> **A published feed, ideally.** If you already produce a JSON, GeoJSON or CSV
> of current outages — suburb or locality, customers affected, cause, and
> estimated restoration — we would use that and stop requesting the web page
> entirely. This is less work for you than any change to your protection
> rules, and it is what your peers listed above already do.
>
> **Otherwise, an allowlist.** If a feed isn't available, would you consider
> allowing our automated request through, identified by a dedicated
> User-Agent string and, if you prefer, a shared secret header? Our usage is
> modest and fixed:
>
> - one request every 15–20 minutes, fewer than 100 per day
> - the public outage list page only — no authenticated endpoints, no customer
>   data, no address lookups, no form submissions
> - a single identifying User-Agent, which we will not change without telling
>   you
>
> I should flag one constraint: our service runs on Cloudflare Workers, which
> does not have fixed egress IP addresses, so an IP-based allowlist would fail
> intermittently. User-Agent or header-based identification would be reliable.
>
> We are happy to sign a data use agreement, attribute the data to you on the
> dashboard, cache it to reduce load, and adjust frequency to whatever suits
> you. If this should go to a different team, I would be grateful if you could
> point me their way.
>
> Many thanks,
>
> [Name]
> [Title], Suncorp
> [Email] · [Phone]

## Where to send it

Use each operator's general or media/data enquiries contact form rather than
guessing at an address. SA Power Networks has a contact page at
`sapowernetworks.com.au/contact/`; the others carry equivalent pages.

**Horizon Power and Power and Water Corporation are government-owned** (WA and
NT respectively). If the ordinary channel goes quiet, both are subject to
their jurisdiction's information access regime, and both sit under agencies
with open data obligations — a request routed through the NT or WA open data
team is a second avenue that the commercial distributors do not offer.

## If they decline

The dashboard already handles this honestly: a blocked operator shows
"blocks automated access" with a link to their own map, and where an
aggregator total exists it is labelled with whose figure it is. Nothing
misrepresents a gap as a quiet day. Declining costs us town-level detail for
those four, not correctness.
