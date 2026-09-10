---
name: paste-list
description: List which src/*.gs files changed and must be re-pasted into the Apps Script editor, with the warnings that apply to each. Use after editing src/ or when the user asks what to deploy.
---

Deployment here is manual copy-paste into the Apps Script editor, so the user needs to
know exactly which editor files to replace.

1. Determine the changed files. Compare against the ref in `$ARGUMENTS` if given,
   otherwise use uncommitted changes plus anything ahead of `origin/main`:

   ```bash
   git status --porcelain -- src/
   git diff --name-only origin/main...HEAD -- src/
   ```

2. List each changed `src/` file as the editor file to replace. `src/appsscript.json`
   is only visible after Project Settings → *Show `appsscript.json`*.

3. Add the warnings that apply:
   - **`Config.gs` changed** — re-pasting it reverts the user's own knobs to the
     defaults in the file, `DAILY_BUDGET_USD` and `MAX_NEW_JOBS_PER_RUN` most
     notably. Tell them to re-apply their values after pasting. It does *not*
     touch the Profile tab, which is where everything person-specific lives.
   - **`Setup.gs` changed** — `setup()` must be re-run to pick it up. That is safe:
     it creates missing tabs, never overwrites an existing one, and reinstalls both
     triggers.
   - **Trigger cadence changed in `Setup.gs`** — `setup()` rebuilds both triggers,
     which clears each one's *Notify me immediately* failure-notification setting,
     so it has to be set again afterwards (⏰ Triggers → ⋮ → Edit trigger).
   - **`appsscript.json` changed** — if `oauthScopes` gained an entry, the user will
     be asked to re-authorize on the next run. Say which permission it is and why.
   - **The scoring schema or prompt in `Claude.gs` changed** — existing scores were
     produced by the old one and are no longer comparable to new ones. Say so; the
     user may want to clear the Score column to have rows re-scored.
   - **New non-private function added** (no trailing underscore) — it will appear in
     the editor's Run dropdown. Confirm that was intended.

4. Do not run anything or commit. This skill only reports.
