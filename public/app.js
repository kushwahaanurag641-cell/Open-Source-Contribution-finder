"use strict";

const form = document.getElementById("search-form");
const list = document.getElementById("issue-list");
const statusMessage = document.getElementById("status-message");
const resultCount = document.getElementById("result-count");
const searchButton = document.getElementById("search-button");
const sortOrder = document.getElementById("sort-order");
const savedToggle = document.getElementById("saved-toggle");
const skillsField = document.getElementById("skills");
const skillsHint = document.getElementById("skills-hint");
const savedKey = "patchwork.savedIssues.v1";

let currentIssues = [];
let isSavedView = false;
let browserSearchCache = new Map();

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSavedIssues() {
  try {
    const value = JSON.parse(localStorage.getItem(savedKey) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_error) {
    return [];
  }
}

function saveIssues(issues) {
  localStorage.setItem(savedKey, JSON.stringify(issues.slice(0, 50)));
}

function updateSavedToggle() {
  const count = getSavedIssues().length;
  savedToggle.setAttribute("aria-pressed", String(isSavedView));
  savedToggle.innerHTML = (isSavedView ? '<span aria-hidden="true">←</span> All issues' : '<span aria-hidden="true">♡</span> Saved')
    + ' <span id="saved-count" class="saved-count">' + count + "</span>";
}

function relativeDate(dateString) {
  const timestamp = Date.parse(dateString || "");
  if (!Number.isFinite(timestamp)) return "Date unavailable";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  if (days === 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 30) return "Updated " + days + " days ago";
  const months = Math.floor(days / 30);
  if (months < 12) return "Updated " + months + (months === 1 ? " month ago" : " months ago");
  const years = Math.floor(months / 12);
  return "Updated " + years + (years === 1 ? " year ago" : " years ago");
}

function repoInitial(repo) {
  const lastPart = String(repo || "").split("/").pop() || "G";
  return escapeHtml(lastPart.slice(0, 1).toUpperCase());
}

function safeGithubUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" ? parsed.href : "https://github.com/";
  } catch (_error) {
    return "https://github.com/";
  }
}

