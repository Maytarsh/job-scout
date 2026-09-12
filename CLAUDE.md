# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Google Apps Script project — no build, no package manager, no local runtime for `src/`.
Sibling of `~/git/job-tracker` and deliberately built to its conventions; that repo is not
ours to modify. `@README.md` covers setup, the Sheet layout and tuning; this file covers
only what is easy to get wrong while editing.

## Nothing person-specific may enter a .gs file

This repository is public, and the whole point of the design is that it belongs to nobody
in particular: one person runs it on their resume, hands it to their brother, and the
brother changes the Profile and Sources tabs and nothing else.

- A name, a city, a target role, a threshold someone tuned, a fact from a resume — all of
  it lives in the deployer's Sheet. `src/` reads it; `src/` never contains it.
- The sample values that seed that Sheet on first run live in `Setup.gs`, in
  `sampleProfile_()` / `sampleSources_()`, each marked `SAMPLE`. Nothing reads them and
  nothing falls back to them.
- Reference data that is genuinely general — `US_STATES` — is allowed and is named as
  such where it sits. The line between the two is whether a different person running this
  would want it changed.
- `.claude/hooks/check-no-personal-data.sh` says something when this is broken. It caught
  three states written into `normalizeLocation_` that happened to be the sample profile's
  states, which is exactly the shape this fails in: it looked like an implementation
  detail rather than like configuration.

Before making the repo public, check the whole history and not just the tree:

```bash
git log -p | grep -inE 'los angeles|manhattan beach|malibu|orange county|h-1b'
```

## Load order is alphabetical, and it bites

Apps Script evaluates project files in **alphabetical order**, not dependency order, so
`Apply.gs`, `Claude.gs` and `Extract.gs` all run before `Config.gs`. Anything built in a
top-level `var` from Config's globals (`CONFIG`, `WEIGHTS`, `TABS`, `STATUSES`,
`ANSWER_KEYS`, `*_HEADERS`) is `undefined` at load time, and `JSON.stringify` drops
undefined keys silently — a request schema that constrains nothing looks exactly like one
that works, until the day a response comes back shaped wrong.

- Build request schemas and anything else derived from Config **lazily, inside a
  function** (see `scoreSchema_()`, `draftSchema_()` and `factsSchema_()` in
  `src/Claude.gs`).
- `test/run_tests.py` loads `src/*.gs` alphabetically on purpose. Do not "fix" it into
  dependency order — that would hide this entire class of bug.
- `.claude/hooks/check-load-order.sh` checks files that sort before `Config.gs`.

## Never invent an answer

The failsafe is the reason this exists rather than a shell script that emails job links.
An application submitted with a guessed answer is a false statement made under someone
else's name, on a form they will be held to.

- Every key in `ANSWER_KEYS` marked `humanOnly: true` is answered from the **Answers tab
  and nowhere else** — not from the resume, not from the model, not from a default. A
  blank Answers row means `UNESTABLISHED`, and `UNESTABLISHED` stops the application and
  asks.
- The trap is that a resume fact often *looks* like an answer. "holds an H-1B, eligible from
  some date" sits in `_Facts` and reads like an answer to "do you require sponsorship".
  It is not one. There is a test named for that case; do not make it pass by widening the
  rule.
- Questions a specific posting invents are treated as `humanOnly` without exception —
  nothing maps them to a resume field, so nothing can answer them truthfully.
- The model in `Apply.gs` writes prose and identifies questions. It does not answer them.
  Answer resolution is `resolveAnswer_()`, in code, where it cannot be talked out of
  itself.
- `APPLIED` is a status only a human sets. No code path writes it, and the Status column
  is a dropdown so that a person can.

## Dedupe has to survive across days

The prototype this replaces kept its output in an ephemeral workspace, so every morning
it rediscovered the same jobs as new ones. That is the failure this codebase exists to
not have.

- The dedupe key is normalized company, title and location, and it must contain **nothing
  that varies between boards or between runs** — no URL, no posting date, no requisition
  id. `normalizeTitle_` strips requisition numbers for exactly this reason.
- A row is never deleted for scoring badly. A job below `report_threshold` keeps its row
  and is merely not shown; dropping it would mean rediscovering and re-scoring it every
  morning for as long as it stays open.
