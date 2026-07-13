# History rewrite and secret-removal plan

This document outlines safe, reversible steps to remove leaked secrets from git history.

Steps
1. Immediately rotate the compromised secret(s) (e.g., revoke Slack webhook/token in the provider UI).
2. Create an offline backup of the repository (tar/zip). Do NOT run destructive commands before backup.
   - Example: `git bundle create repo.bundle --all`
3. Use `git filter-repo` (preferred) or BFG to remove the secret from history.
   - Example (filter-repo):
     - Install: `pip install git-filter-repo`
     - Run: `git filter-repo --invert-paths --path PATH/TO/FILE_WITH_SECRET`
   - To remove an exact string (e.g., Slack webhook) from all files:
     - `git filter-repo --replace-text replacements.txt`
     - `replacements.txt` contains lines like:
       `old_secret==>REMOVED_SECRET`
4. Verify rewritten history locally. Inspect with `git log --all -- PATH` and search for the secret.
5. Force-push rewritten branches and tags to remote (coordinate with collaborators):
   - `git push origin --force --all`
   - `git push origin --force --tags`
6. Ask teammates to re-clone or run:
   - `git fetch origin --all`
   - `git reset --hard origin/main` (or appropriate branch)
7. Rotate any remaining secrets and update secrets in the deployment environment (Cloudflare, CI, etc.).
8. Notify stakeholders and update SECURITY_GUIDE.md with the incident timeline.

Notes
- Do not remove commits indiscriminately; prefer replacing secrets with placeholders.
- Use `git filter-repo` over BFG when possible; it is more flexible.
- After force-pushing, CI caches or forks may still have copies—assume secrets are compromised until rotated.
