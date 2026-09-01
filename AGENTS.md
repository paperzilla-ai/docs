# Documentation project instructions

## About this project

- This is the user-facing documentation site for Paperzilla, built on [Mintlify](https://mintlify.com)
- The canonical multilingual rollout plan is in the backend repository at `docs/multilingual/00-rollout-index.md`; this repository contains only its generated locale-registry mirror and user-facing localized content.
- Adding or promoting a locale must follow the backend playbook at `docs/multilingual/HOWTO_ADD_A_LANGUAGE.md`.
- Run 7 reviews and gates the complete Spanish mirror under `es/`. The exact
  `es/` entry in `.mintignore` keeps that tree unprocessed, unpublished,
  unindexed, and absent from Mintlify AI, search, and MCP surfaces while Spanish
  is `planned` or `preview`. Production `docs.json` stays English-only in both
  stages. Use the isolated `.i18n/preview.mjs` projection for review; never add
  a public language selector, localized navigation, or Spanish discovery before
  the coordinated `live` promotion passes the launch matrix.
- Use ordinary Git branches for multilingual work; do not create or use Git worktrees.
- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Main content areas:
  - `what-is-paperzilla/` for positioning and product overview
  - `guides/` for task-based how-to docs
  - `answers/` for one-question-per-page Q&A
  - `api-reference/` for technical appendices and protocol details
- Run `mint dev` to preview locally
- Run `mint broken-links` to check links
- Run `mint validate` when you add pages, change navigation, or touch shared doc structure
- Install the exact Mint CLI with `npm ci --ignore-scripts --no-audit --no-fund`;
  `package-lock.json`
  is the dependency source of truth. Package installation is the sole project
  check that fetches dependencies; validation itself uses no credentials or models.
- Run `node .i18n/preview.mjs --output /tmp/paperzilla-docs-es-run7-review --replace`
  for the hidden Spanish review projection, then run `mint dev --root
  /tmp/paperzilla-docs-es-run7-review`; never project preview files inside this
  repository or deploy the preview directory.
- Deployment tooling must run `node .i18n/artifact-guard.mjs assert-deployable
  --root PATH`. The review projection carries a deterministic marker that makes
  this guard fail closed.
- Run `.i18n/hosted-smoke.mjs` manually only after Spanish is live; it refuses
  planned/preview registries and must not add hosted network checks to planned CI.

## Terminology

- Use **project** for the standing research topic a user tracks
- Use **feed** for the list of papers in a project
- Use **Must Read** and **Related** exactly as written when referring to relevance classes
- Use **MCP API key** for Paperzilla MCP credentials
- Use **RSS/Atom** or **Atom feed URL**, not generic "XML feed"
- Use **Paperzilla MCP** or **MCP endpoint** for the integration surface
- Do not introduce terms like "workspace", "collection", or "monitor" unless the product actually uses them

## Style preferences

- Use active voice and second person ("you")
- Keep sentences concise — one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references
- Start pages with the shortest clear explanation of what the page helps the reader do
- Prefer text-first docs over screenshots; only use screenshots if the asset already exists or the user asks for them
- Keep the tone factual and operational; avoid marketing language
- For client-specific integrations, explain what is client-specific and link to the generic Paperzilla page instead of duplicating protocol detail everywhere
- For time-sensitive third-party behavior, verify it and name the external product explicitly, for example Claude or Cursor

## Codex skill usage

- Superpowers skills are opt-in only.
  - Use Superpowers skills only when Mark explicitly asks for them in the current turn.
  - Do not auto-activate Superpowers based only on task type.

## AI agents snippet

Every new page must include the AI agents snippet right after the frontmatter. Add the import and component:

```mdx
---
title: "Page title"
description: "Page description"
---

import { AiAgents } from '/snippets/ai-agents.mdx';

<AiAgents path="/page-path" />
```

The `path` prop must match the page's URL path (e.g., `/quickstart`, `/essentials/settings`).
For a tracked Spanish mirror, deterministically prefix internal docs imports,
links, navigation page identities, and the `AiAgents` path with `es` as enforced
by `.i18n/path-map.mjs`; do not rewrite external/app/API/image or `/llms*.txt`
targets.

## Content boundaries

- Document user-visible Paperzilla behavior only
- Do not document internal admin flows, hidden tooling, or implementation details that users cannot access
- Do not claim support for clients, auth flows, or tool behavior unless it is confirmed
- Put task flows in `guides/`, terse factual answers in `answers/`, and wire/protocol details in `api-reference/`
- If you add a new public page, add it to `docs.json`
- If you add or change a page, keep related pages consistent when they share the same contract, such as MCP auth modes, tool names, or dashboard paths