- `upsertJob_` leaves an existing row completely alone. Its score, its status and any
  draft on it may be the product of a human's decision since.

## The two triggers, and what passes between them

Apps Script kills an execution at ~6 minutes, so discovery and scoring cannot share one.
They communicate through the Sheet and three script properties, never through memory.

- **Results are keyed by `custom_id`, never by position.** They come back in whatever
  order they finished, and the execution that reads them is not the one that wrote them.
  A result applied positionally puts one job's score on another job's row, which looks
  entirely plausible in a report.
- `custom_id` is a SHA-256 digest of the dedupe key truncated to 32 characters. Full hex
  is exactly 64, which is the API's limit with no headroom at all.
- **A batch that is not ready is left for the next poll** — not waited on, not cancelled,
  not treated as a failure. That is the whole reason `collectScores` is a trigger rather
  than a loop.
- One batch is pending at a time. A batch still unfinished after `BATCH_MAX_AGE_HOURS` is
  abandoned and its jobs requeued; holding the slot would stop every future run from
  submitting anything, and the symptom would be scores quietly stopping while discovery
  kept finding jobs.
- **The queue is "rows with no score", not "jobs found today".** That is what makes the
  whole thing self-healing: a source that was down, a batch that expired, a run that hit
  the time cap — all of them leave rows unscored, and unscored rows are what the next
  submission picks up.
- `results_url` is a **signed redirect**. The redirect is not followed automatically and
  the second request carries no headers at all. Forwarding `x-api-key` to signed storage
  both leaks the key and gets the request rejected for carrying it. `tools/probe.py`
  exercises this, because no logic test can.

## The digest is the heartbeat

A digest goes out on every run, including runs that matched nothing, with the count in
the subject.

- The subtle case: a run with nothing to submit sends **no batch**, so `collectScores`
  never runs and the digest it would have sent never happens. `runDiscovery` sends the
  zero-match digest itself for exactly this reason. There is a test for it.
- Exactly one digest per run, from whichever step ends it. If you add a third path that
  can end a run, it owes the digest too.
- A failed run mails as well, and it ignores `email_report`: turning the digest off is
  turning off a convenience, not asking to stop being told the thing is broken.
- **The recipient is a Profile row, never `Session.getActiveUser()`.** That call needs
  the `userinfo.email` scope, which this does not request — and it failed on the first
  real digest, after a run that had already found and scored everything correctly.
  Asking for a deployer's identity to learn an address they could type is a scope for
  nothing. `reportRecipient_` keeps the Session call as a try/catch fallback for anyone
  who has that scope anyway.
- **A digest that cannot be sent must not fail the run.** By the time it is attempted
  the jobs are found, the scores written and the book flushed; throwing there reports
  scoring as broken when it worked. `deliverDigest_` catches and writes `_Errors`
  instead. The reverse — swallowing it silently — is worse, because the heartbeat is
  the only channel for saying the heartbeat is broken. `setup()` therefore prints
  whether a recipient can be resolved, which is the one moment someone is watching.

## Claude never sees raw HTML

This is the whole cost model, not tidiness. A mid-sized careers page is 40,000 tokens of
markup around 600 tokens of description.

- Order of preference: a real JSON API, then a `schema.org` JobPosting in an ld+json
  block, then the text pipeline in `Extract.gs`. Only the last one reads markup.
- `capTokens_` is a backstop, not the mechanism. There is a test asserting the pipeline
  strips better than four tokens in five on the saved fixtures — if that ratio collapses,
  extraction has stopped working and the cap is quietly paying for chrome instead.
- `callAnthropic_` and `apiFetch_` are the only places a request leaves the script, so
  the daily ceiling is enforced there rather than at the call sites: a new menu item
  cannot spend past it by forgetting to ask.
- **The model id in a response is not the one you sent.** An alias resolves to the dated
  snapshot it points at, so `claude-haiku-4-5` goes out and `claude-haiku-4-5-20251001`
  comes back — and a batch result is priced from the response, because that is the only
  place its usage exists. Looking the dated id up directly finds nothing, and the batch
  pass is almost all of what this spends: the ledger read `$0.00` and the ceiling was
  holding nothing, while the report arrived every morning looking entirely correct. Price
  through `priceFor_()`, which strips the date and errs high on an id it does not know.
  A guard that errs low is not a guard. Two tests cover it; the one that existed before
  only checked the ids we *send*.
