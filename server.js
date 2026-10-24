"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = __dirname;
const PUBLIC_DIR = path.resolve(ROOT, "public");
const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 80;
const cache = new Map();
const githubToken = process.env.GITHUB_TOKEN || "";
const allowedLanguages = new Set([
  "JavaScript", "TypeScript", "Python", "Java", "Go", "Rust",
  "HTML", "CSS", "C++", "C#", "Ruby", "PHP"
]);
const beginnerLabels = new Set([
  "good first issue", "good-first-issue", "beginner",
  "beginner-friendly", "first-timers-only", "first timers only", "easy"
]);
const helpLabels = new Set(["help wanted", "help-wanted"]);
const ignoredLabels = new Set(["wontfix", "won't fix", "duplicate", "invalid", "stale"]);
const claimPattern = /\b(i am|i'm|i will|i'll|i can|let me)\s+(?:take|work on|pick up|claim|handle)\s+(?:this|it|issue)\b|\b(?:i am|i'm)\s+(?:currently\s+)?working on\s+(?:this|it|issue)\b|\bassigned to @?[a-z0-9-]+\b|\bi have claimed\b/i;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function cleanText(value, maxLength = 220) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\u0060*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseSkills(value) {
  return String(value || "")
    .split(",")
    .map((skill) => skill.trim().toLowerCase())
    .filter((skill) => skill.length > 1)
    .slice(0, 8);
}

function clampNumber(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function githubGet(urlString) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Open-Source-Contribution-Finder",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (githubToken) headers.Authorization = "Bearer " + githubToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(urlString, { headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || "GitHub returned an error.");
      error.status = response.status;
      error.rateLimitReset = response.headers.get("x-ratelimit-reset");
      throw error;
    }
    return { body, headers: response.headers };
  } finally {
    clearTimeout(timeout);
  }
}

function buildIssueSearchUrl(query) {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "40");
  url.searchParams.set("page", "1");
  return url.toString();
}

async function searchIssues(query) {
  const hit = cacheGet(query);
  if (hit) return hit;
  const result = await githubGet(buildIssueSearchUrl(query));
  const payload = {
    items: Array.isArray(result.body.items) ? result.body.items : [],
    remaining: result.headers.get("x-ratelimit-remaining")
  };
  cacheSet(query, payload);
  return payload;
}

function latestCommentsUrl(issue) {
  const url = new URL(issue.comments_url);
  const perPage = 20;
  const page = Math.max(1, Math.ceil(Number(issue.comments || 0) / perPage));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  return url.toString();
}

async function checkClaimComments(issue) {
  if (!Number(issue.comments || 0)) return "checked";
  if (!issue.comments_url) return "needs-check";
  try {
    const result = await githubGet(latestCommentsUrl(issue));
    const comments = Array.isArray(result.body) ? result.body : [];
    return comments.some((comment) => claimPattern.test(comment.body || ""))
      ? "possible-claim"
      : "checked";
  } catch (_error) {
    return "needs-check";
  }
}

async function mapWithLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function getLabels(issue) {
  return Array.isArray(issue.labels)
    ? issue.labels.map((label) => String(label.name || "").toLowerCase())
    : [];
}

function isBeginnerIssue(issue) {
  return getLabels(issue).some((label) => beginnerLabels.has(label));
}

function hasHelpLabel(issue) {
  return getLabels(issue).some((label) => helpLabels.has(label));
}

function hasIgnoredLabel(issue) {
  return getLabels(issue).some((label) => ignoredLabels.has(label));
}

function getSkillMatches(issue, skills) {
  if (!skills.length) return [];
  const text = [
    issue.title || "",
    issue.body || "",
    (issue.labels || []).map((label) => label.name || "").join(" ")
  ].join(" ").toLowerCase();
  return skills.filter((skill) => text.includes(skill));
}

