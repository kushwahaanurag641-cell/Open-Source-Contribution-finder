# Patchwork — Open-Source Contribution Finder

Patchwork helps students and first-time contributors discover GitHub issues that fit their skills. It searches current issues, prioritizes beginner labels and recent activity, checks whether an issue is assigned, and explains the match signals.

## Features

- Beginner-first search with two visible choices and optional advanced filters.
- Live GitHub issue search by programming language, skills, experience level, and freshness.
- Filters for open issues with no assignee and recent updates.
- Checks recent issue comments for obvious claims when the GitHub API makes them available.
- Shows a plain-language fit label and readable reasons for each result.
- Save issue cards in the browser with the heart button.
- Includes a beginner-friendly checklist for choosing and claiming an issue.
- Keeps the optional GitHub token on the server; it is never sent to browser JavaScript.

## Run locally

Requirements: Node.js 18 or newer.

From this folder:

    npm start

Then open http://localhost:3000.

The backend uses Node's built-in HTTP server and Fetch API, so no package installation is required.

## Deploy for a public link

This project includes a Render Blueprint in `render.yaml`. To publish it, sign in to Render, choose **New > Blueprint**, connect your GitHub fork, and select its `main` branch. Render will create the Node web service and provide a public `onrender.com` URL. The free service can sleep when idle, so its first request after a pause may take longer.

### Publish the static site with GitHub Pages

The `public/` folder can also run without a Node server. The included GitHub Actions workflow publishes it when changes are pushed to `main`. On GitHub, open the repository's **Settings > Pages**, select **GitHub Actions** as the build and deployment source, and push the project to your fork. After the workflow finishes, GitHub Pages shows the public website URL in that same settings page. In this mode the browser searches GitHub's public API directly, so requests can be rate-limited and issue comments should be checked manually.

The hosted server reads Render's `PORT` environment variable and listens on `0.0.0.0`, as required for public web-service traffic.

### Optional GitHub API token

Public issue search works without authentication, but GitHub applies stricter limits to unauthenticated and search requests. To use a token locally, set it in the server environment before starting:

    GITHUB_TOKEN=your_token_here npm start

Use a token with read access to public data only. Do not put the token in public/app.js, index.html, or any file committed to a public repository. The server caches matching responses for five minutes to avoid repeated calls.

## API

### GET /api/issues

Query parameters:

- language: an optional GitHub language filter, such as JavaScript or Python.
- skills: comma-separated terms to prioritize when they appear in the issue title, body, or labels.
- level: beginner, intermediate, or any.
- freshDays: include issues updated within this many days; accepted range is 7–365.
- limit: number of results; accepted range is 5–40.

Example:

    /api/issues?language=JavaScript&skills=react,css&level=beginner&freshDays=90&limit=24

### GET /api/health

Returns a small JSON health response for the local server.

## How matching works

Patchwork only searches open issues, excludes pull requests, filters out assigned issues, and discards issues with common closed or invalid labels. It ranks beginner labels, matching skill words, recent updates, and useful descriptions. For the highest-ranked issues with comments, the server checks recent comments for explicit phrases that may indicate someone has claimed the work.

GitHub data cannot guarantee that an issue is still available. A person may have claimed it in a discussion Patchwork could not inspect, or the maintainer may have changed its status moments ago. Always open the issue, read the contribution guide, and ask the maintainer before starting.

## Project structure

    server.js       Node.js API and static-file server
    public/
      index.html    Page structure
      styles.css    Responsive visual design
      app.js        Search form, rendering, and saved issues

## Hacktoberfest

This is an independent issue-discovery tool. It is not an official Hacktoberfest service and cannot guarantee that a project or issue qualifies for any event rules.

## Project presentation

See [`Patchwork_Project_Pitch_Expanded.pptx`](presentations/Patchwork_Project_Pitch_Expanded.pptx) for the project overview, user flow, matching approach, and implementation details.
