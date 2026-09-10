#!/usr/bin/env bash
# Apps Script evaluates project files alphabetically, not in dependency order.
# Apply.gs, Claude.gs and Extract.gs all run before Config.gs, so a top-level
# `var` in any of them reads CONFIG/WEIGHTS/TABS/*_HEADERS as undefined — and
# JSON.stringify drops undefined keys without complaint, which is how a schema
# constraining nothing gets shipped. Build anything derived from Config lazily,
# inside a function, as scoreSchema_() and draftSchema_() do.
set -u

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
case "$file" in
  */src/*.gs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

# Only files evaluated before Config.gs can see its globals as undefined.
base=$(basename "$file")
[ "$base" = "Config.gs" ] && exit 0
[ "$(printf '%s\nConfig.gs\n' "$base" | sort | head -1)" = "$base" ] || exit 0

hits=$(awk '
  { line = $0 }
  depth == 0 && line ~ /^var[ \t]/ { in_var = 1; buf = ""; start = NR }
  in_var { buf = buf " " line }
  {
    n = gsub(/[{([]/, "&", line); m = gsub(/[})\]]/, "&", line)
    depth += n - m
  }
  in_var && depth <= 0 && line ~ /;[ \t]*$/ {
    if ((buf " ") ~ /[^A-Za-z0-9_$](CONFIG|WEIGHTS|TABS|STATUSES|PROFILE_KEYS|ANSWER_KEYS|SOURCE_TYPES|COMPANY_SUFFIXES|STRIP_ELEMENTS|BLOCKED_PATTERNS|UNKNOWN_AGE|UNESTABLISHED|JOBS_HEADERS|REPORT_HEADERS|PROFILE_HEADERS|SOURCES_HEADERS|ANSWERS_HEADERS|FACTS_HEADERS|RUNS_HEADERS|ERRORS_HEADERS)[^A-Za-z0-9_$]/) {
      match(buf, /var[ \t]+[A-Za-z_$][A-Za-z0-9_$]*/)
      print "    line " start ": " substr(buf, RSTART, RLENGTH)
    }
    in_var = 0; buf = ""
  }
' "$file")

[ -n "$hits" ] || exit 0

msg="Load-order risk in $base (evaluated before Config.gs):
$hits
These read Config.gs globals at load time, where they are still undefined.
Build them lazily inside a function, as scoreSchema_() and draftSchema_() do."

jq -n --arg m "$msg" '{
  systemMessage: $m,
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $m }
}'
