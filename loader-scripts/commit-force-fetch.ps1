<#
  ============================================================================
   !!  COMPLETELY UNTESTED as of this writing  !!
   This script has NOT been run end-to-end yet. Read it before you trust it, and
   expect rough edges (ConvertTo-Json depth, single-item arrays, date parsing).
   It only ever talks to api.github.com -- your token never goes anywhere else.
  ============================================================================

  Commit Force -- local fetcher (PowerShell 5.1+ / 7+).
  Uses YOUR GitHub token (stays on your machine; it is NEVER sent to the site) to pull a repo's
  activity in a date range and write a bundle .json. Load that file at
     https://ithinkthisisfun.com/games/commit-force/   ->   "Load a .json file".
  Authenticated, so you get GitHub's 5000/hr limit instead of the anonymous 60/hr.

  Usage:
     $env:GITHUB_TOKEN = "ghp_xxx"
     ./commit-force-fetch.ps1 owner/repo [-Branch main] [-Start 2025-01-01] [-End 2025-07-01]
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Repo,
  [string]$Branch = "",
  [string]$Start = (Get-Date).ToUniversalTime().AddDays(-14).ToString("yyyy-MM-dd"),
  [string]$End   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
)
$ErrorActionPreference = "Stop"

$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { "" }
if (-not $token) { Write-Error "Set `$env:GITHUB_TOKEN to a PAT (read access; 'repo' scope for private repos)."; exit 1 }
$Repo = $Repo -replace '^https?://github.com/', '' -replace '\.git$', '' -replace '/+$', ''
if ($Repo -notmatch '^[^/]+/[^/]+$') { Write-Error "Repo must be owner/name."; exit 1 }

$since = "${Start}T00:00:00Z"; $until = "${End}T23:59:59Z"
$sinceDt = [datetime]$since; $untilDt = [datetime]$until
$api = if ($env:GH_API) { $env:GH_API } else { "https://api.github.com" }   # override for offline testing against test/mock-github.mjs
$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "commit-force-fetch"
}

function Get-Paged([string]$path, [string]$stopField) {
  $out = New-Object System.Collections.ArrayList
  $page = 1
  while ($true) {
    $sep = if ($path -match '\?') { '&' } else { '?' }
    try { $resp = Invoke-RestMethod -Uri "$api$path${sep}per_page=100&page=$page" -Headers $headers -Method Get }
    catch { Write-Error "Request failed for $path (page $page): $($_.Exception.Message) -- bad repo/branch, or token lacks access?"; exit 1 }
    # Invoke-RestMethod emits a JSON array as ONE non-enumerated item, so @(...) would wrap it. Coerce:
    $arr = if ($resp -is [System.Array]) { $resp } elseif ($null -ne $resp) { @($resp) } else { @() }
    if ($arr.Count -eq 0) { break }
    [void]$out.AddRange($arr)
    if ($stopField) {
      $oldest = $arr[-1].$stopField
      if ($oldest -and ([datetime]$oldest -lt $sinceDt)) { break }
    }
    if ($arr.Count -lt 100) { break }
    $page++
  }
  return $out
}

Write-Host "Commit Force: fetching $Repo  ($Start .. $End)$(if ($Branch) { "  branch=$Branch" }) ..."

$issues = @(Get-Paged "/repos/$Repo/issues?state=all&sort=updated&direction=desc&since=$since" "updated_at" |
  Where-Object { -not $_.pull_request -and ([datetime]$_.updated_at) -ge $sinceDt -and ([datetime]$_.updated_at) -le $untilDt } |
  ForEach-Object {
    [ordered]@{
      number = $_.number; title = $_.title; url = $_.html_url; state = $_.state
      labels = @($_.labels | ForEach-Object { @{ name = $_.name } })
      author = if ($_.user) { @{ login = $_.user.login } } else { $null }
      comments = $_.comments; createdAt = $_.created_at; updatedAt = $_.updated_at; closedAt = $_.closed_at
    }
  })

$prs = @(Get-Paged "/repos/$Repo/pulls?state=all&sort=updated&direction=desc" "updated_at" |
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
$commits = @(Get-Paged $commitsPath |
  ForEach-Object {
    [ordered]@{
      sha   = ([string]$_.sha).Substring(0, 7)
      date  = if ($_.commit.author.date) { $_.commit.author.date } else { $_.commit.committer.date }
      login = if ($_.author -and $_.author.login) { $_.author.login } elseif ($_.commit.author.name) { $_.commit.author.name } else { "?" }
      msg   = (($_.commit.message -split "`n")[0])
    }
  })

$releases = @(Get-Paged "/repos/$Repo/releases" |
  Where-Object { $_.published_at -and ([datetime]$_.published_at) -ge $sinceDt -and ([datetime]$_.published_at) -le $untilDt } |
  ForEach-Object { [ordered]@{ tag = $_.tag_name; name = $_.name; pre = $_.prerelease; publishedAt = $_.published_at } })

$bundle = [ordered]@{ repo = $Repo; branch = $Branch; start = $since; end = $until; issues = $issues; prs = $prs; commits = $commits; releases = $releases }
$outFile = ($Repo -replace '/', '-') + "-commit-force.json"
$bundle | ConvertTo-Json -Depth 20 | Set-Content -Path $outFile -Encoding UTF8

Write-Host ("Wrote {0}  --  {1} issues, {2} PRs, {3} commits." -f $outFile, $issues.Count, $prs.Count, $commits.Count)
Write-Host 'Load it at https://ithinkthisisfun.com/games/commit-force/  ->  "Load a .json file".'
