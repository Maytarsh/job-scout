#!/usr/bin/env bash
# This repository is public. Nothing person-specific may reach a .gs file: not a
# name, not a city, not a target role, not a threshold someone tuned. All of it
# belongs in the deployer's own Sheet, and the sample values that seed that Sheet
# belong in Setup.gs, marked SAMPLE.
#
# The rule as prose is easy to keep by accident and easy to break by accident —
# a "helpful" default location in Config.gs looks like tidiness at the time. This
# makes the rule say something when it is broken.
set -u

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
case "$file" in
  */src/*.gs) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0

base=$(basename "$file")
# Setup.gs is where the sample Profile and Sources rows live, by design.
[ "$base" = "Setup.gs" ] && exit 0

# US_STATES in Config.gs is a general lookup table, not somebody's locations.
# Blanked rather than deleted so the reported line numbers still point at the
# real lines.
hits=$(sed '/^var US_STATES = {/,/^};/s/.*//' "$file" | grep -nEi \
  'los angeles|manhattan beach|malibu|orange county|austin|new york|san diego|h-1b|real estate (development|acquisitions)' \
  | grep -viE '^\s*[0-9]+:\s*(//|\*)' | head -10)

[ -n "$hits" ] || exit 0

msg="Possible person-specific data in $base:
$hits
This repo is public. Locations, target roles, employers and resume facts belong
in the deployer's Sheet; the sample rows that seed it belong in Setup.gs."

jq -n --arg m "$msg" '{
  systemMessage: $m,
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $m }
}'