function renderLabels(labels) {
  return (labels || []).slice(0, 3).map((label) => {
    const name = escapeHtml(label.name);
    const color = /^[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "8fa69a";
    return '<span class="issue-label"><span class="label-dot" style="background:#' + escapeHtml(color) + '"></span>' + name + "</span>";
  }).join("");
}

function renderReasons(issue) {
  const reasons = Array.isArray(issue.reasons) ? issue.reasons.slice(0, 3) : [];
  const details = reasons.length
    ? reasons.map((reason) => "<span>" + escapeHtml(reason) + "</span>").join('<span class="reason-separator" aria-hidden="true">·</span>')
    : "<span>Open issue selected for your search</span>";
  return '<div class="fit-row"><span class="fit-label">Why it may fit</span><span class="fit-explanation">' + details + "</span></div>";
}

function issueCard(issue) {
  const saved = getSavedIssues().some((item) => String(item.id) === String(issue.id));
  const safeUrl = safeGithubUrl(issue.url);
  const comments = Number(issue.comments || 0);
  const checkClass = issue.claimCheck === "needs-check"
    ? "meta-check unchecked"
    : comments === 0 ? "meta-check neutral" : "meta-check";
  const checkText = issue.claimCheck === "needs-check"
    ? "Check comments before claiming"
    : comments > 0 ? "No claim found in recent comments" : "No comments yet";
  return [
    '<article class="issue-card">',
      '<div class="issue-meta-top">',
        '<div class="repo-line"><span class="repo-glyph">' + repoInitial(issue.repo) + '</span><span class="repo-name">' + escapeHtml(issue.repo || "Open-source repository") + '</span></div>',
        '<span class="issue-number">#' + escapeHtml(issue.number) + '</span>',
      '</div>',
      '<div class="issue-title-row">',
        '<h3 class="issue-title"><a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(issue.title) + '</a></h3>',
        '<button class="save-button' + (saved ? " saved" : "") + '" type="button" data-save-id="' + escapeHtml(issue.id) + '" aria-label="' + (saved ? "Remove saved issue" : "Save issue") + '" title="' + (saved ? "Remove from saved issues" : "Save issue") + '">' + (saved ? "♥" : "♡") + '</button>',
      '</div>',
      '<p class="issue-description">' + escapeHtml(issue.bodyPreview || "No description provided.") + '</p>',
      '<div class="label-row">' + renderLabels(issue.labels) + '</div>',
      renderReasons(issue),
      '<div class="issue-bottom">',
        '<div class="freshness-meta"><span>' + escapeHtml(relativeDate(issue.updatedAt)) + '</span><span class="' + checkClass + '">' + escapeHtml(checkText) + '</span></div>',
        '<div class="issue-actions"><a class="open-issue" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noreferrer">Open on GitHub <span aria-hidden="true">↗</span></a></div>',
      '</div>',
    '</article>'
  ].join("");
}

function renderEmpty(title, description) {
  list.innerHTML = '<div class="empty-state"><div class="empty-icon" aria-hidden="true">⌕</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(description) + "</p></div>";
}

function showStatus(message, visible) {
  statusMessage.textContent = message || "";
  statusMessage.classList.toggle("visible", Boolean(visible && message));
}

function currentFilters() {
  const params = new URLSearchParams();
  params.set("language", document.getElementById("language").value);
  params.set("skills", document.getElementById("skills").value.trim());
  params.set("level", document.getElementById("level").value);
  params.set("freshDays", document.getElementById("fresh-days").value);
  params.set("limit", "24");
  return params;
}

function sortedIssues(issues) {
  const copy = issues.slice();
  if (sortOrder.value === "fresh") {
    copy.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
  } else {
    copy.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }
  return copy;
}

function drawResults() {
  let issues = currentIssues;
  if (isSavedView) {
    const saved = getSavedIssues();
    const savedIds = new Set(saved.map((issue) => String(issue.id)));
    const visible = currentIssues.filter((issue) => savedIds.has(String(issue.id)));
    issues = visible.length ? visible : saved;
  }
  issues = sortedIssues(issues);
  resultCount.textContent = issues.length ? "— " + issues.length + " found" : "";
  updateSavedToggle();
  if (!issues.length) {
    renderEmpty(
      isSavedView ? "No saved issues yet" : "No close matches just yet",
      isSavedView ? "Tap the heart on an issue to keep it here for later." : "Try Any language, add a skill you know, or open Advanced filters to see a wider range."
    );
    return;
  }
  list.innerHTML = issues.map(issueCard).join("");
}

function showLoading() {
  list.innerHTML = [
    '<div class="loading-card" aria-hidden="true"><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div></div>',
    '<div class="loading-card" aria-hidden="true"><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div></div>',
    '<div class="loading-card" aria-hidden="true"><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div><div class="loading-line"></div></div>'
  ].join("");
}

function publicSearchQuery(filters, label) {
  const freshDays = Number(filters.get("freshDays")) || 90;
  const cutoff = new Date(Date.now() - freshDays * 86400000).toISOString().slice(0, 10);
  const parts = ["is:issue", "is:open", "no:assignee", "updated:>=" + cutoff];
  const language = filters.get("language");
  if (language) parts.push("language:" + language);
  parts.push(label);
  return parts.join(" ");
}

function cleanIssueBody(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\u0060*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function issueFromPublicApi(issue, skills) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const labelNames = labels.map((label) => String(label.name || "").toLowerCase());
  const beginner = labelNames.some((name) => [
    "good first issue", "good-first-issue", "beginner", "beginner-friendly", "first-timers-only", "first timers only", "easy"
  ].includes(name));
  const helpWanted = labelNames.includes("help wanted") || labelNames.includes("help-wanted");
  const issueText = [issue.title || "", issue.body || "", labelNames.join(" ")].join(" ").toLowerCase();
  const skillMatches = skills.filter((skill) => issueText.includes(skill));
  const updatedAt = issue.updated_at || issue.created_at || "";
  const updatedTime = Date.parse(updatedAt);
  const ageDays = Number.isFinite(updatedTime) ? Math.max(0, Math.floor((Date.now() - updatedTime) / 86400000)) : null;
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

  const comments = Number(issue.comments || 0);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title || "Untitled issue",
    url: issue.html_url,
    repo: String(issue.repository_url || "").replace("https://api.github.com/repos/", ""),
    author: issue.user && issue.user.login ? issue.user.login : "GitHub contributor",
    avatar: issue.user && issue.user.avatar_url ? issue.user.avatar_url : "",
    bodyPreview: cleanIssueBody(body).slice(0, 230) || "The maintainer has not added a description yet.",
    labels: labels.map((label) => ({
      name: label.name || "",
      color: /^[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "8fa69a"
    })),
    comments,
    createdAt: issue.created_at,
    updatedAt,
    ageDays,
    beginner,
    helpWanted,
    skillMatches,
    score: Math.min(99, score),
    reasons,
    claimCheck: comments === 0 ? "checked" : "needs-check",
    assignees: Array.isArray(issue.assignees) ? issue.assignees.length : (issue.assignee ? 1 : 0)
  };
}

async function searchGitHubDirectly(filters) {
  const freshDays = Number(filters.get("freshDays")) || 90;
  const level = filters.get("level") || "beginner";
  const skills = (filters.get("skills") || "")
    .split(",").map((skill) => skill.trim().toLowerCase()).filter((skill) => skill.length > 1).slice(0, 8);
  const limit = Math.min(40, Math.max(5, Number(filters.get("limit")) || 24));
  const labels = level === "intermediate"
    ? ['label:"help wanted"']
    : level === "any"
      ? ['label:"good first issue"', 'label:"help wanted"']
      : ['label:"good first issue"', "label:good-first-issue"];
  const queries = labels.map((label) => publicSearchQuery(filters, label));
  const cacheKey = JSON.stringify({ queries, limit, skills });
  const cached = browserSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const batches = await Promise.all(queries.map(async (query) => {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", "40");
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error("GitHub is limiting public searches right now. Please wait a minute and try again.");
      }
      throw new Error(payload.message || "GitHub could not return issues right now.");
    }
    return Array.isArray(payload.items) ? payload.items : [];
  }));

  const ignoredLabels = new Set(["wontfix", "won't fix", "duplicate", "invalid", "stale"]);
  const claimPattern = /\b(i am|i'm|i will|i'll|i can|let me)\s+(?:take|work on|pick up|claim|handle)\s+(?:this|it|issue)\b|\b(?:i am|i'm)\s+(?:currently\s+)?working on\s+(?:this|it|issue)\b|\bassigned to @?[a-z0-9-]+\b|\bi have claimed\b/i;
  const unique = new Map();
  for (const issue of batches.flat()) {
    if (!issue || issue.pull_request || issue.state !== "open") continue;
    const assignees = Array.isArray(issue.assignees) ? issue.assignees.length : (issue.assignee ? 1 : 0);
    const labelsForIssue = Array.isArray(issue.labels) ? issue.labels.map((label) => String(label.name || "").toLowerCase()) : [];
    if (assignees || labelsForIssue.some((label) => ignoredLabels.has(label)) || claimPattern.test(issue.body || "")) continue;
    unique.set(issue.id, issue);
  }

  const candidates = Array.from(unique.values())
    .map((issue) => issueFromPublicApi(issue, skills))
    .filter((issue) => issue.ageDays === null || issue.ageDays <= freshDays)
    .sort((left, right) => right.score - left.score || (left.ageDays || 0) - (right.ageDays || 0))
    .slice(0, limit);
  const result = {
    issues: candidates,
    meta: {
      total: candidates.length,
      hiddenClaimed: 0,
      checkedForClaims: 0,
      publicApi: true,
      message: "Searches use GitHub's public API. Issues with comments still need a final check on GitHub before starting."
    }
  };
  browserSearchCache.set(cacheKey, { payload: result, expiresAt: Date.now() + 5 * 60 * 1000 });
  return result;
}

