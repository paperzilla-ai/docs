# Multilingual docs maintenance

Translations under `es/` and `.i18n/navigation.es.json` are ordinary source files.
Coding-agent edits are accepted without a reviewer, status, launch matrix,
publication exception, or provenance manifest. English is canonical.

The generated locale registry comes from backend `config/i18n/locales.json`.
Do not hand-edit its mirror. Only live locales are published. Planned/preview
locale trees stay excluded by `.mintignore`; isolated preview artifacts carry
non-promotable markers and must never be deployed to production.

## Editing and checking

Edit English and translated MDX directly, preserving frontmatter structure,
identifiers, links, code, imports and component props. Use `.i18n/path-map.mjs
apply` to maintain internal Spanish paths. Missing files and navigation labels
are allowed and use English; malformed present translations still fail validation.

After adding/removing pages or changing navigation/stages:

```sh
node .i18n/deploy-config.mjs generate --output docs.json
npm run i18n:check
npm run i18n:test
npm run mint:validate
npm run mint:broken-links
```

The config generator points missing navigation entries at English and adds
native temporary redirects for missing translated page URLs. Adding a translation
and regenerating removes those redirects. This also handles internal links to
missing translations. A genuinely unknown page remains unknown.

Technical CI checks current files, links, configuration and publication isolation.
It runs without models or credentials. It does not approve or deploy releases.
The historical Spanish rollout notes remain evidence, not current requirements.
See backend `docs/multilingual/MAINTAINING_TRANSLATIONS.md`.

## Isolated previews

```sh
node .i18n/preview.mjs --output /tmp/paperzilla-docs-es-review --replace
```

Preview output must resolve outside this repository. Never publish it. Deployment
tooling checks `.i18n/artifact-guard.mjs assert-deployable --root PATH`.
Hosted smoke checks are optional read-only checks after publication; they do not
run in deterministic CI. The existing Mintlify hreflang limitation remains
recorded in the historical hosted-docs report.
