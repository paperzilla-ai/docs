import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    expectedEnglishLocale,
    expectedPseudoLocale,
    expectedSpanishPilot,
    findLocalizedNavigationValues,
    findNavigationLanguageKeys,
    findTextExposure,
    validateRegistry,
} from './check.mjs';

function pilotRegistry() {
    return {
        schemaVersion: 1,
        sourceLocale: 'en',
        defaultLocale: 'en',
        defaultFormatLocale: 'en-US',
        urlPolicy: { prefixDefaultLocale: false },
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
