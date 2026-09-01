import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildManifest } from './manifest.mjs';
import {
    expectedRecord,
    validateAuthoredContent,
} from './content.mjs';
import {
    localizeDocsTarget,
    restoreDocsSourcePaths,
    validateFrontmatterPair,
} from './content-structure.mjs';
import { expectedNavigationRecord } from './navigation.mjs';
import { buildPreviewProjection } from './preview.mjs';
import { findFormalVoice, normalizeDirectVoice } from './tone.mjs';

const metadata = {
    generatedAt: '2026-09-01T08:00:00Z',
    promptSha256: 'a'.repeat(64),
    styleGuideSha256: 'b'.repeat(64),
};

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

function canonicalJson(value) {
    function sort(item) {
        if (Array.isArray(item)) {
            return item.map(sort);
        }
        if (item && typeof item === 'object') {
            return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
        }
        return item;
    }
    return `${JSON.stringify(sort(value), null, 2)}\n`;
}

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
        translation: {
            promptSha256: metadata.promptSha256,
            guides: { es: { sha256: metadata.styleGuideSha256 } },
        },
    }, null, 2)}\n`);
    const manifest = await buildManifest(metadata.generatedAt, root);
    await writeFile(path.join(root, '.i18n/content.manifest.json'), canonicalJson(manifest));
    return { root, manifest };
}

test('docs extraction matches the backend-frozen IDs and protected hash', () => {
    const record = expectedRecord('index.mdx', sourceFixture, translationFixture, metadata);
    assert.equal(record.contentClass, 'docs');
    assert.equal(record.publicPath, '/');
    assert.equal(record.protectedStructureSha256, '207bd3080c94133bb2360d58fa091b9e489a87e83f91e85b6087216d70275d83');
    assert.deepEqual(record.segments.map((segment) => segment.id), [
        'frontmatter-title:8dd65d0952ed144ccf6e:1',
        'frontmatter-sidebarTitle:8dd65d0952ed144ccf6e:1',
        'frontmatter-description:68acfcd157d8de225e6a:1',
        'frontmatter-keywords:a2c68106e0879f20f7b5:1',
        'jsx-title:e4bb9f1ece9af9264a3b:1',
        'jsx-caption:87d296ec94898c86baf8:1',
        'body:6a106561f29ca82b9176:1',
    ]);
});

test('real navigation projection matches the backend-frozen pseudo-document', async () => {
    const source = JSON.parse(await readFile(new URL('../docs.json', import.meta.url), 'utf8'));
    const translated = await readFile(new URL('./navigation.es.json', import.meta.url), 'utf8');
    const record = expectedNavigationRecord(source, translated, metadata);
    assert.equal(record.sourceSha256, 'eb6f65625d84e44a5cd158e2037e3b9bc959988385c02eab60b5e1cff4fbbbe3');
    assert.equal(record.protectedStructureSha256, 'e931cb58c7f36bbe2adcd008ed09a044b527caca4597ae8eaf58c951c35d9ef8');
    assert.equal(record.segments.length, 23);
    assert.equal(record.segments[0].id, 'navigation-anchor:2b5c3d26721ae9c350cf:1');
    assert.equal(record.segments.at(-1).id, 'navigation-label:67b696468610b879ed7f:1');
});

test('English navigation label drift invalidates stale Spanish provenance', async () => {
    const { root } = await createFixtureRepository();
    try {
        assert.deepEqual(await validateAuthoredContent(root), []);
        const docsConfig = JSON.parse(await readFile(path.join(root, 'docs.json'), 'utf8'));
        docsConfig.navigation.tabs[0].tab = 'Documentation';
        await writeFile(path.join(root, 'docs.json'), `${JSON.stringify(docsConfig, null, 2)}\n`);
        const errors = await validateAuthoredContent(root);
        assert(errors.some((error) => error.includes('docs:navigation') || error.includes('.sourceSha256 is stale')));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('Spanish navigation requires NFC text and LF-only line endings', async () => {
    const { root } = await createFixtureRepository();
    const navigationPath = path.join(root, '.i18n/navigation.es.json');
    try {
        const original = await readFile(navigationPath, 'utf8');
        await writeFile(navigationPath, original.normalize('NFD'));
        assert((await validateAuthoredContent(root)).some((error) => error.includes('NFC-normalized')));
        await writeFile(navigationPath, original.replace(/\n/g, '\r\n'));
        assert((await validateAuthoredContent(root)).some((error) => error.includes('LF-only')));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
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

test('unchanged reviewed segments retain provenance across a one-segment delta', async () => {
    const { root, manifest } = await createFixtureRepository();
    try {
        const indexRecord = manifest.documents.find((record) => record.contentId === 'docs:index');
        indexRecord.segments[0] = {
            ...indexRecord.segments[0],
            generatedAt: '2026-09-01T09:00:00Z',
            model: null,
            provider: 'human',
            reviewStatus: 'human-reviewed',
            reviewer: 'reviewer@example.com',
        };
        await writeFile(path.join(root, '.i18n/content.manifest.json'), canonicalJson(manifest));
        await writeFile(path.join(root, 'index.mdx'), sourceFixture.replace('Read the [guide]', 'Read the updated [guide]'));
        await writeFile(path.join(root, 'es/index.mdx'), translationFixture.replace('Consulta la [guía]', 'Consulta la [guía actualizada]'));
        const next = await buildManifest('2026-09-01T10:00:00Z', root);
        const nextIndex = next.documents.find((record) => record.contentId === 'docs:index');
        assert.equal(nextIndex.segments[0].provider, 'human');
        assert.equal(nextIndex.segments[0].model, null);
        assert.equal(nextIndex.segments[0].reviewStatus, 'human-reviewed');
        assert(nextIndex.segments.some((segment) => segment.generatedAt === '2026-09-01T10:00:00Z'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('human provenance requires model null, human review, and a reviewer', async () => {
    const { root, manifest } = await createFixtureRepository();
    try {
        const record = manifest.documents[0];
        Object.assign(record, {
            model: null,
            provider: 'human',
            reviewStatus: 'human-reviewed',
            reviewer: 'reviewer@example.com',
        });
        await writeFile(path.join(root, '.i18n/content.manifest.json'), canonicalJson(manifest));
        assert.deepEqual(await validateAuthoredContent(root), []);
        record.model = 'human-editor';
        await writeFile(path.join(root, '.i18n/content.manifest.json'), canonicalJson(manifest));
        assert((await validateAuthoredContent(root)).some((error) => error.includes('model must be null')));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('tone guard catches formal and vosotros prose without touching code, URLs, or paths', () => {
    assert.deepEqual(new Set(findFormalVoice('Continúe y revisad la guía.')), new Set(['Continúe', 'revisad']));
    const source = 'Use este texto, `Use command`, https://example.com/use y href="/use".';
    assert.equal(normalizeDirectVoice(source), 'Usa este texto, `Use command`, https://example.com/use y href="/use".');
});

test('tracked Run 6 corpus and 97-record manifest validate offline', async () => {
    assert.deepEqual(await validateAuthoredContent(), []);
    const source = await readFile(new URL('../index.mdx', import.meta.url), 'utf8');
    const translated = await readFile(new URL('../es/index.mdx', import.meta.url), 'utf8');
    assert.equal(expectedRecord('index.mdx', source, translated, metadata).protectedStructureSha256,
        'c710fe71286949aa2e927c6707a2408c97a429d1c5b758e2a78d46574f966ae9');
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
        await mkdir(output);
        await writeFile(path.join(output, 'stale.txt'), 'stale\n');
        await assert.rejects(buildPreviewProjection({ output }), /already exists/);
        assert.equal(await readFile(path.join(output, 'stale.txt'), 'utf8'), 'stale\n');
        await buildPreviewProjection({ output, replace: true });
        await assert.rejects(readFile(path.join(output, 'stale.txt'), 'utf8'), /ENOENT/);
        assert.match(await readFile(path.join(output, 'PREVIEW_ONLY.txt'), 'utf8'), /Never deploy/);
        await readFile(path.join(output, 'es/index.mdx'), 'utf8');
        const previewConfig = JSON.parse(await readFile(path.join(output, 'docs.json'), 'utf8'));
        assert(previewConfig.navigation.tabs.some((tab) => JSON.stringify(tab).includes('es/index')));
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
