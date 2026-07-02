<#
.SYNOPSIS
  Commit Force -- fetch a GitHub repo's activity in a date range into a bundle .json you can load
  into the game (PowerShell 5.1+ / 7+).

.DESCRIPTION
  Pages through a repo's issues, PRs, commits and releases in a window and writes
  <owner>-<repo>-commit-force.json. Uses YOUR GitHub token, which stays on your machine and only
  ever talks to api.github.com -- it is NEVER sent to the website. Authenticated calls get GitHub's
  5000/hr limit instead of the anonymous 60/hr.

  If $env:GITHUB_TOKEN (or $env:GH_TOKEN) isn't set you'll be prompted for one securely (or you can
  press Enter to try anonymously). Create a read-only token at https://github.com/settings/tokens --
  fine-grained: Contents = Read; classic: 'repo' scope for private repos, no scopes for public.

.PARAMETER Repo
  owner/name (a full https://github.com/owner/name URL also works).

.PARAMETER Branch
  Branch for commits (default: the repo's default branch).

.PARAMETER Start
  Window start, YYYY-MM-DD (default: 14 days ago, UTC).

.PARAMETER End
  Window end, YYYY-MM-DD (default: today, UTC).

.EXAMPLE
  ./commit-force-fetch.ps1 microsoft/vscode
  Fetch the last 14 days (you'll be prompted for a token if none is set).

.EXAMPLE
  $env:GITHUB_TOKEN = "ghp_xxx"
  ./commit-force-fetch.ps1 microsoft/vscode -Branch main -Start 2025-01-01 -End 2025-07-01

.LINK
  https://ithinkthisisfun.com/games/commit-force/
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, HelpMessage = "Repo as owner/name, e.g. microsoft/vscode")][string]$Repo,
  [string]$Branch = "",
  [string]$Start = (Get-Date).ToUniversalTime().AddDays(-14).ToString("yyyy-MM-dd"),
  [string]$End   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
)
$ErrorActionPreference = "Stop"

# Clean one-line failure to stderr, then stop -- avoids PowerShell's scary red code-frame error view.
function Die([string]$msg) { [Console]::Error.WriteLine($msg); exit 1 }

# ---- token: env first, else prompt securely (no env var needed for casual, interactive use) ----
$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { "" }
if (-not $token) {
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    Write-Host "No GITHUB_TOKEN set. Create a read-only token at " -NoNewline; Write-Host "https://github.com/settings/tokens" -ForegroundColor Cyan
    Write-Host "  (fine-grained: Contents = Read;  classic: 'repo' for private repos, no scopes for public)."
    $sec = Read-Host -AsSecureString "Paste your GitHub token (hidden), or press Enter to try anonymously"
    $token = [System.Net.NetworkCredential]::new("", $sec).Password
    Write-Host ""
  } else {
    Write-Host "No token set -- proceeding anonymously (60 requests/hour). Set `$env:GITHUB_TOKEN for 5000/hr." -ForegroundColor Yellow
  }
}

$Repo = $Repo -replace '^https?://github.com/', '' -replace '\.git$', '' -replace '/+$', ''
if ($Repo -notmatch '^[^/]+/[^/]+$') { Die "Repo must be owner/name (e.g. microsoft/vscode)." }
if ($End -lt $Start) { Die "End date ($End) is before start date ($Start)." }

$since = "${Start}T00:00:00Z"; $until = "${End}T23:59:59Z"
$sinceDt = [datetime]$since; $untilDt = [datetime]$until
$api = if ($env:GH_API) { $env:GH_API } else { "https://api.github.com" }   # override for offline testing against test/mock-github.mjs
$headers = @{
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "commit-force-fetch"
}
if ($token) { $headers.Authorization = "Bearer $token" }

# Pull remaining/reset straight from GitHub's own endpoint (avoids cross-version response-header parsing).
function Get-RateText {
  try {
    $rl = Invoke-RestMethod -Uri "$api/rate_limit" -Headers $headers -Method Get
    $reset = [DateTimeOffset]::FromUnixTimeSeconds([long]$rl.rate.reset).LocalDateTime
    return "$($rl.rate.remaining)/$($rl.rate.limit) left, resets $($reset.ToString('t'))"
  } catch { return "" }
}
# Turn an HTTP failure into a plain-English message, then stop.
function Stop-Http($err, $ctx) {
  $st = 0; try { $st = [int]$err.Exception.Response.StatusCode } catch {}
  switch ($st) {
    401 { Die "GitHub rejected the token (401) -- it's invalid or expired. New token: https://github.com/settings/tokens" }
    403 { $rt = Get-RateText; Die ("GitHub said 403 while $ctx" + $(if ($rt) { " -- rate limit: $rt" } else { " (rate limit or forbidden)" }) + ". Wait for the reset or use a token, then retry.") }
    404 { Die ("Not found (404) while $ctx -- check '$Repo'" + $(if ($Branch) { " / branch '$Branch'" } else { "" }) + " and that your token can see it.") }
    default { Die "Request failed while ${ctx}: $($err.Exception.Message)" }
  }
}

