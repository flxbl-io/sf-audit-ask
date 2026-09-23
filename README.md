# Ask Flux (`sf-audit-ask`)

**Live at [askflux.flxbl.io](https://askflux.flxbl.io).** Flux is flxbl's fennec. Choose the CSV of a Salesforce Setup Audit Trail, ask Flux whether something was changed, and
get yes or no with a probability and the row that says so. No login. **An experiment by [flxbl](https://flxbl.io): Flux
can be wrong.**

```bash
npm ci
TYPESAFE_API_KEY=... npm start        # http://127.0.0.1:8787
npm test                              # 65 tests, no network, no paid API
```

Node 22 or later. One dependency, pinned exactly: `@anthropic-ai/sdk`, used only to word the sentence under an answer
and to write the flow walk's situations.

## What a visitor is promised, and where to check it

| Promise | Where it is kept |
| --- | --- |
| No login, no cookie | `server.js` sets no cookie; a test asserts it. The only thing stored in the browser is a random id in `localStorage`, used to count questions. |
| No analytics, no telemetry | The page loads nothing from another origin: its own script, stylesheet, font, logo and two pictures of Flux. The CSP forbids anything else, and a test reads the HTML and the CSS to make sure. With the human check on, `challenges.cloudflare.com` is the one exception, fetched only after a file is chosen. |
| Usernames never leave the browser | `public/csv.js` parses the file in the browser and drops the User and Delegate User columns. The file itself is never uploaded. The text of a change *is* sent as recorded, and can itself name a person; the page says so. |
| Nothing kept on the server | There is no upload step. The rows stay in the browser tab and travel with each question; the server reads them, answers, and lets them go. Nothing is written to disk (in the container the filesystem is read-only), and a test asserts there is no endpoint that stores a trail. |
| Logs carry no question, row or address | One log line per question: verdict, probability, counts, timings. See `log(` in `server.js`. |
| The running build can be read | The footer shows the commit the image was built from, linked to the source at that commit. |

Who else sees what: **TypeSafe** (Jev) receives the rows and the question. **Anthropic** (Claude Haiku), when
enabled, receives the question, the verdict and the one row Jev pointed to, never the trail. **Cloudflare** is in
front and sees what any CDN sees. The page lists the same hops, and hides the ones that are switched off.

## How a question is answered

1. **The browser parses the CSV** and keeps it in the tab. With each question it sends date, action, section and
   text for each change, gzipped: 46 KB for 3,800 rows, about 2 MB for 100,000.
2. **The server prepares the rows** (`src/engine.js`, `prepare`): oldest first, the newest 100,000 kept, and a
   setting changed several times reduced to its last row, since only that says what holds now.
3. **The trail is read in pages of 350 rows**, 8 at a time. Jev reads about 500 rows in a request (60 tokens a row,
   32k for state), so a trail is never sent whole. Pages are cut in order of relevance to the question (BM25), so
   page 1 is the shortlist and the rest is the full sweep.
4. **Each page gets one Noul**: do these rows show the answer is yes? The answer is the highest probability any
   page gives. At 0.80 a page says yes and the sweep stops. A no has read every row. Between 0.50 and 0.80 the
   answer is shown as unclear.
5. **After a yes, one more request names the row** (a Choice over line numbers). It decides nothing; if Jev names
   none, none is shown.
6. **Claude Haiku words the sentence** under the verdict (`src/explain.js`). The page prints the verdict itself,
   from code, so a sentence that strays cannot change the answer. If Haiku is off, slow, refuses or fails, a
   built-in sentence is used, and the answer says who worded it.

Measured live, on a real trail buried in copies of another: 3,646 rows, a yes in 0.4-1.2 s and a no in about 1.1 s;
107,000 rows, a yes in 1.2 s and a no in 9 s (306 requests, about $0.27).

Each answer shows what it cost beside its verdict, and the page keeps a tally for the tab (spent, questions, per
question, tokens read), from the token counts the two services report with every reply: Jev at $0.042 per
million tokens read (output is free), Claude Haiku at $1 in and $5 out per million (`src/cost.js`; `/api/config`
repeats the prices). About $0.01 for a question over 3,700 rows; about $0.27 for a no over 100,000.

## The second experiment: a flow walk

The **Flow walk** tab (`#flow`) takes a Salesforce flow's `.flow-meta.xml`, draws it where Flow Builder saved each
element, and walks it for a situation told in plain words. Jev is the engine: every decision (the start conditions
first) is one Choice, "the flow is here: which outcome does it take?", over that decision's own outcomes, all asked in
one request. The page follows the flow's connectors through the answers, one step at a time, and stops to ask the person
where Jev is under 0.6. Claude Opus 5 writes six situations to try, each with the path it meant, so the page can say
whether Jev went the same way. Only the decisions, the step names and the formulas the decisions use are sent; a flow
file holds no records.

| | |
| --- | --- |
| Files | All under a `flow/` folder: `public/flow/graph.js` (read, walk, lay out; the browser and the tests share it), `public/flow/page.js` (the tab), `src/flow/questions.js` (Jev's questions), `src/flow/situations.js` (Opus), `test/flow/`. |
| Measured | 11 to 12 of 14 situations on a real 10-decision flow took exactly the path code walked from record values. Where two outcomes both hold, Salesforce takes the first and Jev can take the more obvious; an outcome the situation never settles can go to the default. |
| Cost | A walk is one Jev request: about 1,500 to 3,000 tokens, $0.00006 to $0.0001. Six situations from Opus: about $0.04. Both are shown, with a tally for the tab. |

## Limits

| | |
| --- | --- |
| Questions | 20 per 24 hours, counted against the IP address **and** the browser's identifier. Either one used up refuses: a new identifier does not help from the same address, nor a new address the same browser. A question that could not be answered is not counted. |
| Human check | Cloudflare Turnstile, before the first question. A passed check buys a signed pass, good for 30 minutes from the same address. The pass is a signature, not a session: the server keeps nothing about it. |
| Address | The socket's; `x-real-ip` on Vercel (set automatically); `CLIENT_IP_HEADER=cf-connecting-ip` behind a Cloudflare Tunnel; or `TRUSTED_PROXIES` hops of `x-forwarded-for`, counted from the right. An IPv6 visitor is their /64. |
| Rows | The newest 100,000 of a file. A request is refused before its body is read when the visitor has no pass or no questions left. |
| Jev | 8 requests in flight, shared by every visitor, because the rate limit is per account. At 24 in flight, 37 of 306 requests were throttled (and retried). |
| Walks | 60 per 24 hours on the flow tab (`WALKS`), counted the same way and apart from questions (Redis prefix `walks`). Writing situations counts as one. |

Attempts are counted in the process's memory unless a Redis is configured (`UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`, or the `KV_REST_API_URL` and `KV_REST_API_TOKEN` pair Vercel's integration sets, under any
prefix it was given, such as `UPSTASH_PROD_`). In memory, a restart forgets them and two processes each count to 20, so **anywhere processes come and go, Vercel included, configure Redis**.
The store holds a keyed hash of the address and browser identifier, for 24 hours, and the page says so.

## Running it: Vercel

`vercel.json` and `api/[route].js` are all it needs: Vercel serves `public/`, and `/api/*` runs the same handler
`npm start` runs. The server keeps nothing between requests, so it does not matter which instance answers.

1. Import the repository in Vercel (framework preset: Other; no build command).
2. Add Redis from the Marketplace (Upstash). It sets the `KV_REST_API_*` variables itself, under the prefix you give it
   (`UPSTASH_PROD_KV_REST_API_URL`); the server finds them. **Without it the limit of 20 questions restarts with
   every new instance.**
3. Set `TYPESAFE_API_KEY`, and optionally `ANTHROPIC_API_KEY`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`
   (Turnstile works on any host; the widget's hostname must be the Vercel domain), as *Sensitive* variables.
4. Leave Vercel Web Analytics and Speed Insights **off**, or the no-telemetry promise on the page is no longer true.

Request bodies on Vercel stop at 4.5 MB, which a full 100,000-row trail fits under (about 2 MB gzipped); the page
checks before sending. A no on 100,000 rows takes about 9 s; Opus writing situations for a 39-decision flow, about 65 s. The function is given 300 s. The commit
shown in the footer comes from `VERCEL_GIT_COMMIT_SHA`.

## Running it: Hetzner behind Cloudflare

`deploy/compose.yml` runs the app and a Cloudflare Tunnel. The box opens **no inbound port**: the tunnel dials out,
so nothing reaches the app except through Cloudflare, and that is what makes `CF-Connecting-IP` safe to believe.

1. **Hetzner**: the smallest box is enough, since no trail is held between requests. Install Docker. Firewall: allow SSH from your own address, nothing else.
2. **Cloudflare Tunnel** (Zero Trust > Networks > Tunnels): create one, copy its token to `TUNNEL_TOKEN`, and add a
   public hostname pointing at `http://app:8787`.
3. **Turnstile** (Cloudflare dashboard > Turnstile): add a widget for that hostname, mode *Managed*. Site key and
   secret go in `deploy/.env`.
4. **A rate limiting rule** (Security > WAF) as the outer fence: for example 30 requests a minute per IP to
   `/api/*`, action *Block*. The app's own limit of 20 questions is the inner one. Leave Web Analytics and
   "JavaScript detections"/RUM **off** for this hostname, or the no-telemetry promise on the page is no longer true.
5. `cp deploy/.env.example deploy/.env`, fill it in, then:

```bash
GIT_COMMIT=$(git rev-parse HEAD) docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

| Variable | Default |
| --- | --- |
| `TYPESAFE_API_KEY` | required |
| `TYPESAFE_MODEL` | `jev-1.13.0`, pinned: the 0.80 cutoff was measured on it |
| `ANTHROPIC_API_KEY` | none: built-in sentences |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | none: no human check |
| `CLIENT_IP_HEADER`, `TRUSTED_PROXIES` | none, 0 |
| `HOST`, `PORT` | 127.0.0.1, 8787 |
| `ATTEMPTS`, `ATTEMPT_WINDOW_HOURS` | 20, 24 |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN`, or `KV_REST_API_URL` + `_TOKEN` under any prefix | none: attempts counted in memory |
| `COUNTER_SALT` | the Turnstile secret, else the Jev key: keys the hashes kept in Redis |
| `JEV_IN_FLIGHT`, `MAX_BODY_BYTES` | 8, 12 MB (4 MB on Vercel) |
| `SOURCE_URL`, `GIT_COMMIT` | the flxbl-io repository, none |

## What it is not

- **Not proof.** The answer is read from a file the visitor chose, and a CSV can be edited. `sf-autopilot audit`
  reads the org itself; this does not.
- **Not a counter.** Jev does not count reliably. "How many times was X changed" belongs in code.
- **Not measured for accuracy yet.** It got 11 of 11 hand-written questions right on one trail, including a German
  one and a superseded change. The 243 labelled cases in `sf-autopilot/eval` have not been run through it.
- **Old values are the weak spot.** "Was the fiscal year set to July?" against a row reading "from 7 to 4" scores
  0.41: a no, but far from the 0.05 an unrelated question gets.
- **Tried live:** Jev, Claude Haiku's wording (including two prompt-injection attempts, which it ignored), the Redis
  counter's scripts against a real Redis and over Upstash's REST transport, a real Turnstile widget, and the Vercel
  deployment at askflux.flxbl.io, on a 3,676-row trail.
- **Not tried yet:** the Setup page's own CSV download (parsed from its documented columns).

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE.md) (FSL-1.1-Apache-2.0): use it, read
it, change it, run it, but not as a competing service; two years after each release it becomes Apache 2.0.