async function loadIssues() {
  isSavedView = false;
  updateSavedToggle();
  showStatus("", false);
  searchButton.disabled = true;
  searchButton.querySelector("span:first-child").textContent = "Finding beginner issues…";
  showLoading();
  resultCount.textContent = "";
  try {
    const filters = currentFilters();
    let payload;
    if (window.location.protocol === "file:" || window.location.hostname.endsWith(".github.io")) {
      payload = await searchGitHubDirectly(filters);
    } else {
      try {
        const response = await fetch("/api/issues?" + filters.toString(), {
          headers: { Accept: "application/json" }
        });
        const serverPayload = await response.json();
        if (!response.ok) throw new Error(serverPayload.error || "Could not load issues.");
        payload = serverPayload;
      } catch (_serverError) {
        payload = await searchGitHubDirectly(filters);
      }
    }
    currentIssues = Array.isArray(payload.issues) ? payload.issues : [];
    drawResults();
    if (payload.meta && payload.meta.hiddenClaimed > 0) {
      const count = payload.meta.hiddenClaimed;
      showStatus(count + " issue" + (count === 1 ? " was" : "s were") + " hidden because recent comments looked like a claim. Remaining listings still need a final check on GitHub.", true);
    }
  } catch (error) {
    currentIssues = [];
    renderEmpty("We couldn’t reach GitHub", error.message || "Check your connection and try again.");
    showStatus("The issue search could not finish. GitHub may be rate-limiting requests; wait a few minutes and try again.", true);
  } finally {
    searchButton.disabled = false;
    searchButton.querySelector("span:first-child").textContent = "Find beginner issues";
  }
}

