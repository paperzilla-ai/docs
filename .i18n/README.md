# Run 7 Spanish docs review and launch gates

The shared product registry marks Spanish preview (beta only). Documentation is
live under Mark's hash-bound docs-only `.i18n/publication.json` decision; see
backend `docs/multilingual/spanish-docs-live-2026-09-07.md`. This exception never
activates Spanish product UI, Auth, or email. Confirmed full linguistic review
is recorded separately in segment provenance and the launch matrix.

Without that explicit docs-only exception, the normal planned-stage rule is:
the complete authored tree is
tracked under `es/`, but production `docs.json` stays English-only and the exact
`es/` rule in `.mintignore` prevents Mintlify from publishing, indexing, or
feeding that tree to AI/search surfaces. The same hidden contract applies while
Spanish is `preview`; only `live` may remove the ignore and materialize the
language switcher.

## Deterministic checks

Install the lockfile-pinned Mint `4.2.857` dependency once:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

That dependency setup is the only project-check step that fetches packages.
The Node validators and Mint validation commands are credential-free,
model-free, and deterministic after installation.

```bash
npm run i18n:test
npm run i18n:check
node .i18n/deploy-config.mjs check
node .i18n/artifact-guard.mjs assert-deployable --root .
node .i18n/preview.mjs --output /tmp/paperzilla-docs-es-run7-review --replace
npm run mint:validate
npm run mint:broken-links
```

The review command validates first, builds a fresh sibling staging directory,
and atomically swaps an outside-repository target. The projection contains both
English and Spanish plus the exact future `navigation.languages` configuration,
but it is not a production artifact. Preview it with:

```bash
mint dev --root /tmp/paperzilla-docs-es-run7-review
```

Never deploy that projection. It has review-only `noindex, nofollow, noarchive`
metadata plus a deterministic `.paperzilla-non-promotable.json` marker.
Deployment tooling must call the guard before accepting any docs root:

```bash
node .i18n/artifact-guard.mjs assert-deployable --root PATH
```

CI separately proves the review projection is marked with
`assert-non-promotable`. `review-evidence.json` records deterministic
content/config hashes and current human-review coverage so reviewers know
whether promotion is still blocked.

## Stage-derived deploy config

`docs.json` must be the exact deploy artifact for the generated registry:

- `planned`, `preview`, and `retired` non-source locales remain ignored and do
  not appear in deploy navigation.
- `live` locales are materialized under `navigation.languages`, with English
  first and unprefixed and locale-specific global navigation and navbar copy.

A retired locale is checked against its frozen manifest and retained Spanish
bytes, navigation, provenance, and protected structure. It is deliberately not
compared with later English content, so future English documentation can evolve
without mutating historical Spanish artifacts.

Check the committed artifact with `node .i18n/deploy-config.mjs check`. To inspect
the future live config while Spanish is still planned, write it only outside the
repository:

```bash
node .i18n/deploy-config.mjs generate \
  --future-live es \
  --output /tmp/paperzilla-docs-live.json
```

Promotion to `preview` or `live` additionally requires every one of the 96
Spanish pages, the navigation pseudo-document, and all 2,286 tracked segments
to retain current protected hashes and named human-review provenance. The
generated launch-review matrix mirror adds the required linguistic, editorial,
technical, SEO, and promotion approvals. Reviewer fields accept stable labels
only; email addresses, URLs, and phone-like contact strings are rejected.

## Manual hosted live gate

Do not run hosted Spanish checks while the registry is `planned` or `preview`.
After the accepted registry is `live` and the hosted docs deployment finishes,
run:

```bash
node .i18n/hosted-smoke.mjs --base-url https://docs.paperzilla.ai
```

The command refuses to run unless the local generated registry marks Spanish
live and indexable. It verifies reciprocal canonical and `hreflang` metadata,
HTML language, English/Spanish sitemap entries, `llms.txt`, `llms-full.txt`,
`skill.md`, Spanish Markdown content negotiation, and an actual Spanish result
through the hosted Mintlify MCP search tool. It also fails if the review-only
marker is publicly reachable. This is a manual post-deployment gate and is not
part of planned-stage CI.

## Manifest updates

Zero-correction review decisions use the backend `i18n_content.py import-review`
command with `--collection docs`. It validates exact CSV coverage/freshness,
stages only the manifest, and runs this repository's complete MDX/content
validator against the staged metadata before replacing anything. It preserves
every MDX/navigation byte and the original translation provider/model. Review
metadata changes invalidate the docs-only publication hash; renew it only after
verifying the accepted content is unchanged. Corrections remain a separate
content edit/import and validation step, never implicit in an approval.

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
`model: null`, a stable non-contact reviewer label, and `human-reviewed` status.
