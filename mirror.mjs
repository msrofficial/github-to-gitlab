#!/usr/bin/env node
/**
 * github-to-gitlab
 * ------------------------------------------------------------------
 * Mirrors EVERY repository of a GitHub account (personal + orgs, private
 * included) into GitLab, as a full git mirror (all branches + tags).
 *
 * Runs are incremental and idempotent:
 *   - repos that already exist on GitLab are updated, not duplicated
 *   - repos created on GitHub after the last run are picked up automatically
 *   - new commits / branches / tags / force-pushes are synced on the next run
 *
 * No dependencies: plain Node.js (>= 18) + git.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MARKER = 'github-mirror:';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const CONFIG = {
  ghHost: process.env.GH_HOST || 'github.com',
  glHost: process.env.GL_HOST || 'gitlab.com',
  ghToken: (process.env.GH_TOKEN || '').trim(),
  glToken: (process.env.GL_TOKEN || '').trim(),
  namespace: (process.env.GL_NAMESPACE || '').trim(),
  mirrorDir: path.resolve(process.env.MIRROR_DIR || '.mirrors'),
  concurrency: Math.max(1, Math.min(8, Number(process.env.CONCURRENCY) || 3)),
  // Without a timeout a stalled API connection keeps a run alive for hours
  // (the runner only stops it at the job timeout).
  requestTimeoutMs: Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS) || 60000),
  includeForks: bool(process.env.INCLUDE_FORKS, false),
  includeArchived: bool(process.env.INCLUDE_ARCHIVED, true),
  onlyMatch: process.env.ONLY_MATCH || '',
  // mirror = follow the GitHub repo (public -> public, private -> private)
  visibility: (process.env.GL_VISIBILITY || 'mirror').trim().toLowerCase(),
  unprotect: bool(process.env.GL_UNPROTECT, true),
  dryRun: bool(process.env.DRY_RUN, false),
  // Replaces repository names in all output with short hashes. Use it when the
  // workflow runs in a public repo, where logs are readable by anyone.
  hideNames: bool(process.env.HIDE_NAMES, false),
};

const GH_API =
  CONFIG.ghHost === 'github.com' ? 'https://api.github.com' : `https://${CONFIG.ghHost}/api/v3`;
const GL_API = `https://${CONFIG.glHost}/api/v4`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redact(text) {
  let out = String(text ?? '');
  for (const token of [CONFIG.ghToken, CONFIG.glToken]) {
    if (token && token.length > 3) out = out.split(token).join('***');
  }
  return out;
}

class Fatal extends Error {}

// Thrown instead of process.exit(): exiting while fetch sockets are closing
// trips a libuv assertion on Windows.
function die(message) {
  throw new Fatal(message);
}

function hash8(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function label(repo) {
  return CONFIG.hideNames ? `repo#${hash8(repo.full_name)}` : repo.full_name;
}

function projectLabel(pathWithNamespace) {
  return CONFIG.hideNames ? `project#${hash8(pathWithNamespace)}` : pathWithNamespace;
}

function scrub(message, repo, project) {
  const out = String(message ?? '');
  if (!CONFIG.hideNames) return out;
  let cleaned = out;
  for (const needle of [repo && repo.full_name, project && project.path_with_namespace]) {
    if (needle && needle.length > 1) cleaned = cleaned.split(needle).join('***');
  }
  return cleaned;
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0] || 'unknown git error';
}

function slug(value) {
  const out = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 200);
  return out || 'repo';
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function pool(items, limit, worker) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// HTTP with retry on rate limits / 5xx
// ---------------------------------------------------------------------------

async function request(url, init, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(CONFIG.requestTimeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await sleep(1200 * (attempt + 1));
      continue;
    }
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (retryable && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    return res;
  }
  throw new Error(`${label}: ${lastError ? lastError.message : 'request failed'}`);
}

async function ghGet(pathname) {
  const res = await request(
    `${GH_API}${pathname}`,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-to-gitlab',
      },
    },
    `GitHub GET ${pathname}`
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub GET ${pathname} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function glApi(method, pathname, body, { allow404 = false } = {}) {
  const headers = { 'PRIVATE-TOKEN': CONFIG.glToken, 'User-Agent': 'github-to-gitlab' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await request(
    `${GL_API}${pathname}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined },
    `GitLab ${method} ${pathname}`
  );
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitLab ${method} ${pathname} -> ${res.status} ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitEnv(username, token) {
  const basic = Buffer.from(`${username}:${token}`, 'utf8').toString('base64');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    // Pass credentials as an HTTP header so tokens never appear in URLs,
    // process arguments, or git's error messages.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function git(args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < 65536) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 65536) stderr += d;
    });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout: redact(stdout), stderr: redact(stderr) }));
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function listGithubRepos() {
  const repos = [];
  const seen = new Set();

  for (let page = 1; page <= 100; page++) {
    const batch = await ghGet(
      `/user/repos?per_page=100&page=${page}&affiliation=owner,organization_member&sort=full_name`
    );
    for (const repo of batch) {
      if (seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      repos.push(repo);
    }
    if (batch.length < 100) break;
  }

  return repos
    .filter((repo) => (repo.fork ? CONFIG.includeForks : true))
    .filter((repo) => (repo.archived ? CONFIG.includeArchived : true))
    .filter((repo) =>
      CONFIG.onlyMatch ? new RegExp(CONFIG.onlyMatch, 'i').test(repo.full_name) : true
    )
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

// ---------------------------------------------------------------------------
// GitLab namespace / projects
// ---------------------------------------------------------------------------

async function resolveNamespace(me) {
  const wanted = CONFIG.namespace || me.username;
  const tail = wanted.split('/').pop();

  const candidates = await glApi('GET', `/namespaces?search=${encodeURIComponent(tail)}&per_page=100`);
  const hit = candidates.find((n) => n.full_path.toLowerCase() === wanted.toLowerCase());
  if (hit) return { id: hit.id, full_path: hit.full_path, kind: hit.kind };

  // Fallback: the user's own personal namespace (created without namespace_id).
  if (wanted.toLowerCase() === me.username.toLowerCase()) {
    return { id: null, full_path: me.username, kind: 'user' };
  }
  die(`GitLab namespace "${wanted}" was not found or is not visible to this token.`);
}

async function listNamespaceProjects(ns, me) {
  const projects = new Map();
  const wantedNs = ns.full_path.toLowerCase();

  for (let page = 1; page <= 100; page++) {
    if (ns.id) {
      const batch = await glApi(
        'GET',
        `/projects?namespace_id=${ns.id}&per_page=100&page=${page}&order_by=path`
      );
      for (const project of batch) projects.set(project.path.toLowerCase(), project);
      if (batch.length < 100) break;
      continue;
    }

    // `/users/:id/projects` is the public profile listing and hides private
    // projects, which made every private mirror look missing. Page through the
    // authenticated user's own projects instead, then keep the namespace.
    const batch = await glApi('GET', `/projects?owned=true&per_page=100&page=${page}`);
    for (const project of batch) {
      const projectNs = String((project.namespace && project.namespace.full_path) || '').toLowerCase();
      if (projectNs === wantedNs) projects.set(project.path.toLowerCase(), project);
    }
    if (batch.length < 100) break;
  }

  return projects;
}

function markerOf(project) {
  const match = String(project.description || '').match(/github-mirror:(\S+)/);
  return match ? match[1].toLowerCase() : null;
}

function desiredVisibility(repo) {
  if (CONFIG.visibility === 'mirror') return repo.visibility === 'public' ? 'public' : 'private';
  return CONFIG.visibility;
}

// Keeps an already-mirrored project in step with the source repo's visibility.
async function applyVisibility(project, repo) {
  const want = desiredVisibility(repo);
  if (CONFIG.dryRun || project.visibility === want) return project;
  try {
    const updated = await glApi('PUT', `/projects/${project.id}`, { visibility: want });
    console.log(
      `  [vis ] ${projectLabel(project.path_with_namespace)} -> ${want}`
    );
    return updated;
  } catch (error) {
    console.log(
      `  [warn] ${projectLabel(project.path_with_namespace)}: visibility unchanged (${scrub(error.message, repo, project)})`
    );
    return project;
  }
}

async function ensureProject(repo, ns, projects) {
  const wanted = repo.full_name.toLowerCase();

  for (const project of projects.values()) {
    if (markerOf(project) === wanted) {
      return { project: await applyVisibility(project, repo), created: false };
    }
  }

  let targetPath = slug(repo.name);
  let existing = projects.get(targetPath.toLowerCase());

  if (existing) {
    const owner = markerOf(existing);
    if (owner && owner !== wanted) {
      // Another GitHub repo already owns this path: disambiguate by owner.
      targetPath = `${slug(repo.name)}-${slug(repo.owner.login)}`;
      existing = projects.get(targetPath.toLowerCase());
      if (existing) {
        if (markerOf(existing) !== wanted) {
          throw new Error(`GitLab path "${targetPath}" is already taken by another project`);
        }
        return { project: await applyVisibility(existing, repo), created: false };
      }
    } else if (!owner && !existing.empty_repo) {
      throw new Error(
        `GitLab project "${existing.path_with_namespace}" already exists and is not empty; refusing to overwrite it`
      );
    }
  }

  const body = {
    name: repo.name,
    path: targetPath,
    visibility: desiredVisibility(repo),
    description: `${MARKER}${repo.full_name}`,
    initialize_with_readme: false,
  };
  if (ns.id) body.namespace_id = ns.id;

  if (CONFIG.dryRun) return { project: null, created: true, plannedPath: targetPath };

  let project;
  if (existing) {
    project = await glApi('PUT', `/projects/${existing.id}`, {
      description: body.description,
      visibility: body.visibility,
    });
  } else {
    try {
      project = await glApi('POST', '/projects', body);
    } catch (error) {
      // Safety net: if the path is taken but the project was invisible in the
      // listing, adopt it when it carries our marker for this repo.
      if (!/has already been taken|already exists/i.test(error.message)) throw error;
      const adopted = await glApi(
        'GET',
        `/projects/${encodeURIComponent(`${ns.full_path}/${targetPath}`)}`,
        null,
        { allow404: true }
      );
      if (!adopted || markerOf(adopted) !== wanted) throw error;
      project = adopted;
    }
  }
  projects.set(project.path.toLowerCase(), project);

  if (CONFIG.unprotect) await removeBranchProtection(project);
  return { project, created: !existing };
}

async function removeBranchProtection(project) {
  try {
    const branches = await glApi(
      'GET',
      `/projects/${project.id}/protected_branches?per_page=100`,
      null,
      { allow404: true }
    );
    if (!branches) return 0;
    for (const branch of branches) {
      await glApi(
        'DELETE',
        `/projects/${project.id}/protected_branches/${encodeURIComponent(branch.name)}`
      );
    }
    return branches.length;
  } catch {
    return 0; // not fatal: only needed when upstream rewrites history
  }
}

// ---------------------------------------------------------------------------
// Mirror one repository
// ---------------------------------------------------------------------------

async function mirrorRepo(repo, project) {
  const dir = path.join(CONFIG.mirrorDir, `${slug(repo.owner.login)}--${slug(repo.name)}.git`);
  const ghUrl = `https://${CONFIG.ghHost}/${repo.full_name}.git`;
  const glUrl = `https://${CONFIG.glHost}/${project.path_with_namespace}.git`;
  const ghEnv = gitEnv('x-access-token', CONFIG.ghToken);
  const glEnv = gitEnv('oauth2', CONFIG.glToken);

  await mkdir(CONFIG.mirrorDir, { recursive: true });

  if (await exists(path.join(dir, 'HEAD'))) {
    await git(['-C', dir, 'remote', 'set-url', 'origin', ghUrl]);
    const fetched = await git(['-C', dir, 'fetch', '--prune', '--quiet', 'origin'], ghEnv);
    if (fetched.code !== 0) throw new Error(`fetch: ${firstLine(fetched.stderr)}`);
  } else {
    const cloned = await git(['clone', '--mirror', '--quiet', ghUrl, dir], ghEnv);
    if (cloned.code !== 0) throw new Error(`clone: ${firstLine(cloned.stderr)}`);
  }

  let pushed = await git(['-C', dir, 'push', '--mirror', '--quiet', glUrl], glEnv);

  if (pushed.code !== 0 && CONFIG.unprotect && /protected branch|force.?push|pre-receive|denied/i.test(pushed.stderr)) {
    await removeBranchProtection(project);
    pushed = await git(['-C', dir, 'push', '--mirror', '--quiet', glUrl], glEnv);
  }

  if (pushed.code !== 0) throw new Error(`push: ${firstLine(pushed.stderr)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function assertConfig() {
  if (!CONFIG.ghToken) die('GH_TOKEN is missing (GitHub personal access token with "repo" scope).');
  if (!CONFIG.glToken) die('GL_TOKEN is missing (GitLab token with "api" scope).');
  if (CONFIG.onlyMatch) {
    try {
      new RegExp(CONFIG.onlyMatch);
    } catch {
      die(`ONLY_MATCH is not a valid regular expression: ${CONFIG.onlyMatch}`);
    }
  }
  if (!['mirror', 'private', 'public', 'internal'].includes(CONFIG.visibility)) {
    die(`GL_VISIBILITY must be mirror, private, public or internal (got "${CONFIG.visibility}").`);
  }
}

async function main() {
  assertConfig();
  const startedAt = Date.now();

  console.log('github-to-gitlab');
  console.log(`  GitHub    : ${CONFIG.ghHost}`);
  console.log(`  GitLab    : ${CONFIG.glHost}`);
  console.log(`  Namespace : ${CONFIG.namespace || '(personal namespace of the token owner)'}`);
  console.log(`  Cache dir : ${CONFIG.mirrorDir}`);
  console.log(
    `  Visibility: ${CONFIG.visibility === 'mirror' ? 'same as GitHub' : CONFIG.visibility}`
  );
  if (CONFIG.dryRun) console.log('  Mode      : DRY RUN (no changes are made)');

  const me = await glApi('GET', '/user');
  const ns = await resolveNamespace(me);
  console.log(
    `  Target    : ${CONFIG.hideNames ? `namespace#${hash8(ns.full_path)}` : ns.full_path} (${ns.kind})\n`
  );

  const repos = await listGithubRepos();
  console.log(`${repos.length} GitHub repositor${repos.length === 1 ? 'y' : 'ies'} to mirror\n`);
  if (repos.length === 0) return;

  const projects = await listNamespaceProjects(ns, me);
  console.log(`  Found     : ${projects.size} existing project(s) in the namespace\n`);

  const plan = [];
  for (const repo of repos) {
    try {
      const { project, created, plannedPath } = await ensureProject(repo, ns, projects);
      if (!project && plannedPath) {
        console.log(
          `  [plan] ${label(repo)} -> ${projectLabel(`${ns.full_path}/${plannedPath}`)} (new)`
        );
      } else if (created) {
        console.log(`  [new ] ${label(repo)} -> ${projectLabel(project.path_with_namespace)}`);
      }
      plan.push({ repo, project, created });
    } catch (error) {
      const message = scrub(error.message, repo, null);
      console.log(`  [FAIL] ${label(repo)}: ${message}`);
      plan.push({ repo, project: null, created: false, error: message });
    }
  }

  const results = await pool(plan, CONFIG.concurrency, async (item) => {
    if (!item.project) {
      return { status: item.error ? 'fail' : 'skipped' };
    }
    try {
      await mirrorRepo(item.repo, item.project);
      if (!item.created) console.log(`  [ synced] ${label(item.repo)}`);
      return { status: 'ok' };
    } catch (error) {
      console.log(
        `  [FAIL] ${label(item.repo)}: ${scrub(error.message, item.repo, item.project)}`
      );
      return { status: 'fail' };
    }
  });

  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `\nDone in ${seconds}s - ${ok} mirrored, ${failed} failed, ${skipped} skipped` +
      (CONFIG.dryRun ? ' (dry run)' : '')
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAIL ${redact(error.message)}\n`);
  process.exitCode = 1;
});
