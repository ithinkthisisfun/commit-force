#!/usr/bin/env bash
# ============================================================================
# Commit Force -- local fetcher (bash + curl + jq).
# Pull a repo's activity in a date range and write a bundle .json you can load at
#   https://ithinkthisisfun.com/games/commit-force/   ->   "Load a .json file".
#
# Uses YOUR GitHub token, which stays on your machine and only ever talks to api.github.com --
# it is NEVER sent to the site. Authenticated calls get GitHub's 5000/hr limit vs the anonymous 60/hr.
# If no token is set you'll be prompted for one (or press Enter to try anonymously). Make a read-only
# token at https://github.com/settings/tokens (fine-grained: Contents=Read; classic: 'repo' for private).
#
# Needs: bash, curl, jq  (https://jqlang.github.io/jq/)
# Usage:
#   [GITHUB_TOKEN=ghp_xxx] ./commit-force-fetch.sh owner/repo [branch] [start YYYY-MM-DD] [end YYYY-MM-DD]
# Examples:
#   ./commit-force-fetch.sh microsoft/vscode
#   GITHUB_TOKEN=ghp_xxx ./commit-force-fetch.sh microsoft/vscode main 2025-01-01 2025-07-01
# ============================================================================
set -euo pipefail

case "${1:-}" in -h|--help|"")
  sed -n '/^# ====/,/^# ====/{ s/^# \{0,1\}//; p; }' "$0"    # print just the banner block, stripping the leading "# "
  [ -z "${1:-}" ] && exit 1 || exit 0 ;;
esac

REPO="$1"
REPO="$(printf '%s' "$REPO" | sed -E 's#^https?://github.com/##; s#\.git$##; s#/+$##')"
if ! printf '%s' "$REPO" | grep -Eq '^[^/]+/[^/]+$'; then echo "repo must be owner/name (e.g. microsoft/vscode)" >&2; exit 1; fi
BRANCH="${2:-}"
END="${4:-$(date -u +%F)}"
START="${3:-$(date -u -d '14 days ago' +%F 2>/dev/null || date -u -v-14d +%F)}"   # GNU date || BSD/macOS date
if [ "$END" \< "$START" ]; then echo "end date ($END) is before start date ($START)" >&2; exit 1; fi
command -v jq >/dev/null 2>&1 || { echo "this needs jq -- https://jqlang.github.io/jq/" >&2; exit 1; }

# ---- token: env first, else prompt (interactive only) ----
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    echo "" >&2
    echo "No GITHUB_TOKEN set. Create a read-only token at https://github.com/settings/tokens" >&2
    echo "  (fine-grained: Contents=Read;  classic: 'repo' for private repos, no scopes for public)." >&2
    printf "Paste your GitHub token (hidden), or press Enter to try anonymously: " >&2
    read -rs TOKEN || TOKEN=""
    echo "" >&2
  else
    echo "No token set -- proceeding anonymously (60 requests/hour). Set GITHUB_TOKEN for 5000/hr." >&2
  fi
fi

