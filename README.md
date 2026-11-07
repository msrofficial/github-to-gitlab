# github-to-gitlab

Automatically mirrors **every** GitHub repository (personal and organization, private included) into GitLab as a full git mirror.

On each run:

- a **new repo** on GitHub → a new GitLab project is created for it
- **new commits / branches / tags / force-pushes** → re-synced on the next run
- repositories that were already mirrored are **updated, never duplicated** (incremental, so later runs are much faster)

> GitLab's own **pull mirroring** (GitHub → GitLab) is a Premium feature. This tool uses `git push --mirror` instead, so it works on a free GitLab account.

---

## 1. Create the tokens

**GitHub token** — https://github.com/settings/tokens (classic) → *Generate new token*
scopes: `repo`, `read:org`

**GitLab token** — https://gitlab.com/-/user_settings/personal_access_tokens
scopes: `api`, `write_repository`

## 2. Configure

```bash
cp .env.example .env
```

Then fill in the two tokens:

```env
GH_TOKEN=ghp_...
GL_TOKEN=glpat-...
GL_NAMESPACE=          # empty = your own namespace; or a group such as "backups/github"
```

## 3. Test with a single repository first

```bash
node --env-file=.env mirror.mjs
```

To preview a single repo without changing anything, add to `.env`:

```env
ONLY_MATCH=^your-username/test-repo$
DRY_RUN=1        # prints the plan only; remove it afterwards
```

Then remove `ONLY_MATCH` and `DRY_RUN` and run everything:

```bash
node --env-file=.env mirror.mjs
```

## 4. Make it automatic

### Option A — your own PC (Windows Task Scheduler, every 30 minutes)

```cmd
schtasks /Create /TN "GitHub to GitLab Mirror" /TR "\"F:\agentingcoding\github-to-gitlab\run-mirror.cmd\"" /SC MINUTE /MO 30 /F
```

Output goes to `mirror.log`. The task runs under your user account, so you must be logged in (choosing "Run whether user is logged on or not" requires storing your password). Remove it with: `schtasks /Delete /TN "GitHub to GitLab Mirror" /F`

### Option B — GitHub Actions (runs even when your PC is off, free)

Push this folder to a GitHub repository, then add the tokens under
**Settings → Secrets and variables → Actions**:

```bash
gh secret set GH_TOKEN --repo <you>/github-to-gitlab
gh secret set GL_TOKEN --repo <you>/github-to-gitlab
gh variable set GL_NAMESPACE --repo <you>/github-to-gitlab --body "backups/github"   # optional
```

It then runs every 30 minutes on its own, or trigger it by hand from
**Actions → Mirror GitHub to GitLab → Run workflow** (GitHub's cron can be delayed by a few minutes).

**If the repository is public:**

- Actions minutes are free, so the 30-minute schedule costs nothing.
- GitHub disables scheduled workflows in a public repo after 60 days **without repository activity**. `.github/workflows/keepalive.yml` commits a small `.keepalive` file every Monday to keep the schedule enabled — don't delete it.
- Actions logs in a public repo are readable by anyone, so the workflow sets `HIDE_NAMES: "1"`: repository names appear as `repo#b92bb3e3`. Set it to `"0"` temporarily to debug a failing repo (names become public).
- Workflows from forks cannot run this job (it is triggered only by `schedule` / `workflow_dispatch`), and GitHub blocks secrets in fork workflows, so `GH_TOKEN` stays private.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GH_TOKEN` | — | GitHub PAT (`repo`, `read:org`) |
| `GL_TOKEN` | — | GitLab PAT (`api`, `write_repository`) |
| `GL_NAMESPACE` | your namespace | Target group/subgroup on GitLab |
| `GL_HOST` | `gitlab.com` | GitLab instance |
| `GH_HOST` | `github.com` | GitHub instance |
| `MIRROR_DIR` | `.mirrors` | Local cache of bare clones |
| `CONCURRENCY` | `3` | Repositories mirrored in parallel (max 8) |
| `INCLUDE_FORKS` | `false` | Also mirror forks |
| `INCLUDE_ARCHIVED` | `true` | Also mirror archived repos |
| `ONLY_MATCH` | — | Regex on `owner/repo`, useful for a first run |
| `GL_UNPROTECT` | `true` | Drop GitLab branch protection so force-pushes can land |
| `DRY_RUN` | `false` | Print the plan, change nothing |
| `HIDE_NAMES` | `false` | Replace repo names in output with short hashes |

## How syncing works

| On GitHub | On GitLab |
|---|---|
| new repo | new private project (name clash → `repo-owner` suffix) |
| new commit / branch / tag | synced with `git push --mirror` |
| branch/tag deleted | deleted on GitLab too |
| history rewrite (force-push) | force-pushed; branch protection is removed when needed (`GL_UNPROTECT`) |
| repo renamed | the old project stays, a new one is created under the new name |

Every GitLab project carries a `github-mirror:owner/repo` marker in its description — that is how repos are matched.
Two repos with the same name (for example `you/api` and `myorg/api`) are therefore backed up separately.

## Limitations

- **Deleting a repo** on GitHub does not delete it on GitLab — a safe default for a backup; remove it by hand.
- **Git LFS** objects are not copied, only the pointer files.
- GitLab's free plan limits each repository to 10 GiB; very large repos can fail to push.
- **Issues, pull requests, wikis, releases and settings** are not copied — only git history (branches/tags/commits).
- Don't commit or push to the mirrored GitLab projects by hand; the next run overwrites them.
- A GitLab token with the `api` scope has full access to that account — never share `.env` (it is gitignored).

## Files

```
mirror.mjs                       # the script (no dependencies, Node 18+)
.env.example                     # configuration template
run-mirror.cmd                   # wrapper for Windows Task Scheduler
.github/workflows/mirror.yml     # scheduled run on GitHub Actions
.github/workflows/keepalive.yml  # weekly commit that keeps the schedule enabled
.mirrors/                        # local bare-clone cache (gitignored)
```
