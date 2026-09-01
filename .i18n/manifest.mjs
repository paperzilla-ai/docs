#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { englishMdxInventory, expectedRecord } from './content.mjs';
import { expectedNavigationRecord } from './navigation.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);
const outputPath = path.join(internalDirectory, 'content.manifest.json');

function canonicalJson(value) {
    function sortKeys(item) {
        if (Array.isArray(item)) {
            return item.map(sortKeys);
        }
        if (item && typeof item === 'object') {
            return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sortKeys(item[key])]));
        }
        return item;
    }
    return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

async function loadExisting(root) {
    const existingPath = path.join(root, '.i18n/content.manifest.json');
    try {
        const current = JSON.parse(await readFile(existingPath, 'utf8'));
        return new Map((current.documents ?? []).map((record) => [record.contentId, record]));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return new Map();
        }
        throw error;
    }
}

function provenance(record) {
    return Object.fromEntries([
        'generatedAt',
        'model',
        'provider',
        'reviewStatus',
        'reviewer',
    ].map((key) => [key, record[key]]));
}

function preserveProvenance(next, previous) {
    if (!previous) {
        return next;
    }
    const unchanged = [
        'sourceSha256',
        'translationSha256',
        'protectedStructureSha256',
        'promptSha256',
        'styleGuideSha256',
    ].every((key) => next[key] === previous[key]);
    if (!unchanged) {
        if (previous.reviewStatus === 'human-reviewed') {
            throw new Error(`Refusing to overwrite stale human-reviewed provenance: ${next.contentId ?? next.id}`);
        }
        return next;
    }
    return { ...next, ...provenance(previous) };
}

export async function buildManifest(generatedAt, root = repositoryRoot) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(generatedAt)) {
        throw new Error('--generated-at must be an ISO-8601 UTC timestamp without fractional seconds.');
    }
    const registry = JSON.parse(await readFile(path.join(root, '.i18n/locales.generated.json'), 'utf8'));
    const metadata = {
        generatedAt,
        promptSha256: registry.translation.promptSha256,
        styleGuideSha256: registry.translation.guides.es.sha256,
    };
    const existing = await loadExisting(root);
    const documents = [];
    function addRecord(next) {
        if (!Array.isArray(next.segments)) {
            throw new Error(`${next.translatedPath} does not retain one-to-one segment structure.`);
        }
        const previous = existing.get(next.contentId);
        const previousSegments = new Map((previous?.segments ?? []).map((segment) => [segment.id, segment]));
        next.segments = next.segments.map((segment) => preserveProvenance(segment, previousSegments.get(segment.id)));
        documents.push(preserveProvenance(next, previous));
    }
    for (const relativePath of await englishMdxInventory(root)) {
        const sourceText = await readFile(path.join(root, relativePath), 'utf8');
        const translationText = await readFile(path.join(root, 'es', relativePath), 'utf8');
        addRecord(expectedRecord(relativePath, sourceText, translationText, metadata));
    }
    const docsConfig = JSON.parse(await readFile(path.join(root, 'docs.json'), 'utf8'));
    const navigationText = await readFile(path.join(root, '.i18n/navigation.es.json'), 'utf8');
    addRecord(expectedNavigationRecord(docsConfig, navigationText, metadata));
    documents.sort((left, right) => left.contentId.localeCompare(right.contentId));
    const currentIds = new Set(documents.map((record) => record.contentId));
    const orphaned = [...existing.keys()].filter((contentId) => !currentIds.has(contentId));
    if (orphaned.length > 0) {
        throw new Error(`Orphaned authored-content provenance: ${orphaned.join(', ')}`);
    }
    return {
        documents,
        locale: 'es',
        promptSha256: metadata.promptSha256,
        schemaVersion: 1,
        styleGuideSha256: metadata.styleGuideSha256,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== 'generate' || process.argv[3] !== '--generated-at' || process.argv.length !== 5) {
        throw new Error('Usage: node .i18n/manifest.mjs generate --generated-at YYYY-MM-DDTHH:MM:SSZ');
    }
    const manifest = await buildManifest(process.argv[4]);
    await writeFile(outputPath, canonicalJson(manifest), 'utf8');
    console.log(`Wrote ${manifest.documents.length} docs records with per-segment provenance.`);
}