# Follows the Link rel="next" cursor rather than ?page=N (GitHub 422s on page numbers for large datasets).
# Uses Invoke-WebRequest (not -RestMethod) so we can read the Link response header.
function Get-Paged([string]$path, [string]$stopField, [string]$label) {
  $out = New-Object System.Collections.ArrayList
  $sep = if ($path -match '\?') { '&' } else { '?' }
  $url = "$api$path${sep}per_page=100"
  if ($label) { Write-Host -NoNewline "  $label " }
  while ($url) {
    try { $resp = Invoke-WebRequest -Uri $url -Headers $headers -Method Get -UseBasicParsing }
    catch { if ($label) { Write-Host "" }; Stop-Http $_ "fetching $($label.Trim())" }
    $data = $resp.Content | ConvertFrom-Json
    $arr = if ($data -is [System.Array]) { $data } elseif ($null -ne $data) { @($data) } else { @() }
    if ($arr.Count -eq 0) { break }
    [void]$out.AddRange($arr)
    if ($label) { Write-Host -NoNewline "." }
    if ($stopField) {
      $oldest = $arr[-1].$stopField
      if ($oldest -and ([datetime]$oldest -lt $sinceDt)) { break }
    }
    $link = $resp.Headers["Link"]; if ($link -is [System.Array]) { $link = $link -join ',' }   # follow rel="next"
    $m = [regex]::Match([string]$link, '<([^>]+)>;\s*rel="next"')
    $url = if ($m.Success) { $m.Groups[1].Value } else { $null }
  }
  if ($label) { Write-Host " $($out.Count)" }
  return $out
}

Write-Host ""
Write-Host "Commit Force: fetching " -NoNewline; Write-Host "$Repo" -ForegroundColor Cyan -NoNewline
Write-Host "  ($Start .. $End)$(if ($Branch) { "  branch=$Branch" })"
if ($token) {
  try {
    $me = Invoke-RestMethod -Uri "$api/user" -Headers $headers -Method Get
    $rt = Get-RateText
    Write-Host "  authenticated as $($me.login)$(if ($rt) { "  ($rt)" })"
  } catch {
    $st = 0; try { $st = [int]$_.Exception.Response.StatusCode } catch {}
    if ($st -eq 401) { Stop-Http $_ "checking the token" }
    # other failures here (e.g. the offline mock has no /user) are harmless -- skip the niceties
  }
} else {
  Write-Host "  (anonymous -- 60 requests/hour)"
}

$issues = @(Get-Paged "/repos/$Repo/issues?state=all&sort=updated&direction=desc&since=$since" "updated_at" "issues " |
  Where-Object { -not $_.pull_request -and ([datetime]$_.updated_at) -ge $sinceDt -and ([datetime]$_.updated_at) -le $untilDt } |
  ForEach-Object {
    [ordered]@{
      number = $_.number; title = $_.title; url = $_.html_url; state = $_.state
      labels = @($_.labels | ForEach-Object { @{ name = $_.name } })
      author = if ($_.user) { @{ login = $_.user.login } } else { $null }
      comments = $_.comments; createdAt = $_.created_at; updatedAt = $_.updated_at; closedAt = $_.closed_at
    }
  })

$prs = @(Get-Paged "/repos/$Repo/pulls?state=all&sort=updated&direction=desc" "updated_at" "PRs    " |
  Where-Object { ([datetime]$_.updated_at) -ge $sinceDt -and ([datetime]$_.updated_at) -le $untilDt } |
  ForEach-Object {
    [ordered]@{
      number = $_.number; title = $_.title; state = $_.state
      author = if ($_.user) { @{ login = $_.user.login } } else { $null }
      createdAt = $_.created_at; closedAt = $_.closed_at; mergedAt = $_.merged_at
    }
  })

$commitsPath = "/repos/$Repo/commits?since=$since&until=$until"
if ($Branch) { $commitsPath += "&sha=$Branch" }
$commits = @(Get-Paged $commitsPath "" "commits" |
  ForEach-Object {
    [ordered]@{
      sha   = ([string]$_.sha).Substring(0, 7)
      date  = if ($_.commit.author.date) { $_.commit.author.date } else { $_.commit.committer.date }
      login = if ($_.author -and $_.author.login) { $_.author.login } elseif ($_.commit.author.name) { $_.commit.author.name } else { "?" }
      msg   = (($_.commit.message -split "`n")[0])
    }
  })

$releases = @(Get-Paged "/repos/$Repo/releases" "" "release" |
  Where-Object { $_.published_at -and ([datetime]$_.published_at) -ge $sinceDt -and ([datetime]$_.published_at) -le $untilDt } |
  ForEach-Object { [ordered]@{ tag = $_.tag_name; name = $_.name; pre = $_.prerelease; publishedAt = $_.published_at } })

$bundle = [ordered]@{ repo = $Repo; branch = $Branch; start = $since; end = $until; issues = $issues; prs = $prs; commits = $commits; releases = $releases }
$outFile = ($Repo -replace '/', '-') + "-commit-force.json"
$bundle | ConvertTo-Json -Depth 20 | Set-Content -Path $outFile -Encoding UTF8
$full = (Resolve-Path $outFile).Path

Write-Host ""
if ($issues.Count -eq 0 -and $prs.Count -eq 0 -and $commits.Count -eq 0) {
  Write-Host "No activity found in that window. Try a wider range with -Start / -End." -ForegroundColor Yellow
}
Write-Host "Wrote " -NoNewline; Write-Host $full -ForegroundColor Green
Write-Host ("  {0} issues, {1} PRs, {2} commits, {3} releases in the bundle." -f $issues.Count, $prs.Count, $commits.Count, $releases.Count)
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Open https://ithinkthisisfun.com/games/commit-force/"
Write-Host "  2. Click 'Load a .json file' and pick the file above."

if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $open = Read-Host "Open the game in your browser now? [y/N]"
  if ($open -match '^(y|yes)$') { Start-Process "https://ithinkthisisfun.com/games/commit-force/" }
}
