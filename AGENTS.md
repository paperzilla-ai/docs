# Documentation project instructions

## About this project

- This is the user-facing documentation site for Paperzilla, built on [Mintlify](https://mintlify.com)
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

## Content boundaries

- Document user-visible Paperzilla behavior only
- Do not document internal admin flows, hidden tooling, or implementation details that users cannot access
- Do not claim support for clients, auth flows, or tool behavior unless it is confirmed
- Put task flows in `guides/`, terse factual answers in `answers/`, and wire/protocol details in `api-reference/`
- If you add a new public page, add it to `docs.json`
- If you add or change a page, keep related pages consistent when they share the same contract, such as MCP auth modes, tool names, or dashboard paths
