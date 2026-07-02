// Commit Force -- LOCAL ONLY.  Copy this file to `local-token.js` (gitignored + stripped from deploy,
// so it never reaches production), paste a read-only GitHub token below, and reload your local copy.
// Every fetch then uses GitHub's 5000/hr limit (and can read private repos) instead of the anonymous
// 60/hr. The token stays in this file on your machine and only ever goes to api.github.com.
// Read-only is enough -- fine-grained: Contents = Read; classic: 'repo' for private, no scopes for public.
//   cp local-token.example.js local-token.js   ->   edit the line below   ->   reload
window.__GH_TOKEN = "PASTE PAT HERE";