SINCE="${START}T00:00:00Z"; UNTIL="${END}T23:59:59Z"
API="${GH_API:-https://api.github.com}"   # override for offline testing against test/mock-github.mjs
HDR=(-sS -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: commit-force-fetch")
[ -n "$TOKEN" ] && HDR+=(-H "Authorization: Bearer $TOKEN")

# "N/M left, resets HH:MM" from GitHub's own endpoint (empty if unavailable, e.g. the offline mock).
rate_text() {
  local j rem lim reset rtime
  j="$(curl "${HDR[@]}" "$API/rate_limit" 2>/dev/null)" || return 0
  rem="$(printf '%s' "$j" | jq -r '.rate.remaining // empty' 2>/dev/null)" || return 0
  lim="$(printf '%s' "$j" | jq -r '.rate.limit // empty' 2>/dev/null)"
  reset="$(printf '%s' "$j" | jq -r '.rate.reset // empty' 2>/dev/null)"
  [ -z "$rem" ] && return 0
  rtime=""; [ -n "$reset" ] && rtime="$(date -d "@$reset" +%H:%M 2>/dev/null || date -r "$reset" +%H:%M 2>/dev/null || true)"
  printf '%s/%s left%s' "$rem" "$lim" "$([ -n "$rtime" ] && printf ', resets %s' "$rtime")"
}

# Plain-English message for an HTTP failure, then stop.  $1=code  $2=context
fail_http() {
  local code="$1" ctx="$2" rt
  case "$code" in
    401) echo "GitHub rejected the token (401) -- it's invalid or expired. New token: https://github.com/settings/tokens" >&2 ;;
    403) rt="$(rate_text)"; echo "GitHub said 403 while ${ctx}${rt:+ -- rate limit: $rt}. Wait for the reset or use a token, then retry." >&2 ;;
    404) echo "Not found (404) while ${ctx} -- check '$REPO'${BRANCH:+ / branch '$BRANCH'} and that your token can see it." >&2 ;;
    *)   echo "Request failed (HTTP ${code}) while ${ctx}." >&2 ;;
  esac
  exit 1
}

# Fetch every page of a list endpoint -> one JSON array on STDOUT (progress goes to stderr). If $2 is a
# field name, stop paging once a page's oldest item (last, since we sort desc) is before SINCE.
fetch_pages() {
  local path="$1" stopfield="${2:-}" label="${3:-}" page=1 sep pages="" resp code pg n oldest total=0 lbl
  lbl="$(printf '%s' "${label:-$path}" | sed 's/[[:space:]]*$//')"   # trimmed, for error messages
  [ -n "$label" ] && printf '  %s ' "$label" >&2
  while : ; do
    case "$path" in *\?*) sep="&";; *) sep="?";; esac
    resp="$(curl "${HDR[@]}" -w $'\n%{http_code}' "$API$path${sep}per_page=100&page=$page")" \
      || { [ -n "$label" ] && echo "" >&2; echo "network error while fetching $lbl" >&2; exit 1; }
    code="${resp##*$'\n'}"; pg="${resp%$'\n'*}"
    if [ "$code" != "200" ]; then [ -n "$label" ] && echo "" >&2; fail_http "$code" "fetching $lbl"; fi
    n="$(printf '%s' "$pg" | jq 'length')"
    [ "$n" -eq 0 ] && break
    pages="${pages}${pg}"$'\n'                 # accumulate raw arrays (pipe-only; native Windows jq can't read <() or temp fd paths)
    total=$((total+n)); [ -n "$label" ] && printf '.' >&2
    if [ -n "$stopfield" ]; then
      oldest="$(printf '%s' "$pg" | jq -r ".[-1].$stopfield // empty")"
      [ -n "$oldest" ] && [ "$oldest" \< "$SINCE" ] && break
    fi
    [ "$n" -lt 100 ] && break
    page=$((page+1))
  done
  [ -n "$label" ] && printf ' %s\n' "$total" >&2
  printf '%s' "$pages" | jq -s 'add // []'
}

echo "" >&2
echo "Commit Force: fetching $REPO  ($START .. $END)${BRANCH:+  branch=$BRANCH}" >&2
if [ -n "$TOKEN" ]; then
  who="$(curl "${HDR[@]}" -w $'\n%{http_code}' "$API/user")" || who=""
  wc="${who##*$'\n'}"; wb="${who%$'\n'*}"
  if [ "$wc" = "401" ]; then fail_http 401 "checking the token"; fi
  if [ "$wc" = "200" ]; then
    login="$(printf '%s' "$wb" | jq -r '.login // empty' 2>/dev/null || true)"; rt="$(rate_text)"
    echo "  authenticated as ${login:-?}${rt:+  ($rt)}" >&2
  fi
else
  echo "  (anonymous -- 60 requests/hour)" >&2
fi

