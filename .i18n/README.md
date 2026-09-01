# Run 6 authored docs

Spanish remains a planned, non-public locale. The complete authored tree is
tracked under `es/`, but production `docs.json` stays English-only and the exact
`es/` rule in `.mintignore` prevents Mintlify from publishing, indexing, or
feeding that tree to AI/search surfaces. Do not add `.mintignore` negations or a
production language selector before the coordinated Run 7 promotion.

## Offline checks

```bash
node --test .i18n/*.test.mjs
node .i18n/check.mjs
node .i18n/preview.mjs --output /tmp/paperzilla-docs-es-preview --replace
```

The preview command validates first, builds a fresh sibling staging directory,
and atomically swaps an outside-repository target. Preview it with:

```bash
mint dev --root /tmp/paperzilla-docs-es-preview
```

Never deploy that projection. Its `docs.json` and `es/` paths exist only to
exercise future activation faithfully.

## Manifest updates

`.i18n/content.manifest.json` contains one source-derived record per English MDX
file plus the `docs:navigation` pseudo-document. Each record and visible segment
has source/translation/protected-structure hashes and provider/model/review
provenance. Internal `/es` prefixes are deterministic post-translation mapping,
not provider-authored text.

After an approved translation import or a deliberate source/translation edit,
regenerate with an explicit UTC timestamp:

```bash
node .i18n/manifest.mjs generate --generated-at YYYY-MM-DDTHH:MM:SSZ
```

Unchanged segment provenance is retained. Stale human-reviewed documents or
segments are never silently overwritten. Valid review states are `machine`,
`technical-approved`, and `human-reviewed`; human provenance requires
`model: null`, a named reviewer, and `human-reviewed` status.
