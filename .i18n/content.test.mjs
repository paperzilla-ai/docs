import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertNonPromotableArtifact, nonPromotableMarkerName } from './artifact-guard.mjs';
import {
    validateAuthoredContent,
} from './content.mjs';
import {
    localizeDocsTarget,
    restoreDocsSourcePaths,
    validateFrontmatterPair,
} from './content-structure.mjs';
import { localizeMdxPaths } from './path-map.mjs';
import { buildPreviewProjection } from './preview.mjs';
import { findFormalVoice, normalizeDirectVoice } from './tone.mjs';

const sourceFixture = `---
title: "Guide"
sidebarTitle: "Guide"
description: "Docs description"
keywords: ["research", "alerts"]
---

import Card from "/guides/card"

<Card title="Start" caption="Caption" path="/quickstart">
Read the [guide](/guides/start) and [pricing](/pricing).
</Card>
`;

const translationFixture = `---
title: "Guía"
sidebarTitle: "Guía"
description: "Descripción de la documentación"
keywords: ["investigación", "alertas"]
---

import Card from "/es/guides/card"

<Card title="Comenzar" caption="Leyenda" path="/es/quickstart">
Consulta la [guía](/es/guides/start) y los [precios](/pricing).
</Card>
`;

function navigationPair() {
    const source = {
        navigation: {
            tabs: [{ tab: 'Guides', groups: [{ group: 'Getting started', pages: ['index'] }] }],
        },
        navbar: { links: [{ label: 'Dashboard', href: 'https://paperzilla.ai/dashboard' }] },
    };
    const translated = {
        schemaVersion: 1,
        locale: 'es',
        source: 'docs.json',
        navigation: {
            tabs: [{ tab: 'Guías', groups: [{ group: 'Primeros pasos', pages: ['es/index'] }] }],
        },
        navbar: { links: [{ label: 'Panel', href: 'https://paperzilla.ai/dashboard' }] },
    };
    return { source, translated };
}

async function createFixtureRepository() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-content-'));
    await mkdir(path.join(root, '.i18n'));
    await mkdir(path.join(root, 'es'));
    const { source, translated } = navigationPair();
    await writeFile(path.join(root, 'index.mdx'), sourceFixture);
    await writeFile(path.join(root, 'es/index.mdx'), translationFixture);
    await writeFile(path.join(root, 'docs.json'), `${JSON.stringify(source, null, 2)}\n`);
    await writeFile(path.join(root, '.i18n/navigation.es.json'), `${JSON.stringify(translated, null, 2)}\n`);
    await writeFile(path.join(root, '.i18n/locales.generated.json'), `${JSON.stringify({
        sourceLocale: 'en',
        locales: [
            { tag: 'en', pathPrefix: '', stage: 'live' },
            { tag: 'es', pathPrefix: 'es', stage: 'live' },
        ],
    }, null, 2)}\n`);
    return root;
}

