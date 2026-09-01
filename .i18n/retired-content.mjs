import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { documentProtectedStructureSha256, extractSegments } from './content-segments.mjs';
import {
    mapDocsPaths,
    normalizeNfc,
    sha256,
    validateFrontmatterPair,
} from './content-structure.mjs';
import { extractNavigationSegments, mapDocsNavigation } from './navigation.mjs';
import { findFormalVoice } from './tone.mjs';

const recordKeys = [
    'contentClass', 'contentId', 'generatedAt', 'model', 'promptSha256',
    'protectedStructureSha256', 'provider', 'publicPath', 'reviewStatus', 'reviewer',
    'segments', 'sourcePath', 'sourceSha256', 'styleGuideSha256', 'translatedPath',
    'translationSha256',
];
const segmentKeys = [
    'generatedAt', 'id', 'model', 'promptSha256', 'protectedStructureSha256',
    'provider', 'reviewStatus', 'reviewer', 'sourceSha256', 'styleGuideSha256',
    'translationSha256',
];
const sha256Pattern = /^[a-f0-9]{64}$/;

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
    return isObject(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function report(errors, condition, message) {
    if (!condition) {
        errors.push(message);
    }
}

async function translatedMdxInventory(root, locale = 'es') {
    const localeRoot = path.join(root, locale);
    const files = [];
    async function visit(directory, prefix = '') {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const relative = path.posix.join(prefix, entry.name);
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(absolute, relative);
            } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
                files.push(relative);
            }
        }
    }
    await visit(localeRoot);
    return files;
}

function intendedPublicPath(relativePath) {
    const parts = relativePath.split('/');
    const filename = parts.at(-1);
    if (parts.some((part) => ['snippets', '_snippets', 'partials', '_partials'].includes(part))
        || filename.startsWith('_')) {
        return null;
    }
    const withoutExtension = relativePath.replace(/\.mdx$/, '');
    return withoutExtension === 'index' ? '/' : `/${withoutExtension.replace(/\/index$/, '')}`;
}

function validateFrozenMetadata(record, manifest, label, errors, validateProvenance) {
    report(errors, hasExactKeys(record, recordKeys), `${label} fields or field order differ from the content contract.`);
    if (!isObject(record)) {
        return;
    }
    for (const key of ['sourceSha256', 'translationSha256', 'protectedStructureSha256']) {
        report(errors, sha256Pattern.test(record[key] ?? ''), `${label}.${key} is invalid.`);
    }
    report(errors, record.promptSha256 === manifest.promptSha256, `${label}.promptSha256 differs from the frozen manifest.`);
    report(errors, record.styleGuideSha256 === manifest.styleGuideSha256, `${label}.styleGuideSha256 differs from the frozen manifest.`);
    validateProvenance(record, label, errors);
    report(errors, Array.isArray(record.segments), `${label}.segments must be an array.`);
    for (const [index, segment] of (Array.isArray(record.segments) ? record.segments : []).entries()) {
        const segmentLabel = `${label}.segments[${index}]`;
        report(errors, hasExactKeys(segment, segmentKeys), `${segmentLabel} fields or field order differ from the segment contract.`);
        report(errors, sha256Pattern.test(segment?.sourceSha256 ?? ''), `${segmentLabel}.sourceSha256 is invalid.`);
        report(errors, sha256Pattern.test(segment?.translationSha256 ?? ''), `${segmentLabel}.translationSha256 is invalid.`);
        report(errors, sha256Pattern.test(segment?.protectedStructureSha256 ?? ''), `${segmentLabel}.protectedStructureSha256 is invalid.`);
        report(errors, segment?.promptSha256 === manifest.promptSha256, `${segmentLabel}.promptSha256 differs from the frozen manifest.`);
        report(errors, segment?.styleGuideSha256 === manifest.styleGuideSha256, `${segmentLabel}.styleGuideSha256 differs from the frozen manifest.`);
        if (isObject(segment)) {
            validateProvenance(segment, segmentLabel, errors);
        }
    }
}

function validateFrozenSegments(record, segments, label, errors) {
    const recorded = Array.isArray(record?.segments) ? record.segments : [];
    report(errors, recorded.length === segments.length, `${label}.segments coverage differs from the frozen translation.`);
    for (const [index, segment] of segments.entries()) {
        const frozen = recorded[index];
        if (!frozen) {
            continue;
        }
        report(errors, frozen.id?.startsWith(`${segment.kind}:`), `${label}.segments[${index}].id kind is invalid.`);
        report(errors, frozen.translationSha256 === sha256(segment.text), `${label}.segments[${index}].translationSha256 is stale.`);
        report(
            errors,
            frozen.protectedStructureSha256 === segment.protectedStructureSha256,
            `${label}.segments[${index}].protectedStructureSha256 is stale.`,
        );
    }
    report(
        errors,
        record?.protectedStructureSha256 === documentProtectedStructureSha256(segments),
        `${label}.protectedStructureSha256 differs from the retained translation.`,
    );
}

