import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDocsPublication, registryForDocsPublication } from './publication.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = JSON.parse(await readFile(new URL('./locales.generated.json', import.meta.url)));
const approval = JSON.parse(await readFile(new URL('./publication.json', import.meta.url)));
const hashes = {
    contentManifestSha256: approval.contentManifestSha256,
    registrySha256: approval.registrySha256,
};

test('docs-only approval publishes Spanish without mutating product/email stages', async () => {
    const before = structuredClone(registry);
    const projected = await loadDocsPublication(root, registry);
    assert.deepEqual(registry, before);
    assert.equal(registry.locales.find((locale) => locale.tag === 'es').stage, 'preview');
    assert.equal(projected.locales.find((locale) => locale.tag === 'es').stage, 'live');
    assert.equal(projected.locales.find((locale) => locale.tag === 'es').indexable, true);
    assert.deepEqual(projected.locales[0], registry.locales[0]);
    assert.deepEqual(projected.testLocales, registry.testLocales);
});

test('without explicit approval planned/preview/retired exposure remains unchanged', () => {
    for (const stage of ['planned', 'preview', 'retired']) {
        const value = structuredClone(registry);
        value.locales[1].stage = stage;
        assert.deepEqual(registryForDocsPublication(value, null, {}), value);
    }
});

test('stale content or registry approval fails closed', () => {
    for (const key of Object.keys(hashes)) {
        assert.throws(() => registryForDocsPublication(registry, approval, {
            ...hashes, [key]: '0'.repeat(64),
        }), /stale/);
    }
});

test('unknown fields, locale, scope or false human provenance cannot widen approval', () => {
    for (const mutation of [
        { extra: true }, { locale: 'de' }, { surface: 'email' },
        { approvedBy: 'Codex' }, { provenance: 'human-reviewed' },
        { approvedAt: 'invalid' }, { verification: 'skip' },
    ]) {
        assert.throws(() => registryForDocsPublication(registry, {
            ...approval, ...mutation,
        }, hashes), /Invalid/);
    }
});

test('publication approval cannot reactivate retired Spanish', () => {
    const retired = structuredClone(registry);
    retired.locales[1].stage = 'retired';
    assert.throws(() => registryForDocsPublication(retired, approval, hashes), /retired/);
});

test('publication preserves recorded review; the legacy machine-only decision remains readable', () => {
    for (const provenance of ['preserve-machine-status', 'preserve-recorded-status']) {
        assert.equal(registryForDocsPublication(registry, {
            ...approval, provenance,
        }, hashes).locales[1].stage, 'live');
    }
});