test('present translations keep structural checks and missing translations need no approval files', async () => {
    const root = await createFixtureRepository();
    try {
        assert.deepEqual(await validateAuthoredContent(root), []);
        await writeFile(path.join(root, 'es/index.mdx'), translationFixture.replace('/es/quickstart', '/es/wrong'));
        assert((await validateAuthoredContent(root)).some((error) => error.includes('changed protected')));
        await rm(path.join(root, 'es/index.mdx'));
        assert.deepEqual(await validateAuthoredContent(root), []);
        await rm(path.join(root, 'es'), { recursive: true });
        await rm(path.join(root, '.i18n/navigation.es.json'));
        assert.deepEqual(await validateAuthoredContent(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('source-aware path restoration preserves /index and rejects a wrong localized route', () => {
    const source = '[Home](/index?tab=all) and [root](/#top).';
    const localized = '[Inicio](/es?tab=all) y [raíz](/es#top).';
    assert.equal(localizeDocsTarget('/index?tab=all'), '/es?tab=all');
    assert.equal(restoreDocsSourcePaths(localized, source), '[Inicio](/index?tab=all) y [raíz](/#top).');
    assert.throws(() => restoreDocsSourcePaths('[Inicio](/es/index?tab=all) y [raíz](/es#top).', source));
});

test('frontmatter key order, recursive shape, and invariants are independent guards', () => {
    assert.deepEqual(validateFrontmatterPair(sourceFixture, translationFixture), []);
    assert(
        validateFrontmatterPair(sourceFixture, translationFixture.replace(
            'keywords: ["investigación", "alertas"]',
            'keywords: "investigación, alertas"',
        )).some((error) => error.includes('value shape changed for keywords')),
    );
    assert(
        validateFrontmatterPair('---\ntitle: "A"\nicon: "book"\n---\n', '---\ntitle: "B"\nicon: "libro"\n---\n')
            .some((error) => error.includes('Invariant frontmatter changed for icon')),
    );
    assert(
        validateFrontmatterPair(sourceFixture, translationFixture.replace('title: "Guía"', 'title: "Guía'))
            .some((error) => error.includes('Unterminated double-quoted YAML scalar')),
    );
});

test('tone guard catches formal and vosotros prose without touching code, URLs, or paths', () => {
    assert.deepEqual(new Set(findFormalVoice('Continúe y revisad la guía.')), new Set(['Continúe', 'revisad']));
    const source = 'Use este texto, `Use command`, https://example.com/use y href="/use".';
    assert.equal(normalizeDirectVoice(source), 'Usa este texto, `Use command`, https://example.com/use y href="/use".');
});

test('preview rejects repo-local output and atomically replaces stale temporary output', async () => {
    const repositoryLocal = path.resolve(new URL('../.spanish-preview', import.meta.url).pathname);
    await assert.rejects(
        buildPreviewProjection({ output: repositoryLocal }),
        /outside the docs repository/,
    );
    const base = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-preview-test-'));
    const output = path.join(base, 'projection');
    try {
        const repositoryLink = path.join(base, 'repository-link');
        await symlink(path.resolve(new URL('../', import.meta.url).pathname), repositoryLink, 'dir');
        await assert.rejects(
            buildPreviewProjection({ output: path.join(repositoryLink, 'projection') }),
            /including through symlinks/,
        );
        await mkdir(output);
        await writeFile(path.join(output, 'stale.txt'), 'stale\n');
        await assert.rejects(buildPreviewProjection({ output }), /already exists/);
        assert.equal(await readFile(path.join(output, 'stale.txt'), 'utf8'), 'stale\n');
        await buildPreviewProjection({ output, replace: true });
        await assert.rejects(readFile(path.join(output, 'stale.txt'), 'utf8'), /ENOENT/);
        assert.match(await readFile(path.join(output, 'PREVIEW_ONLY.txt'), 'utf8'), /Never deploy/);
        await assertNonPromotableArtifact(output);
        await readFile(path.join(output, nonPromotableMarkerName), 'utf8');
        await readFile(path.join(output, 'index.mdx'), 'utf8');
        await readFile(path.join(output, 'es/index.mdx'), 'utf8');
        await assert.rejects(readFile(path.join(output, '.mintignore'), 'utf8'), /ENOENT/);
        const previewConfig = JSON.parse(await readFile(path.join(output, 'docs.json'), 'utf8'));
        assert.deepEqual(previewConfig.navigation.languages.map((entry) => entry.language), ['en', 'es']);
        assert.equal(previewConfig.seo.metatags.robots, 'noindex, nofollow, noarchive');
        assert(previewConfig.navigation.languages[1].tabs.some((tab) => JSON.stringify(tab).includes('es/index')));
        await buildPreviewProjection({ output, replace: true });
        await assertNonPromotableArtifact(output);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('missing translated MDX imports use the English file and recover when translated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docs-snippet-fallback-'));
    try {
        await mkdir(path.join(root, 'snippets'));
        await writeFile(path.join(root, 'snippets/card.mdx'), 'English');
        const source = "import Card from '/snippets/card.mdx';";
        const translated = "import Card from '/es/snippets/card.mdx';";
        assert.equal(localizeMdxPaths(translated, 'es', root), source);
        await mkdir(path.join(root, 'es/snippets'), { recursive: true });
        await writeFile(path.join(root, 'es/snippets/card.mdx'), 'Español');
        assert.equal(localizeMdxPaths(source, 'es', root), translated);
    } finally { await rm(root, { recursive: true, force: true }); }
});