- A job posting is text an employer wrote and nobody vetted. Fence it, say the fence
  means untrusted input, and strip the angle brackets that would let it close the fence —
  `scoreUserPrompt_` and `draftFromModel_` both do.

## Sources, and the ones that are missing on purpose

LinkedIn, Indeed, Handshake and ZipRecruiter are named in the original spec and are
deliberately absent. All four forbid automated access in their terms and repeat it in
robots.txt. An employer's own ATS is the same posting first-hand, with a real API.

- `careers_url` checks robots.txt and honours it. A disallowed path fails its row and
  says so; it is not an obstacle to route around.
- A login wall, MFA or a CAPTCHA becomes `BLOCKED` with an explanation. Building past one
  is out of scope by design, not by omission.
- Adding a source type means adding an adapter and a case in `fetchSource_`. It must
  never mean touching the pipeline that consumes them: everything downstream is written
  not to know where a job came from.
- A source that fails writes an `_Errors` row with something the deployer can act on, and
  the run continues. One dead careers page must not cost the morning report.

## Region belongs in the Sheet, not in an adapter

This is the person-agnostic rule in its most concrete form. The project was
written from a US-shaped spec and it showed: the aggregator had `us` hardcoded in
its URL, and `normalizeLocation_` expanded three state codes that happened to be
the sample profile's states.

- `REGIONS` in `Config.gs` is the whole of it. Adding a country means adding a row
  there and nothing else. An aggregator a region has no entry for is unavailable
  there and **says so** — Adzuna publishes no Israeli index, and asking for one
  returns a US-shaped error page that would otherwise parse as "no jobs today".
- `region` on the Profile is optional, because a Sheet using only `ats_*` rows
  never needs one. An aggregator row without one fails with a sentence naming the
  fix, rather than defaulting to a country.
- **`IL` is Israel next to an Israeli city and Illinois next to an American one.**
  `normalizeLocation_` decides from the city beside it. Without that check every
  Tel Aviv job files itself under Illinois, silently, and dedupe splits in two.
- Location aliases and `US_STATES` are applied to every location regardless of
  region. Expanding `tlv` and `ca` in the same pass costs nothing and collapses a
  duplicate either way.

## Two source families, and one of them is unverified

`ats_*` rows answer "what is open at this company" first-hand: full posting, real
salary, direct apply link. `aggregator_*` rows answer "who is hiring for this,
anywhere" across companies nobody listed — but with a ~70-token search snippet,
rarely a salary, and a redirect link. Neither replaces the other, and nothing
downstream can tell them apart.

`fetchComeet_` is the exception to this repo's rule about verifying before
shipping. Its endpoint is confirmed (it answers "Token is missing" without one)
but **its response shape has never been read from a live board** — ten Israeli
careers pages were searched for a Comeet embed and none had one, and the vendor
has since rebranded to Spark Hire Recruit. It therefore throws on the first
position with no name, quoting what it actually received, rather than returning
rows with blank titles and a dedupe key of `||`. Get a real `uid/token`, run it,
and either confirm the fields or fix them — then delete this paragraph.

## The Sources list is maintained by the tool, not by hand

A list somebody curates by hand was a fair criticism of the original design, and
`discoverBoards_` is the answer to it: names in, board rows out. The list still
exists — it is the maintenance that does not.

- **A board only counts if it hires in the deployer's `locations`.** Slug guessing
  collides constantly — "Next Insurance" resolves to a live Greenhouse board at
  `insurance`, "Moon Active" to one at `moon`, both real, neither right. The
  location check removed every collision in the run that built the shipped list,
  with nobody having to recognise the names. Do not relax it into "the board
  exists"; that is the same bug as the seventeen dead slugs, arriving by a
  different route.
- Probe URLs are the light ones on purpose. Greenhouse with `content=true`
  returns every description on the board, and discovery only needs to know the
  board is real and where it hires.
- `UrlFetchApp.fetchAll` is what makes twenty-five companies fit in one
  execution — seventy-five sequential fetches would not.

## Two gates before a job is scored, not one