function toCandidate(issue, skills, claimCheck) {
  const beginner = isBeginnerIssue(issue);
  const helpWanted = hasHelpLabel(issue);
  const skillMatches = getSkillMatches(issue, skills);
  const updatedAt = Date.parse(issue.updated_at || issue.created_at || "");
  const ageDays = Number.isFinite(updatedAt)
    ? Math.max(0, Math.floor((Date.now() - updatedAt) / 86400000))
    : null;
  const body = String(issue.body || "");
  const reasons = [];
  let score = 48;

  if (beginner) {
    reasons.push("Beginner-friendly label");
    score += 22;
  } else if (helpWanted) {
    reasons.push("Maintainer marked it help wanted");
    score += 12;
  }
  if (skillMatches.length) {
    reasons.push("Mentions " + skillMatches.slice(0, 3).join(", "));
    score += Math.min(18, skillMatches.length * 7);
  }
  if (ageDays !== null && ageDays <= 14) {
    reasons.push("Updated in the last 2 weeks");
    score += 9;
  } else if (ageDays !== null && ageDays <= 60) {
    reasons.push("Recently updated");
    score += 5;
  }
  if (body.trim().length >= 180) {
    reasons.push("Includes task context");
    score += 6;
  }
  if (claimCheck === "checked") {
    reasons.push("No claim found in recent comments");
    score += 4;
  }

  return {
    id: issue.id,
    number: issue.number,
    title: issue.title || "Untitled issue",
    url: issue.html_url,
    repo: (issue.repository_url || "").replace("https://api.github.com/repos/", ""),
    author: issue.user && issue.user.login ? issue.user.login : "GitHub contributor",
    avatar: issue.user && issue.user.avatar_url ? issue.user.avatar_url : "",
    bodyPreview: cleanText(body, 230) || "The maintainer has not added a description yet.",
    labels: (issue.labels || []).map((label) => ({
      name: label.name || "",
      color: /^[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "8fa69a"
    })),
    comments: Number(issue.comments || 0),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    ageDays,
    beginner,
    helpWanted,
    skillMatches,
    score: Math.min(99, score),
    reasons,
    claimCheck,
    assignees: Array.isArray(issue.assignees) ? issue.assignees.length : (issue.assignee ? 1 : 0)
  };
}

async function handleIssueSearch(requestUrl, response) {
  const languageRaw = (requestUrl.searchParams.get("language") || "").trim();
  const language = allowedLanguages.has(languageRaw) ? languageRaw : "";
  const levelRaw = requestUrl.searchParams.get("level") || "beginner";
  const level = ["beginner", "intermediate", "any"].includes(levelRaw) ? levelRaw : "beginner";
  const freshDays = clampNumber(requestUrl.searchParams.get("freshDays"), 90, 7, 365);
  const skills = parseSkills(requestUrl.searchParams.get("skills"));
  const limit = clampNumber(requestUrl.searchParams.get("limit"), 24, 5, 40);
  const cutoff = new Date(Date.now() - freshDays * 86400000).toISOString().slice(0, 10);
  const common = ["is:issue", "is:open", "no:assignee", "updated:>=" + cutoff];
  if (language) common.push("language:" + language);

  let labelQueries;
  if (level === "beginner") {
    labelQueries = ['label:"good first issue"', "label:good-first-issue"];
  } else if (level === "intermediate") {
    labelQueries = ['label:"help wanted"'];
  } else {
    labelQueries = ['label:"good first issue"', 'label:"help wanted"'];
  }
  const queries = labelQueries.map((label) => common.concat(label).join(" "));
  const resultKey = JSON.stringify({ queries, freshDays, skills, limit });
  const cachedResult = cacheGet("result:" + resultKey);
  if (cachedResult) {
    sendJson(response, 200, { ...cachedResult, meta: { ...cachedResult.meta, cached: true } });
    return;
  }

  try {
    const batches = await Promise.all(queries.map((query) => searchIssues(query)));
    const combined = new Map();
    for (const batch of batches) {
      for (const issue of batch.items) {
        if (!issue || issue.pull_request || issue.state !== "open") continue;
        const assigneeCount = Array.isArray(issue.assignees)
          ? issue.assignees.length
          : (issue.assignee ? 1 : 0);
        if (assigneeCount > 0 || hasIgnoredLabel(issue)) continue;
        if (claimPattern.test(issue.body || "")) continue;
        combined.set(issue.id, issue);
      }
    }

    const initial = Array.from(combined.values())
      .map((issue) => {
        const updated = Date.parse(issue.updated_at || "");
        const ageDays = Number.isFinite(updated)
          ? Math.max(0, Math.floor((Date.now() - updated) / 86400000))
          : freshDays + 1;
        return { issue, ageDays };
      })
      .filter((entry) => entry.ageDays <= freshDays)
      .sort((left, right) => {
        const leftScore = (isBeginnerIssue(left.issue) ? 22 : 0)
          + (getSkillMatches(left.issue, skills).length * 7)
          + (left.ageDays <= 14 ? 9 : left.ageDays <= 60 ? 5 : 0);
        const rightScore = (isBeginnerIssue(right.issue) ? 22 : 0)
          + (getSkillMatches(right.issue, skills).length * 7)
          + (right.ageDays <= 14 ? 9 : right.ageDays <= 60 ? 5 : 0);
        return rightScore - leftScore;
      })
      .slice(0, 28);

    const commentCandidates = initial
      .filter((entry) => Number(entry.issue.comments || 0) > 0)
      .slice(0, 10)
      .map((entry) => entry.issue);
    const checked = await mapWithLimit(commentCandidates, 4, async (issue) => ({
      id: issue.id,
      status: await checkClaimComments(issue)
    }));
    const commentStatus = new Map(checked.map((entry) => [entry.id, entry.status]));
    const hiddenClaimed = initial.filter((entry) => commentStatus.get(entry.issue.id) === "possible-claim").length;
    const candidates = initial
      .filter((entry) => commentStatus.get(entry.issue.id) !== "possible-claim")
      .map((entry) => {
        const status = Number(entry.issue.comments || 0) === 0
          ? "checked"
          : (commentStatus.get(entry.issue.id) || "needs-check");
        return toCandidate(entry.issue, skills, status);
      })
      .sort((left, right) => right.score - left.score || (left.ageDays || 0) - (right.ageDays || 0))
      .slice(0, limit);
    const rateRemaining = batches
      .map((batch) => Number(batch.remaining))
      .filter(Number.isFinite)
      .reduce((lowest, current) => Math.min(lowest, current), Infinity);
    const payload = {
      issues: candidates,
      meta: {
        total: candidates.length,
        hiddenClaimed,
        checkedForClaims: commentStatus.size,
        cached: false,
        rateLimitRemaining: Number.isFinite(rateRemaining) ? rateRemaining : null,
        message: "Open and unassigned status comes from GitHub. Recent comments are checked for obvious claims when available; always confirm on the issue page before starting."
      }
    };
    cacheSet("result:" + resultKey, payload);
    sendJson(response, 200, payload);
  } catch (error) {
    const rateLimited = error.status === 403 || error.status === 429;
    const message = rateLimited
      ? "GitHub is rate-limiting issue searches. Wait a little and try again, or configure a GitHub token on the server."
      : "Could not load GitHub issues right now. Check your connection and try again.";
    sendJson(response, rateLimited ? 429 : 502, {
      error: message,
      detail: !rateLimited && error.status ? error.message : undefined,
      retryAt: error.rateLimitReset || null
    });
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}

function serveStatic(requestUrl, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch (_error) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(PUBLIC_DIR, "." + pathname);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Page not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    response.end(contents);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "issue-finder-api" });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/issues") {
    handleIssueSearch(requestUrl, response);
    return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET requests are supported." });
    return;
  }
  serveStatic(requestUrl, response);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Open Source Contribution Finder running at http://localhost:" + PORT);
  console.log(githubToken ? "GitHub API token detected on server." : "Using public GitHub API access.");
});
