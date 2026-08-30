import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    expectedEnglishLocale,
    expectedPseudoLocale,
    findLocalizedPublicPaths,
    findLocalizedNavigationValues,
    findNavigationLanguageKeys,
    findTextExposure,
    validateRegistry,
} from './check.mjs';

const promptSha256 = 'a'.repeat(64);
const spanishGuideSha256 = 'b'.repeat(64);
const expectedSpanishPilot = {
    tag: 'es',
    englishName: 'Spanish',
    nativeName: 'Español',
    direction: 'ltr',
    fallback: 'en',
    pathPrefix: 'es',
    stage: 'planned',
    indexable: false,
};

function pilotRegistry() {
    return {
        schemaVersion: 1,
        sourceLocale: 'en',
        defaultLocale: 'en',
        defaultFormatLocale: 'en-US',
        urlPolicy: { prefixDefaultLocale: false },
        translation: {
            promptPath: 'prompt-v2.txt',
            promptSha256,
            guides: {
                es: {
                    path: 'es-style-v1.md',
                    sha256: spanishGuideSha256,
                },
            },
        },
        locales: [
            { ...expectedEnglishLocale },
            { ...expectedSpanishPilot },
        ],
        testLocales: [{ ...expectedPseudoLocale }],
    };
}

function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

test('committed hidden registry satisfies the Spanish pilot contract', async () => {
    const raw = await readFile(new URL('./locales.generated.json', import.meta.url), 'utf8');
    assert.deepEqual(validateRegistry(JSON.parse(raw), raw), []);
});

test('planned Spanish cannot become live or indexable in docs', () => {
    const live = pilotRegistry();
    live.locales[1].stage = 'live';
    live.locales[1].indexable = true;
    const errors = validateRegistry(live, canonicalJson(live));
    assert(errors.some((error) => error.includes('planned, non-indexable')));
    assert(errors.some((error) => error.includes('sole live')));
    assert(errors.some((error) => error.includes('sole indexable')));
});

test('a synthetic second planned locale remains hidden, non-indexable, and route-guarded', () => {
    const registry = pilotRegistry();
    registry.locales.push({
        tag: 'de',
        englishName: 'German',
        nativeName: 'Deutsch',
        direction: 'ltr',
        fallback: 'en',
        pathPrefix: 'de',
        stage: 'planned',
        indexable: false,
    });
    registry.translation.guides.de = {
        path: 'de-style-v1.md',
        sha256: 'a'.repeat(64),
    };

    assert.deepEqual(validateRegistry(registry, canonicalJson(registry)), []);
    assert.deepEqual(findTextExposure('Read /de/guides/start.', 'page.mdx', registry), [
        'page.mdx: /de',
    ]);

    registry.locales[2].stage = 'live';
    registry.locales[2].indexable = true;
    const exposedErrors = validateRegistry(registry, canonicalJson(registry));
    assert(exposedErrors.some((error) => error.includes('planned, non-indexable')));
    assert(exposedErrors.some((error) => error.includes('sole live')));
    assert(exposedErrors.some((error) => error.includes('sole indexable')));
});

test('translation metadata is generic and complete for every managed locale', () => {
    const registry = pilotRegistry();
    delete registry.translation.guides.es;
    assert(
        validateRegistry(registry, canonicalJson(registry))
            .some((error) => error.includes('Every managed non-source locale')),
    );

    registry.translation.guides.es = {
        path: 'es-style-v1.md',
        sha256: 'not-a-hash',
    };
    assert(
        validateRegistry(registry, canonicalJson(registry))
            .some((error) => error.includes('translation.guides.es.sha256')),
    );
});

test('top-level route guard detects any locale-shaped public directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-i18n-'));
    try {
        await mkdir(path.join(root, 'guides'));
        await mkdir(path.join(root, 'de'));
        assert.deepEqual(await findLocalizedPublicPaths(root), ['de']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('registry serialization is deterministic', () => {
    const registry = pilotRegistry();
    assert.deepEqual(validateRegistry(registry, canonicalJson(registry)), []);
    assert(validateRegistry(registry, JSON.stringify(registry)).some((error) => error.includes('canonical two-space JSON')));
});

test('navigation guard finds language selectors and localized values', () => {
    const navigation = {
        languages: [{ language: 'English' }, { language: 'Spanish' }],
        tabs: [{ pages: ['guides/start', 'es/guides/start'], href: '/en-XA/test' }],
    };
    assert.deepEqual(findNavigationLanguageKeys(navigation), ['navigation.languages']);
    assert.deepEqual(findLocalizedNavigationValues(navigation), [
        'navigation.tabs.0.pages.1: es/guides/start',
        'navigation.tabs.0.href: /en-XA/test',
    ]);
});

test('content guard finds localized routes, hreflang, and pseudolocale names', () => {
    const registry = pilotRegistry();
    assert.deepEqual(findTextExposure('<a href="/es/guia" hreflang="es">', 'page.mdx', registry), [
        'page.mdx: hreflang',
        'page.mdx: /es',
    ]);
    assert.deepEqual(findTextExposure('Never show en-XA at /en-XA/test.', 'page.mdx', registry), [
        'page.mdx: /en-XA',
        'page.mdx: pseudolocale en-XA',
    ]);
    assert.deepEqual(findTextExposure('See /essentials/settings.', 'page.mdx', registry), []);
});
