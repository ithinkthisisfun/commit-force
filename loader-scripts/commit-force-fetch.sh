#!/usr/bin/env bash
# ============================================================================
#  !!  COMPLETELY UNTESTED as of this writing  !!
#  This script has NOT been run end-to-end yet. Read it before you trust it, and
#  expect rough edges (GNU-vs-BSD `date`, jq quirks, pagination). It only ever
#  talks to api.github.com -- your token never goes anywhere else.
# ============================================================================
# Commit Force -- local fetcher.
# Uses YOUR GitHub token (stays on your machine; it is NEVER sent to the site) to pull a repo's
# activity in a date range and write a bundle .json. Load that file at
#   https://ithinkthisisfun.com/games/commit-force/   ->   "Load a .json file".
# Authenticated, so you get GitHub's 5000/hr limit instead of the anonymous 60/hr.
#
# Needs: bash, curl, jq  (https://jqlang.github.io/jq/)
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./commit-force-fetch.sh owner/repo [branch] [start YYYY-MM-DD] [end YYYY-MM-DD]
# Examples:
#   GITHUB_TOKEN=ghp_xxx ./commit-force-fetch.sh microsoft/vscode
#   GITHUB_TOKEN=ghp_xxx ./commit-force-fetch.sh microsoft/vscode main 2025-01-01 2025-07-01
set -euo pipefail

REPO="${1:-}"
if [ -z "$REPO" ]; then echo "usage: GITHUB_TOKEN=ghp_xxx $0 owner/repo [branch] [start YYYY-MM-DD] [end YYYY-MM-DD]"; exit 1; fi
REPO="$(printf '%s' "$REPO" | sed -E 's#^https?://github.com/##; s#\.git$##; s#/+$##')"
if ! printf '%s' "$REPO" | grep -Eq '^[^/]+/[^/]+$'; then echo "repo must be owner/name"; exit 1; fi
BRANCH="${2:-}"
END="${4:-$(date -u +%F)}"
START="${3:-$(date -u -d '14 days ago' +%F 2>/dev/null || date -u -v-14d +%F)}"   # GNU date || BSD/macOS date
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then echo "set GITHUB_TOKEN to a PAT (read access; 'repo' scope for private repos)"; exit 1; fi
command -v jq >/dev/null 2>&1 || { echo "this needs jq -- https://jqlang.github.io/jq/"; exit 1; }

SINCE="${START}T00:00:00Z"; UNTIL="${END}T23:59:59Z"
API="${GH_API:-https://api.github.com}"   # override for offline testing against test/mock-github.mjs
HDR=(-fsS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

# Fetch every page of a list endpoint -> one JSON array on stdout. If $2 is a field name, stop
# paging once a page's oldest item (last, since we sort desc) is before SINCE.
fetch_pages() {
  local path="$1" stopfield="${2:-}" page=1 sep pages="" pg n oldest
  while : ; do
    case "$path" in *\?*) sep="&";; *) sep="?";; esac
    if ! pg="$(curl "${HDR[@]}" "$API$path${sep}per_page=100&page=$page")"; then
      echo "request failed for $path (page $page) -- bad repo/branch, or token lacks access?" >&2; exit 1
    fi
    n="$(printf '%s' "$pg" | jq 'length')"
    [ "$n" -eq 0 ] && break
    pages="${pages}${pg}"$'\n'                 # accumulate each page's raw array (pipe-only; no <() or temp files -- native Windows jq can't read those paths)
    if [ -n "$stopfield" ]; then
      oldest="$(printf '%s' "$pg" | jq -r ".[-1].$stopfield // empty")"
      [ -n "$oldest" ] && [ "$oldest" \< "$SINCE" ] && break
    fi
    [ "$n" -lt 100 ] && break
    page=$((page+1))
  done
  printf '%s' "$pages" | jq -s 'add // []'      # concatenate the page arrays into one, via stdin
}

echo "Commit Force: fetching $REPO  ($START .. $END)${BRANCH:+  branch=$BRANCH} ..." >&2

# Write each normalized array to a temp file in the CWD (relative names -- native Windows jq can't read
# /tmp or msys paths), then --slurpfile them. Files (not --argjson) so we never hit the argv length cap.
TI="._cf_issues.json"; TP="._cf_prs.json"; TC="._cf_commits.json"; TR="._cf_releases.json"
trap 'rm -f "$TI" "$TP" "$TC" "$TR"' EXIT

fetch_pages "/repos/$REPO/issues?state=all&sort=updated&direction=desc&since=$SINCE" updated_at \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select((.pull_request|not) and .updated_at >= $s and .updated_at <= $u)
      | {number, title, url:.html_url, state,
         labels:[(.labels // [])[] | {name}],
         author:(if .user then {login:.user.login} else null end),
         comments, createdAt:.created_at, updatedAt:.updated_at, closedAt:.closed_at} ]' > "$TI"

fetch_pages "/repos/$REPO/pulls?state=all&sort=updated&direction=desc" updated_at \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select(.updated_at >= $s and .updated_at <= $u)
      | {number, title, state,
         author:(if .user then {login:.user.login} else null end),
         createdAt:.created_at, closedAt:.closed_at, mergedAt:.merged_at} ]' > "$TP"

COMMITS_PATH="/repos/$REPO/commits?since=$SINCE&until=$UNTIL"
[ -n "$BRANCH" ] && COMMITS_PATH="$COMMITS_PATH&sha=$BRANCH"
fetch_pages "$COMMITS_PATH" \
  | jq '[ .[] | {sha:(.sha[0:7]),
         date:(.commit.author.date // .commit.committer.date),
         login:(.author.login // .commit.author.name // "?"),
         msg:((.commit.message // "") | split("\n")[0])} ]' > "$TC"

fetch_pages "/repos/$REPO/releases" \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select(.published_at != null and .published_at >= $s and .published_at <= $u)
      | {tag:.tag_name, name:.name, pre:.prerelease, publishedAt:.published_at} ]' > "$TR"

OUT="$(printf '%s' "$REPO" | tr '/' '-')-commit-force.json"
jq -n --arg repo "$REPO" --arg branch "$BRANCH" --arg start "$SINCE" --arg end "$UNTIL" \
  --slurpfile issues "$TI" --slurpfile prs "$TP" --slurpfile commits "$TC" --slurpfile releases "$TR" \
  '{repo:$repo, branch:$branch, start:$start, end:$end, issues:$issues[0], prs:$prs[0], commits:$commits[0], releases:$releases[0]}' > "$OUT"

echo "Wrote $OUT  --  $(jq '.issues|length' "$OUT") issues, $(jq '.prs|length' "$OUT") PRs, $(jq '.commits|length' "$OUT") commits." >&2
echo "Load it at https://ithinkthisisfun.com/games/commit-force/  ->  \"Load a .json file\"." >&2