`isFreshEnough_` and `wantsLocation_`. The second was missing, and it was the
largest avoidable cost in the system: on one real run 274 of 366 ingested
postings were in India, the United States, the Philippines and Czechia for a
deployer in Tel Aviv. All 274 were fetched, stored and sent to the model, all
came back in single digits, and three quarters of that run's spend bought
nothing. Every board carries roles worldwide; a company list is not a location
filter.

- Blank locations and anything remote are **kept**. A source that does not say
  where is not a source saying elsewhere.
- Location remains a scoring dimension. The gate stops the caller paying a model
  to confirm that Manila is not Tel Aviv; the dimension still separates the
  places someone would accept.

## The scale has to be mostly signal

Every dimension whose value is the same on every job is a constant added to
every score, and thresholds are set as though 100 points of signal exist.

- Where pay is not published, `compensation` returns 50 on everything: 7.5
  points at weight 15, on every job.
- In a **single-metro search**, `location` is very nearly the same: every job
  worth seeing is in the one city and scores ~100. At weight 15 that is another
  15 points on everything.
- Together that was 22.5 free points on every local posting, which is how an IT
  systems role nobody wanted cleared a report threshold of 75 on 45 points of
  real fit. Keep the weight on a dimension proportional to how much it actually
  varies across the jobs being compared — the README's Tuning section says this
  to deployers.

## `notes` is binding, not advisory

It is the escape hatch for everything the fields cannot express, and it is
appended to the prompt verbatim. The prompt now also tells the model that
anything the candidate rules out is a hard exclusion scoring `industry_fit` at
most 10, however transferable the skills. Transferability is a reason to
consider a neighbouring role, not a reason to overrule somebody about their own
career — and an agent that scores a job 80 because the skills carry over, when
the person has said they do not want it, is wasting the one thing this is for.

## Deploying

Deployment is **manual copy-paste** into the Apps Script editor, one editor file per
`src/*.gs`. After changing files, say which ones need re-pasting — the `paste-list` skill
does this.

- Re-pasting `src/Config.gs` reverts the deployer's knobs to the defaults in the file.
  It does **not** touch the Profile tab, which is where anything person-specific lives.
- Changing a trigger cadence means re-running `setup()`, which recreates both triggers
  and clears each one's failure-notification setting.
- Adding an OAuth scope means `src/appsscript.json` must be re-pasted too, and the user
  re-authorizes. `drive.readonly` is deliberately **not** in the shipped scopes: only the
  `resume_file_id` path needs it, and asking a non-technical person for read access to
  their whole Drive by default is a bad trade. If you add a scope, say in the README what
  it is for.
- Changing the scoring schema or prompt makes old scores incomparable to new ones. Say so.

## Testing

```bash
uv run python test/run_tests.py    # logic suite; needs Firefox present
uv run python tools/probe.py       # one REAL billed API call
```

Python dependencies are managed with **uv** and committed (`pyproject.toml`, `uv.lock`).
Run the local tooling through `uv run`, not bare `python3`.

Ask before running either. `probe.py` costs money and needs `ANTHROPIC_API_KEY` in the
environment; it is only worth running when a request payload shape changed. It restates
the scoring schema standalone, and `run_tests.py` fails if that copy drifts from
`src/Claude.gs` — update both together.

Two things about the harness are load-bearing and easy to undo:

- Every `</script` in the assembled source is escaped. The fixtures are whole saved pages
  and the extraction tests are about script tags, and the browser's HTML parser closes
  the harness's own tag there regardless of it sitting inside a string literal. The suite
  then defines nothing, reports no error, and fails as "no results".
- Load errors are caught with `window.onerror`, **not** by wrapping the sources in a
  `try` block. A function declaration inside a block gets a block-scoped binding, so a
  test that swaps a global out would not change what the code inside the block calls —
  every isolated test silently ran against the real function and reached for a Sheet.

Only pure logic is testable locally. Anything touching Sheets, Drive, Gmail or the API is
exercised in the Apps Script editor.

## Git

Branch and open a PR with `gh`; do not commit to `main`. Cut the branch **before the
first edit**, not at commit time — `.claude/hooks/require-branch.sh` refuses Write and
Edit on this repo's files while HEAD is the default branch. `git checkout -b <name>`
carries uncommitted work across, so being stopped costs nothing.

Commit subjects are imperative sentence-case describing the behaviour change, no type
prefix — e.g. "Stop the heartbeat going missing on a zero-match morning".