# Write each normalized array to a temp file in the CWD (relative names -- native Windows jq can't read
# /tmp or msys paths), then --slurpfile them. Files (not --argjson) so we never hit the argv length cap.
TI="._cf_issues.json"; TP="._cf_prs.json"; TC="._cf_commits.json"; TR="._cf_releases.json"
trap 'rm -f "$TI" "$TP" "$TC" "$TR"' EXIT

fetch_pages "/repos/$REPO/issues?state=all&sort=updated&direction=desc&since=$SINCE" updated_at "issues " \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select((.pull_request|not) and .updated_at >= $s and .updated_at <= $u)
      | {number, title, url:.html_url, state,
         labels:[(.labels // [])[] | {name}],
         author:(if .user then {login:.user.login} else null end),
         comments, createdAt:.created_at, updatedAt:.updated_at, closedAt:.closed_at} ]' > "$TI"

fetch_pages "/repos/$REPO/pulls?state=all&sort=updated&direction=desc" updated_at "PRs    " \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select(.updated_at >= $s and .updated_at <= $u)
      | {number, title, state,
         author:(if .user then {login:.user.login} else null end),
         createdAt:.created_at, closedAt:.closed_at, mergedAt:.merged_at} ]' > "$TP"

COMMITS_PATH="/repos/$REPO/commits?since=$SINCE&until=$UNTIL"
[ -n "$BRANCH" ] && COMMITS_PATH="$COMMITS_PATH&sha=$BRANCH"
fetch_pages "$COMMITS_PATH" "" "commits" \
  | jq '[ .[] | {sha:(.sha[0:7]),
         date:(.commit.author.date // .commit.committer.date),
         login:(.author.login // .commit.author.name // "?"),
         msg:((.commit.message // "") | split("\n")[0])} ]' > "$TC"

fetch_pages "/repos/$REPO/releases" "" "release" \
  | jq --arg s "$SINCE" --arg u "$UNTIL" '[ .[]
      | select(.published_at != null and .published_at >= $s and .published_at <= $u)
      | {tag:.tag_name, name:.name, pre:.prerelease, publishedAt:.published_at} ]' > "$TR"

OUT="$(printf '%s' "$REPO" | tr '/' '-')-commit-force.json"
jq -n --arg repo "$REPO" --arg branch "$BRANCH" --arg start "$SINCE" --arg end "$UNTIL" \
  --slurpfile issues "$TI" --slurpfile prs "$TP" --slurpfile commits "$TC" --slurpfile releases "$TR" \
  '{repo:$repo, branch:$branch, start:$start, end:$end, issues:$issues[0], prs:$prs[0], commits:$commits[0], releases:$releases[0]}' > "$OUT"

NI="$(jq '.issues|length' "$OUT")"; NP="$(jq '.prs|length' "$OUT")"; NC="$(jq '.commits|length' "$OUT")"; NR="$(jq '.releases|length' "$OUT")"
OUT_FULL="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
echo "" >&2
if [ "$NI" -eq 0 ] && [ "$NP" -eq 0 ] && [ "$NC" -eq 0 ]; then
  echo "No activity found in that window. Try a wider range (start/end args)." >&2
fi
echo "Wrote $OUT_FULL" >&2
echo "  $NI issues, $NP PRs, $NC commits, $NR releases in the bundle." >&2
echo "" >&2
echo "Next:" >&2
echo "  1. Open https://ithinkthisisfun.com/games/commit-force/" >&2
echo "  2. Click \"Load a .json file\" and pick the file above." >&2

if [ -t 0 ] && [ -t 1 ]; then
  printf "Open the game in your browser now? [y/N] " >&2
  read -r ans || ans=""
  case "$ans" in
    y|Y|yes|YES)
      URL="https://ithinkthisisfun.com/games/commit-force/"
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
      elif command -v open >/dev/null 2>&1; then open "$URL"
      elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL" >/dev/null 2>&1 || true
      elif command -v powershell.exe >/dev/null 2>&1; then powershell.exe -NoProfile -Command "Start-Process '$URL'" >/dev/null 2>&1 || true
      fi ;;
  esac
fi
