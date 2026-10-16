import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    assertPathOutsideRoot,
    buildDeployConfig,
    canonicalJson,
    englishDocsConfig,
    registryWithFutureLiveLocale,
} from './deploy-config.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function registry(stage = 'planned') {
    return {
        sourceLocale: 'en',
        locales: [
            { tag: 'en', stage: 'live' },
            { tag: 'es', stage, indexable: stage === 'live' },
        ],
    };
}

function sourceConfig() {
    return {
        name: 'Docs',
        navigation: {
            global: { anchors: [{ anchor: 'Contact', href: 'mailto:test@example.com' }] },
            tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['index'] }] }],
        },
        navbar: { primary: { type: 'button', label: 'Dashboard', href: 'https://example.com' } },
        footer: { socials: { x: 'https://example.com' } },
    };
}

function spanishNavigation() {
    return {
        schemaVersion: 1,
        locale: 'es',
        source: 'docs.json',
        navigation: {
            global: { anchors: [{ anchor: 'Contacto', href: 'mailto:test@example.com' }] },
            tabs: [{ tab: 'Guías', groups: [{ group: 'Inicio', pages: ['es/index'] }] }],
        },
        navbar: { primary: { type: 'button', label: 'Panel', href: 'https://example.com' } },
    };
}

test('planned and preview locales keep the deploy config English-only', () => {
    const source = sourceConfig();
    assert.deepEqual(buildDeployConfig(source, registry('planned'), { es: spanishNavigation() }), source);
    assert.deepEqual(buildDeployConfig(source, registry('preview'), { es: spanishNavigation() }), source);
});

test('live locale config is deterministic, localized, and reversible to English', () => {
    const source = sourceConfig();
    const live = buildDeployConfig(source, registry('live'), { es: spanishNavigation() });
    assert.equal(live.navbar, undefined);
    assert.equal(live.footer, undefined);
    assert.deepEqual(live.navigation.languages.map((entry) => entry.language), ['en', 'es']);
    assert.equal(live.navigation.languages[0].default, true);
    assert.equal(live.navigation.languages[0].global.anchors[0].anchor, 'Contact');
    assert.equal(live.navigation.languages[1].global.anchors[0].anchor, 'Contacto');
    assert.deepEqual(live.navigation.languages[1].tabs[0].groups[0].pages, ['es/index']);
    assert.deepEqual(englishDocsConfig(live), source);
    assert.deepEqual(buildDeployConfig(live, registry('live'), { es: spanishNavigation() }), live);
});

test('future-live projection does not mutate the committed planned registry', () => {
    const planned = registry('planned');
    const projected = registryWithFutureLiveLocale(planned, 'es');
    assert.equal(planned.locales[1].stage, 'planned');
    assert.deepEqual(projected.locales[1], { tag: 'es', stage: 'live', indexable: true });
});



test('committed docs config matches the canonical live locale registry', async () => {
    const [rawConfig, rawRegistry, rawSpanish] = await Promise.all([
        readFile(new URL('../docs.json', import.meta.url), 'utf8'),
        readFile(new URL('./locales.generated.json', import.meta.url), 'utf8'),
        readFile(new URL('./navigation.es.json', import.meta.url), 'utf8'),
    ]);
    const expected = buildDeployConfig(
        JSON.parse(rawConfig),
        JSON.parse(rawRegistry),
        { es: JSON.parse(rawSpanish) },
    );
    assert.equal(rawConfig, canonicalJson(expected));
    assert.deepEqual(expected.navigation.languages.map((entry) => entry.language), ['en', 'es']);
});

test('outside-repository enforcement resolves symlinked ancestors', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-output-guard-'));
    try {
        const repositoryLink = path.join(base, 'repository-link');
        await symlink(repositoryRoot, repositoryLink, 'dir');
        await assert.rejects(
            assertPathOutsideRoot(path.join(repositoryLink, 'future-live.json'), repositoryRoot),
            /including through symlinks/,
        );
        assert.equal(
            await assertPathOutsideRoot(path.join(base, 'safe', 'future-live.json'), repositoryRoot),
            path.join(await realpath(base), 'safe', 'future-live.json'),
        );
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});


test('missing pages and navigation use English; adding a translation removes its temporary redirects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docs-fallback-'));
    try {
        await writeFile(path.join(root, 'index.mdx'), '# English');
        const locales = registry('live');
        locales.locales[1].pathPrefix = 'es';
        const navigation = spanishNavigation();
        delete navigation.navigation.tabs[0].tab;
        const fallback = buildDeployConfig(sourceConfig(), locales, { es: navigation }, root);
        assert.equal(fallback.navigation.languages[1].tabs[0].tab, 'Guides');
        assert.deepEqual(fallback.navigation.languages[1].tabs[0].groups[0].pages, ['index']);
        assert.ok(fallback.redirects.some(({ source, destination, permanent }) => source === '/es/index' && destination === '/index' && permanent === false));
        assert.ok(fallback.redirects.some(({ source, destination }) => source === '/es' && destination === '/'));
        const missingNavigation = buildDeployConfig(sourceConfig(), locales, {}, root);
        assert.equal(missingNavigation.navigation.languages[1].tabs[0].tab, 'Guides');
        await mkdir(path.join(root, 'es'));
        await writeFile(path.join(root, 'es/index.mdx'), '# Español');
        const restored = buildDeployConfig(fallback, locales, { es: spanishNavigation() }, root);
        assert.equal(restored.redirects, undefined);
        assert.deepEqual(restored.navigation.languages[1].tabs[0].groups[0].pages, ['es/index']);
        locales.locales[1].stage = 'planned';
        const hidden = buildDeployConfig(restored, locales, { es: spanishNavigation() }, root);
        assert.equal(hidden.navigation.languages, undefined);
        assert.ok(hidden.redirects.some(({ source, destination }) => source === '/es/index' && destination === '/index'));
    } finally { await rm(root, { recursive: true, force: true }); }
});