export async function validateRetiredAuthoredContent({
    root,
    manifest,
    rawNavigation,
    validateProvenance,
}) {
    const errors = [];
    const documents = Array.isArray(manifest?.documents) ? manifest.documents : [];
    const navigationRecords = documents.filter((record) => record?.contentId === 'docs:navigation');
    const pageRecords = documents.filter((record) => record?.contentId !== 'docs:navigation');
    report(errors, navigationRecords.length === 1, 'Retired docs must retain exactly one docs:navigation record.');

    const sourcePaths = new Set();
    const translatedPaths = new Set();
    const expectedInventory = [];
    for (const [index, record] of pageRecords.entries()) {
        const label = `documents[${documents.indexOf(record)}]`;
        validateFrozenMetadata(record, manifest, label, errors, validateProvenance);
        const sourcePath = record?.sourcePath;
        const validSourcePath = typeof sourcePath === 'string'
            && sourcePath.endsWith('.mdx')
            && sourcePath === path.posix.normalize(sourcePath)
            && !sourcePath.startsWith('/')
            && !sourcePath.split('/').includes('..');
        report(errors, validSourcePath, `${label}.sourcePath is invalid for a retained document.`);
        if (!validSourcePath) {
            continue;
        }
        report(errors, !sourcePaths.has(sourcePath), `${label}.sourcePath is duplicated.`);
        sourcePaths.add(sourcePath);
        const translatedPath = `es/${sourcePath}`;
        report(errors, record.translatedPath === translatedPath, `${label}.translatedPath is invalid.`);
        report(errors, !translatedPaths.has(record.translatedPath), `${label}.translatedPath is duplicated.`);
        translatedPaths.add(record.translatedPath);
        report(errors, record.contentClass === 'docs', `${label}.contentClass must remain docs.`);
        report(errors, record.contentId === `docs:${sourcePath.replace(/\.mdx$/, '')}`, `${label}.contentId does not match its frozen path.`);
        report(errors, record.publicPath === intendedPublicPath(sourcePath), `${label}.publicPath does not match its frozen path.`);
        expectedInventory.push(sourcePath);

        try {
            const translation = await readFile(path.join(root, translatedPath), 'utf8');
            report(errors, translation === normalizeNfc(translation), `${translatedPath} must remain NFC UTF-8 with LF line endings.`);
            report(errors, translation.trim().length > 0, `${translatedPath} must not be empty.`);
            report(errors, record.translationSha256 === sha256(translation), `${label}.translationSha256 is stale.`);
            report(errors, findFormalVoice(translation).length === 0, `${translatedPath} no longer satisfies the neutral Spanish voice guard.`);
            for (const frontmatterError of validateFrontmatterPair(translation, translation)) {
                errors.push(`${translatedPath}: ${frontmatterError}`);
            }
            const comparable = mapDocsPaths(translation, 'es', true);
            validateFrozenSegments(record, extractSegments(comparable), label, errors);
        } catch (error) {
            errors.push(`${label} cannot read or validate its retained translation: ${error.message}`);
        }
    }

    let retainedInventory = [];
    try {
        retainedInventory = await translatedMdxInventory(root);
    } catch (error) {
        errors.push(`Cannot inventory retained es/: ${error.message}`);
    }
    report(
        errors,
        JSON.stringify(retainedInventory) === JSON.stringify(expectedInventory.sort()),
        'Retired Spanish MDX inventory must exactly match the frozen manifest, independent of current English.',
    );

    const navigationRecord = navigationRecords[0];
    if (navigationRecord) {
        const label = `documents[${documents.indexOf(navigationRecord)}]`;
        validateFrozenMetadata(navigationRecord, manifest, label, errors, validateProvenance);
        report(errors, navigationRecord.contentClass === 'docs', `${label}.contentClass must remain docs.`);
        report(errors, navigationRecord.sourcePath === 'docs.json', `${label}.sourcePath must remain docs.json.`);
        report(errors, navigationRecord.translatedPath === '.i18n/navigation.es.json', `${label}.translatedPath is invalid.`);
        report(errors, navigationRecord.publicPath === null, `${label}.publicPath must remain null.`);
        report(errors, navigationRecord.translationSha256 === sha256(rawNavigation), `${label}.translationSha256 is stale.`);
        try {
            const comparable = mapDocsNavigation(rawNavigation, 'es', true);
            report(errors, mapDocsNavigation(comparable, 'es') === rawNavigation, 'Retired Spanish navigation cannot round-trip safely.');
            validateFrozenSegments(navigationRecord, extractNavigationSegments(comparable), label, errors);
        } catch (error) {
            errors.push(`Cannot validate retained Spanish navigation: ${error.message}`);
        }
    }
    return errors;
}