function toggleSaved(issueId) {
  const saved = getSavedIssues();
  const existing = saved.findIndex((issue) => String(issue.id) === String(issueId));
  if (existing >= 0) {
    saved.splice(existing, 1);
  } else {
    const issue = currentIssues.find((item) => String(item.id) === String(issueId));
    if (issue) saved.unshift(issue);
  }
  saveIssues(saved);
  drawResults();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadIssues();
});

sortOrder.addEventListener("change", drawResults);
savedToggle.addEventListener("click", () => {
  isSavedView = !isSavedView;
  drawResults();
});

list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-save-id]");
  if (!button) return;
  toggleSaved(button.getAttribute("data-save-id"));
});

document.querySelectorAll(".skill-chip").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.getAttribute("data-skill");
    const current = skillsField.value.split(",").map((part) => part.trim()).filter(Boolean);
    const existing = current.findIndex((skill) => skill.toLowerCase() === value.toLowerCase());
    if (existing >= 0) {
      current.splice(existing, 1);
      skillsHint.textContent = "Removed " + button.textContent.trim() + ". Choose Find beginner issues when you’re ready.";
    } else {
      current.push(value);
      skillsHint.textContent = "Added " + button.textContent.trim() + ". Choose Find beginner issues when you’re ready.";
    }
    skillsField.value = current.join(", ");
    syncSkillChips();
  });
});

function syncSkillChips() {
  const selected = new Set(skillsField.value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
  document.querySelectorAll(".skill-chip").forEach((button) => {
    const active = selected.has(String(button.getAttribute("data-skill") || "").toLowerCase());
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("selected", active);
  });
}

skillsField.addEventListener("input", syncSkillChips);

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.getElementById("skills").focus();
  }
});

updateSavedToggle();
syncSkillChips();
loadIssues();
