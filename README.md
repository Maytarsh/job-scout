# job-scout

A daily job search that runs itself, in your own Google account.

Every morning it checks the job boards you list, scores each new posting against your
resume out of 100, and emails you the ones worth looking at. For the very best matches it
drafts a cover letter and fills in as much of the application as your resume honestly
supports — and stops to ask you about anything it does not.

It runs on your Google account, in your own spreadsheet, with your own Anthropic API key.
Nobody else can see your resume or your results. Expect it to cost **two to four dollars
a month**.

It never submits an application. That is on purpose, and it is explained under
[What it will not do](#what-it-will-not-do).

---

## Contents

- [What you need](#what-you-need)
- [Setup](#setup)
- [Filling in your Profile](#filling-in-your-profile)
- [Choosing your sources](#choosing-your-sources)
- [The first run](#the-first-run)
- [Reading the report](#reading-the-report)
- [NEEDS INPUT and BLOCKED](#needs-input-and-blocked)
- [The Answers tab](#the-answers-tab)
- [Cost](#cost)
- [Tuning](#tuning)
- [When something goes wrong](#when-something-goes-wrong)
- [What it will not do](#what-it-will-not-do)
- [Handing it to someone else](#handing-it-to-someone-else)

---

## What you need

- A Google account.
- Your resume — as text you can copy and paste, or as a PDF in your Google Drive.
- An Anthropic API key. Sign up at [console.anthropic.com](https://console.anthropic.com),
  add a small amount of credit, and create a key under **API keys**. It looks like
  `sk-ant-...`. Keep the tab open; you will paste it in a moment.

No programming. You will copy some files, paste them into a Google page, and fill in a
spreadsheet. Budget about twenty minutes.

---

## Setup

### 1. Make the spreadsheet

Go to [sheets.new](https://sheets.new). That is your spreadsheet. Name it something like
"Job scout" — top-left, where it says *Untitled spreadsheet*.

### 2. Open the script editor

In that spreadsheet, click **Extensions → Apps Script**. A new tab opens with a code
editor and one file called `Code.gs`.

### 3. Paste in the files

In the editor's left sidebar you will see **Files**. You are going to create one editor
file for each `.gs` file in this project's `src/` folder:

```
Apply.gs   Claude.gs   Config.gs   Extract.gs   Jobs.gs
Mail.gs    Main.gs     Profile.gs  Setup.gs     Sheet.gs
Sources.gs
```

For each one:

1. Click the **+** next to *Files*, choose **Script**.
2. Name it exactly as above but **without** the `.gs` — type `Apply`, not `Apply.gs`.
   The editor adds the extension itself.
3. Open the matching file from `src/` in this project, select all of it, copy it, and
   paste it into the editor file, replacing anything already there.

Then delete the `Code.gs` file the editor created for you: hover it, click the **⋮**, and
choose *Delete*.

There is one more file. Click the gear icon (**Project Settings**) in the far-left
sidebar and tick **Show "appsscript.json" manifest file in editor**. Go back to the
editor and you will now see `appsscript.json` in the file list. Replace its contents with
`src/appsscript.json` from this project.

Click the **save** icon (💾) when you are done.

### 4. Add your API key

Still in **Project Settings**, scroll to **Script Properties** and click
**Add script property**:

- Property: `ANTHROPIC_API_KEY`
- Value: your `sk-ant-...` key

Click **Save script properties**. The key lives only here. It is never written into the
spreadsheet and never leaves your Google account.

### 5. Run setup and grant permission

Back in the editor, choose **setup** from the function dropdown at the top and click
**Run**.

Google will ask you to authorize. It will show a warning that says *Google hasn't
verified this app* — that is expected, because the "app" is the code you just pasted
yourself. Click **Advanced**, then **Go to (your project name)**, then **Allow**.

You are agreeing to three things:

| Permission | Why |
|---|---|
| See, edit... spreadsheets this application is installed in | It reads and writes this one spreadsheet, and no other. |
| Connect to an external service | To reach the Anthropic API. |
| Send email as you | The daily digest, sent to you. Nothing else, nobody else. |

When it finishes you will see a box confirming eight tabs and two triggers. Go back to
the spreadsheet tab and reload the page — a **Job scout** menu appears next to *Help*.

> **Using a PDF from Drive instead of pasted text?** You need one more permission. In the
> editor, open `appsscript.json` and add this line to the `oauthScopes` list:
>
> ```json
> "https://www.googleapis.com/auth/drive.readonly"
> ```
>
> Save, then run **setup** again and approve the extra permission. It is not included by
> default because it grants read access to your whole Drive, and most people do not need
> to give that up just to read one file. Pasting your resume as text avoids it entirely.

---

## Filling in your Profile

Open the **Profile** tab. It arrives filled in with somebody else's answers, marked
`SAMPLE`. Replace all of them. This tab is the only place your details live.

| Row | What to put |
|---|---|
| `resume_text` | Your whole resume, pasted in as plain text. |
| `resume_file_id` | *Or* the id of a PDF in your Drive — see below. Fill in one of these two, not both. |
| `locations` | Where you would work, comma-separated. Remote counts as a match for any of them. |
| `target_roles` | The jobs you want, comma-separated. Related roles still score, just lower. |
| `weight_industry_fit` | How much the industry and function matter. |
| `weight_experience` | How much your experience matters. |
| `weight_compensation` | How much the pay matters. |
| `weight_location` | How much the location matters. |
| `weight_interview_odds` | How much your chance of getting an interview matters. |
| `report_threshold` | Below this score, a job is recorded but not shown to you. |
| `apply_threshold` | At or above this, it will draft a cover letter. |
| `max_posting_age_hours` | Skip postings older than this. |
| `email_report` | `yes` to get the daily email. Leave it on. |
| `notes` | Anything that does not fit above. Written into the scoring instructions word for word. |

**The five weights must add up to exactly 100.** They are how the score is built: a job
scoring 90 on industry fit with a weight of 30 contributes 27 points out of 100. If they
do not add up to 100 the run stops and tells you, rather than quietly producing scores
that mean something you did not choose.

`report_threshold` must be at or below `apply_threshold`.

**`notes` is the useful one.** It is passed through untouched, so write it the way you
would say it: *"prefer remote-first employers", "not interested in anything requiring
more than 25% travel", "would take a pay cut for the right development role"*.

> **Finding a Drive file id:** open the PDF in Google Drive, click **Share → Copy link**,
> and paste it somewhere. The link looks like
> `https://drive.google.com/file/d/1AbC...XyZ/view`. The id is the part between `/d/` and
> `/view`.

Your resume is read **once** and the facts are cached, so it is not re-read and re-billed
every morning. If you update your resume, use **Job scout → Re-read the resume**.

---

## Choosing your sources

Open the **Sources** tab. Each row is one place to look. It ships with about twenty
sample employers so you can see the shape; replace them with companies you would actually
work for.

| Type | Put in "Slug or URL" | Where to find it |
|---|---|---|
| `ats_greenhouse` | The company's board name | Their careers link looks like `job-boards.greenhouse.io/acmecorp` → use `acmecorp` |
| `ats_lever` | The company's board name | `jobs.lever.co/acmecorp` → use `acmecorp` |
| `ats_ashby` | The company's board name | `jobs.ashbyhq.com/acmecorp` → use `acmecorp` |
| `careers_url` | The full web address of one job posting | Copy it from your address bar |
| `aggregator` | `search terms@location` | Optional — see below |

Set **Enabled** to `yes` or `no` to turn a row on or off without deleting it.

The practical way to build this list: think of fifteen or twenty employers you would
genuinely want to work for, open each one's careers page, and look at the address bar.
If it says greenhouse, lever or ashby, you have your type and slug in one glance.

Then run **Job scout → Check sources**. It tries every enabled row and tells you which
ones answered and how many jobs each returned. A row that fails costs you nothing else —
every other source still runs — but it is worth fixing before the first real morning.

> **The optional aggregator.** ATS boards only find jobs at companies you have listed. If
> you also want keyword search across employers you have not thought of, sign up for a
> free [Adzuna developer key](https://developer.adzuna.com), then add two more script
> properties (Project Settings → Script Properties): `ADZUNA_APP_ID` and
> `ADZUNA_APP_KEY`. Set the sample aggregator row's Enabled to `yes`. This is entirely
> optional — without it everything else works exactly as it should.

---

## The first run

Click **Job scout → Find jobs now**.

It fetches every source, records each new posting in the **Jobs** tab, and sends the
first batch off to be scored. Scoring is not instant — it uses a cheaper half-price queue
that usually takes minutes and is allowed up to a day. A trigger checks every hour, so
you do not have to.

To watch it happen, click **Job scout → Collect scores now**. If it says the batch is not
finished yet, that is normal; wait and try again, or just leave it alone.

**Your first run will find far more jobs than a normal morning.** A typical day brings in
a handful of new postings; the first run sees *every* open role at *every* company you
listed, which can easily be several hundred. It scores them fifty at a time and picks up
where it left off each hour, so the first day's scoring finishes over a few hours rather
than all at once. That is by design — it keeps a single run from timing out and keeps the
first day's cost from being a surprise. After that, each morning is small.

From then on it runs on its own: discovery once a day at 6am, collection every hour.

---

## Reading the report

Two places, and one email.

**The email** arrives every morning. The subject says how many matched:
`job-scout: 3 new matches`. Under it, each job with its score, company, title, location,
salary, source, how old the posting is, one sentence on why it matched, and the link.

You will also get `job-scout: 0 new matches` on quiet days. Do not turn that off. It is
how you know the whole thing is still running — otherwise a morning when nothing matched
and a morning when the system broke three weeks ago look exactly the same from your
inbox.

**The Report tab** is the same list in the spreadsheet, rebuilt each morning.

**The Jobs tab** is everything ever found, including the jobs that scored too low to
show. That is deliberate: keeping them is what stops the same unsuitable job being
rediscovered and re-scored every morning for as long as it stays open. It also has the
five individual scores, so you can see *why* something scored 74 — strong on industry fit
but weak on location, say.

**Posting age** may say `UNKNOWN`. Many job boards simply do not publish when a role went
up. Rather than guess, it says so. Jobs with an unknown age are always shown, never
filtered out by `max_posting_age_hours`.

---

## NEEDS INPUT and BLOCKED

Every job has a status:

| Status | Meaning |
|---|---|
| **FOUND** | Found and scored. Nothing needed from you. |
| **NEEDS INPUT** | It drafted an application but hit a question your resume does not answer. |
| **BLOCKED** | Applying needs a login, a CAPTCHA or something else a script must not do. |
| **APPLIED** | You applied. **You** set this — nothing else ever will. |

Run **Job scout → Draft applications (85+)** to work through the jobs that scored above
your apply threshold. For each one it writes tailored keywords and a cover letter into
the **Draft** column, then fills in every application question it can answer truthfully
from your resume.

**NEEDS INPUT** means it could not answer everything, and the Needs column lists exactly
which questions. This is the system working, not failing. It will not guess your salary
expectations, and it will not decide on your behalf whether you need visa sponsorship,
even if your resume mentions your visa — those are different questions with different
answers, and a wrong one goes on a real form under your name.

**BLOCKED** means the posting cannot be applied to without a person: it needs an account,
or two-factor, or a CAPTCHA. The Needs column says which. Open the link and apply by hand.

When you do apply, set the Status dropdown to **APPLIED** yourself.

---

## The Answers tab

This is where you answer the questions your resume does not, once.

It arrives with every recurring application question listed and every answer blank. Fill
in the ones you can — salary expectation, work authorization, whether you need
sponsorship, whether you would relocate, and so on. Anything you leave blank counts as
unanswered, which is what makes a job stop and ask.

Answer a question here and **every future job reuses it**. You will not be asked the same
thing twice. When a specific posting asks something unusual, that question is added here
as a blank row so you can answer it once and be done.

Nothing writes to this tab except you. Not the resume reader, not the model, not a
default. That is the point of it.

---

## Cost

Roughly **$2 to $4 a month** for a typical search.

| What | How often | Cost |
|---|---|---|
| Reading your resume | Once ever | about $0.10 |
| Scoring jobs | ~40 a day | about $2 a month |
| Drafting cover letters | Only for 85+ matches | about $0.05 each |

Scoring is the bulk of it and it is kept cheap deliberately: a fast, inexpensive model, a
half-price processing queue, and — the part that matters most — the job description is
stripped of all web-page clutter and capped in size before it is sent. Sending raw web
pages instead would cost more than fifty times as much.

Your first month runs a little higher because of the first-run backlog.

There is a hard daily ceiling of **$2.00**. Once a day's spending reaches it, nothing
further is sent until midnight UTC, whatever happens. To change it, edit
`DAILY_BUDGET_USD` at the top of `Config.gs` and re-paste that file.

---

## Tuning

Most of what you would want to change is in the Profile tab and needs no code.

**Too many low-quality matches?** Raise `report_threshold`.

**Not enough matches?** Lower `report_threshold`, add sources, or widen `target_roles`.
Check the Jobs tab first — if there are plenty of jobs scoring in the 60s, the threshold
is the problem; if there are barely any jobs at all, the sources are.

**Scores feel wrong?** Look at the five individual scores in the Jobs tab and adjust the
weights. If good jobs are being marked down for location when you would happily commute,
lower `weight_location` and put the difference somewhere else. They must still total 100.

**Something the fields cannot express?** Put it in `notes`.

A few knobs live in `Config.gs` and need that file re-pasted: `MAX_NEW_JOBS_PER_RUN` (how
many jobs are scored at once), `MAX_DESC_TOKENS` (how much of each description is sent),
`DAILY_BUDGET_USD`, and the model names. Re-pasting `Config.gs` resets all of them to the
values in the file — it does not touch your Profile tab.

---

## When something goes wrong

**No email at all.** The triggers stopped. In the Apps Script editor, click the clock
icon (**Triggers**) and check that `runDiscovery` and `collectScores` are both listed. If
not, run **setup** again. It is safe to re-run: it never overwrites a tab you have filled
in.

**An email saying a step failed.** It says what broke and where. Fix it, then run
**Job scout → Find jobs now**. Nothing is lost — jobs already found keep their rows, and
anything unscored is picked up automatically.

**A source is not returning anything.** Run **Job scout → Check sources**. The most
common cause is a company that moved to a different ATS, which changes its slug.

**More detail.** Two hidden tabs hold it. Right-click any tab, choose *Show all sheets*
(or **View → Show → Hidden sheets**), and look at **\_Errors** — every failure with a
plain-English note on what to do about it — and **\_Runs**, which records what each run
found, how many tokens it used and what it cost.

**Scores stopped but jobs keep appearing.** A scoring batch got stuck. It clears itself
after 26 hours and requeues its jobs; if it happens twice, check that your API key is
still valid and your Anthropic account still has credit.

---

## What it will not do

Some of this you may want and it is worth knowing up front.

**It never submits an application.** It prepares one — a tailored cover letter, keywords
and every answer your resume genuinely supports — and you press send. Google Apps Script
cannot drive a web browser, and even if it could, an automated submission is a document
you did not read going out under your name.

**It never invents an answer.** If your resume does not establish something, it says
`UNESTABLISHED` and asks you. It will not infer your salary expectations from your job
title, or your sponsorship needs from a visa mentioned on your resume. This is the single
rule the whole design is built around.

**It does not search LinkedIn, Indeed, Handshake or ZipRecruiter.** All four prohibit
automated access in their terms of service. Instead it reads employers' own job boards
directly, which is the same posting first-hand — and where a site asks automated visitors
to stay away, it stays away.

**It does not get past login walls or CAPTCHAs.** Those become BLOCKED with a note. Doing
otherwise would mean defeating a security measure on someone else's website.

---

## Handing it to someone else

This is built so that you can. Nothing about any particular person is in the code — every
detail lives in the spreadsheet. To set someone else up: they make their own copy of the
spreadsheet, paste in the same files, use their own API key, and fill in their own
Profile, Sources and Answers tabs.

Their resume never touches yours, and neither of you ever sees the other's results.
