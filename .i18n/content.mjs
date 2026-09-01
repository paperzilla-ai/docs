import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFormalVoice } from './tone.mjs';
import {
    mapDocsPaths,
    localizedProtectedStructureSha256,
    normalizeNfc,
    protectedStructureSha256,
    restoreDocsSourcePaths,
    validateFrontmatterPair,
    sha256,
} from './content-structure.mjs';
import { documentProtectedStructureSha256, extractSegments } from './content-segments.mjs';
import { expectedNavigationRecord } from './navigation.mjs';
import { validateRetiredAuthoredContent } from './retired-content.mjs';

export {
    delocalizeDocsTarget,
    localizeDocsTarget,
    localizedProtectedStructure,
    localizedProtectedStructureSha256,
    normalizeNfc,
    protectedStructure,
    protectedStructureSha256,
    sha256,
} from './content-structure.mjs';
export { documentProtectedStructureSha256, extractSegments } from './content-segments.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.dirname(internalDirectory);

export const manifestPath = path.join(internalDirectory, 'content.manifest.json');
export const navigationPath = path.join(internalDirectory, 'navigation.es.json');
export const schemaPath = path.join(internalDirectory, 'content.schema.json');

const recordKeys = [
    'contentClass',
    'contentId',
    'generatedAt',
    'model',
    'promptSha256',
    'protectedStructureSha256',
    'provider',
    'publicPath',
    'reviewStatus',
    'reviewer',
    'segments',
    'sourcePath',
    'sourceSha256',
    'styleGuideSha256',
    'translatedPath',
    'translationSha256',
];
const segmentKeys = [
    'generatedAt',
    'id',
    'model',
    'promptSha256',
    'protectedStructureSha256',
    'provider',
    'reviewStatus',
    'reviewer',
    'sourceSha256',
    'styleGuideSha256',
    'translationSha256',
];
const manifestKeys = ['documents', 'locale', 'promptSha256', 'schemaVersion', 'styleGuideSha256'];
const sha256Pattern = /^[a-f0-9]{64}$/;
const generatedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const reviewerContactPattern = /(?:@|:\/\/|\bwww\.|\bmailto:|\btel:|\b(?:phone|mobile|whatsapp)\b|(?:\+?\d[\d(). -]{6,}\d))/i;

function reviewerLabelIsSafe(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80 || /[<>\r\n]/.test(value)) {
        return false;
    }
    return value.trim().length > 0 && !reviewerContactPattern.test(value);
}

function canonicalJson(value) {
    function sortKeys(item) {
        if (Array.isArray(item)) {
            return item.map(sortKeys);
        }
        if (isPlainObject(item)) {
            return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sortKeys(item[key])]));
        }
        return item;
    }
    return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
    return isPlainObject(value)
        && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function report(errors, condition, message) {
    if (!condition) {
        errors.push(message);
    }
}

async function walkMdx(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'es') {
            continue;
        }
        const relative = path.posix.join(prefix, entry.name);
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walkMdx(absolute, relative));
        } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
            files.push(relative);
        }
    }
    return files;
}

export async function englishMdxInventory(root = repositoryRoot) {
    return walkMdx(root);
}

async function translatedMdxInventory(root = repositoryRoot, locale = 'es') {
    const localeRoot = path.join(root, locale);
    const entries = await readdir(localeRoot, { withFileTypes: true });
    const files = [];
    async function visit(directory, prefix, children) {
        for (const entry of children.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const relative = path.posix.join(prefix, entry.name);
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(absolute, relative, await readdir(absolute, { withFileTypes: true }));
            } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
                files.push(relative);
            }
        }
    }
    await visit(localeRoot, '', entries);
    return files;
}


function expectedSegments(sourceText, translationText, metadata) {
    const source = extractSegments(sourceText);
    let comparableTranslation;
    try {
        comparableTranslation = restoreDocsSourcePaths(translationText, sourceText, 'es');
    } catch {
        return null;
    }
    const translation = extractSegments(comparableTranslation);
    if (source.length !== translation.length || source.some((segment, index) => (
        segment.kind !== translation[index].kind
        || segment.protectedStructureSha256 !== translation[index].protectedStructureSha256
    ))) {
        return null;
    }
    return source.map((segment, index) => ({
        generatedAt: metadata.generatedAt,
        id: segment.stableId,
        model: 'gpt-5.6-sol',
        promptSha256: metadata.promptSha256,
        protectedStructureSha256: segment.protectedStructureSha256,
        provider: 'openai',
        reviewStatus: 'machine',
        reviewer: null,
        sourceSha256: sha256(segment.text),
        styleGuideSha256: metadata.styleGuideSha256,
        translationSha256: sha256(translation[index].text),
    }));
}

function intendedPublicPath(relativePath) {
    const parts = relativePath.split('/');
    const filename = parts.at(-1);
    if (
        parts.some((part) => ['snippets', '_snippets', 'partials', '_partials'].includes(part))
        || filename.startsWith('_')
    ) {
        return null;
    }
    const withoutExtension = relativePath.replace(/\.mdx$/, '');
    if (withoutExtension === 'index') {
        return '/';
    }
    return `/${withoutExtension.replace(/\/index$/, '')}`;
}

export function expectedRecord(relativePath, sourceText, translationText, metadata) {
    const stem = relativePath.replace(/\.mdx$/, '');
    const sourceSegments = extractSegments(sourceText);
    return {
        contentClass: 'docs',
        contentId: `docs:${stem}`,
        generatedAt: metadata.generatedAt,
        model: 'gpt-5.6-sol',
        promptSha256: metadata.promptSha256,
        protectedStructureSha256: documentProtectedStructureSha256(sourceSegments),
        provider: 'openai',
        publicPath: intendedPublicPath(relativePath),
        reviewStatus: 'machine',
        reviewer: null,
        segments: expectedSegments(sourceText, translationText, metadata),
        sourcePath: relativePath,
        sourceSha256: sha256(sourceText),
        styleGuideSha256: metadata.styleGuideSha256,
        translatedPath: `es/${relativePath}`,
        translationSha256: sha256(translationText),
    };
}

function validateRecordContract(record, expected, label, errors) {
    report(errors, hasExactKeys(record, recordKeys), `${label} fields or field order differ from the Run 6 contract.`);
    if (!isPlainObject(record)) {
        return;
    }
    for (const key of ['sourceSha256', 'translationSha256', 'protectedStructureSha256']) {
        report(errors, sha256Pattern.test(record[key] ?? ''), `${label}.${key} is invalid.`);
    }
    validateProvenance(record, label, errors);
    report(errors, Array.isArray(record.segments), `${label}.segments must be an array.`);
    report(errors, Array.isArray(expected.segments), `${expected.translatedPath} must retain one-to-one segment structure.`);
    if (Array.isArray(record.segments)) {
        const segmentIds = new Set();
        report(errors, record.segments.length === (expected.segments?.length ?? -1), `${label}.segments coverage is stale or incomplete.`);
        for (const [index, segment] of record.segments.entries()) {
            const segmentLabel = `${label}.segments[${index}]`;
            report(errors, hasExactKeys(segment, segmentKeys), `${segmentLabel} fields or field order differ from the segment contract.`);
            report(errors, !segmentIds.has(segment?.id), `${segmentLabel}.id is duplicated in the document.`);
            segmentIds.add(segment?.id);
            validateProvenance(segment, segmentLabel, errors);
            const expectedSegment = expected.segments?.[index];
            for (const key of ['id', 'sourceSha256', 'translationSha256', 'protectedStructureSha256', 'promptSha256', 'styleGuideSha256']) {
                report(errors, segment?.[key] === expectedSegment?.[key], `${segmentLabel}.${key} is stale or invalid.`);
            }
        }
    }
    for (const key of [
        'contentId', 'contentClass', 'sourcePath', 'translatedPath', 'publicPath',
        'sourceSha256', 'translationSha256', 'protectedStructureSha256',
        'promptSha256', 'styleGuideSha256',
    ]) {
        report(errors, JSON.stringify(record[key]) === JSON.stringify(expected[key]), `${label}.${key} is stale or invalid.`);
    }
}

export function contentReviewSummary(manifest) {
    const documents = Array.isArray(manifest?.documents) ? manifest.documents : [];
    const segments = documents.flatMap((record) => (
        Array.isArray(record?.segments) ? record.segments : []
    ));
    const reviewedDocuments = documents.filter((record) => (
        record?.reviewStatus === 'human-reviewed'
        && reviewerLabelIsSafe(record?.reviewer)
    ));
    const reviewedSegments = segments.filter((segment) => (
        segment?.reviewStatus === 'human-reviewed'
        && reviewerLabelIsSafe(segment?.reviewer)
    ));
    return {
        documentCount: documents.length,
        reviewedDocumentCount: reviewedDocuments.length,
        segmentCount: segments.length,
        reviewedSegmentCount: reviewedSegments.length,
        promotionEligible: documents.length > 0
            && reviewedDocuments.length === documents.length
            && segments.length > 0
            && reviewedSegments.length === segments.length,
    };
}

export async function validateAuthoredContent(
    root = repositoryRoot,
    { requireHumanReview = false, sourceMode = 'current' } = {},
) {
    const errors = [];
    let manifest;
    let rawManifest;
    let docsConfig;
    let navigation;
    let rawNavigation = '';
    try {
        rawManifest = await readFile(path.join(root, '.i18n/content.manifest.json'), 'utf8');
        manifest = JSON.parse(rawManifest);
    } catch (error) {
        return [`Cannot read valid .i18n/content.manifest.json: ${error.message}`];
    }
    try {
        rawNavigation = await readFile(path.join(root, '.i18n/navigation.es.json'), 'utf8');
        navigation = JSON.parse(rawNavigation);
    } catch (error) {
        errors.push(`Cannot read Spanish docs navigation: ${error.message}`);
    }
    if (sourceMode === 'current') {
        try {
            docsConfig = JSON.parse(await readFile(path.join(root, 'docs.json'), 'utf8'));
        } catch (error) {
            errors.push(`Cannot read current docs navigation source: ${error.message}`);
        }
    } else if (sourceMode !== 'frozen') {
        errors.push(`Unknown authored-content source mode: ${sourceMode}.`);
    }
    if (rawNavigation !== '') {
        report(errors, rawNavigation === rawNavigation.normalize('NFC'), 'navigation.es.json must be NFC-normalized.');
        report(errors, !rawNavigation.includes('\r'), 'navigation.es.json must use LF-only line endings.');
    }

    report(errors, manifest?.schemaVersion === 1, 'Content manifest schemaVersion must be 1.');
    report(errors, manifest?.locale === 'es', 'Content manifest locale must be es.');
    report(errors, hasExactKeys(manifest, manifestKeys), 'Content manifest fields or field order differ from the canonical contract.');
    report(errors, sha256Pattern.test(manifest?.promptSha256 ?? ''), 'Content manifest promptSha256 is invalid.');
    report(errors, sha256Pattern.test(manifest?.styleGuideSha256 ?? ''), 'Content manifest styleGuideSha256 is invalid.');
    report(errors, Array.isArray(manifest?.documents), 'Content manifest documents must be an array.');
    report(errors, rawManifest === canonicalJson(manifest), 'Content manifest JSON must be canonical with a final newline.');

    if (requireHumanReview) {
        const review = contentReviewSummary(manifest);
        report(
            errors,
            review.promotionEligible,
            `Spanish docs require named human review before preview/live: ${review.reviewedDocumentCount}/${review.documentCount} documents and ${review.reviewedSegmentCount}/${review.segmentCount} segments are reviewed.`,
        );
    }
    if (sourceMode === 'frozen') {
        errors.push(...await validateRetiredAuthoredContent({
            root,
            manifest,
            rawNavigation,
            validateProvenance,
        }));
        return errors;
    }

    const english = await englishMdxInventory(root);
    let spanish = [];
    try {
        spanish = await translatedMdxInventory(root);
    } catch (error) {
        errors.push(`Cannot inventory es/: ${error.message}`);
    }
    report(errors, JSON.stringify(spanish) === JSON.stringify(english), 'English and Spanish MDX trees must have exact path parity.');
    const documents = Array.isArray(manifest?.documents) ? manifest.documents : [];
    report(errors, documents.length === english.length + 1, 'Manifest must contain one record per English MDX file plus docs:navigation.');
    const expectedIdentities = [
        ...english.map((relative) => ({
            contentId: `docs:${relative.replace(/\.mdx$/, '')}`,
            translatedPath: `es/${relative}`,
        })),
        { contentId: 'docs:navigation', translatedPath: '.i18n/navigation.es.json' },
    ].sort((left, right) => left.contentId.localeCompare(right.contentId));
    report(
        errors,
        JSON.stringify(documents.map((record) => ({ contentId: record?.contentId, translatedPath: record?.translatedPath })))
            === JSON.stringify(expectedIdentities),
        'Manifest record order and translation paths must exactly match the source-derived inventory.',
    );
    const ids = new Set();
    const indexedDocuments = new Map();
    for (const [index, record] of documents.entries()) {
        report(errors, !ids.has(record?.contentId), `documents[${index}].contentId is duplicated.`);
        ids.add(record?.contentId);
        indexedDocuments.set(record?.contentId, { index, record });
    }
    for (const relativePath of english) {
        const identity = `docs:${relativePath.replace(/\.mdx$/, '')}`;
        const { index = -1, record } = indexedDocuments.get(identity) ?? {};
        const label = `documents[${index}]`;

        let sourceText = '';
        let translationText = '';
        try {
            sourceText = await readFile(path.join(root, relativePath), 'utf8');
            translationText = await readFile(path.join(root, `es/${relativePath}`), 'utf8');
        } catch (error) {
            errors.push(`${label} cannot read its source pair: ${error.message}`);
            continue;
        }
        report(errors, sourceText === normalizeNfc(sourceText), `${relativePath} must be NFC UTF-8 with LF line endings.`);
        report(errors, translationText === normalizeNfc(translationText), `es/${relativePath} must be NFC UTF-8 with LF line endings.`);
        report(errors, translationText.trim().length > 0, `es/${relativePath} must not be empty.`);
        report(errors, sourceText !== translationText, `es/${relativePath} must not be an English copy.`);
        report(errors, findFormalVoice(translationText).length === 0, `es/${relativePath} must use neutral direct tú or impersonal Spanish, never formal usted/vosotros.`);
        for (const frontmatterError of validateFrontmatterPair(sourceText, translationText)) {
            errors.push(`es/${relativePath}: ${frontmatterError}`);
        }
        const expected = expectedRecord(relativePath, sourceText, translationText, {
            ...manifest,
            generatedAt: record?.generatedAt,
        });
        validateRecordContract(record, expected, label, errors);
        report(
            errors,
            protectedStructureSha256(translationText) === localizedProtectedStructureSha256(sourceText),
            `es/${relativePath} changed protected MDX/frontmatter/code/link/component structure.`,
        );
    }

    if (docsConfig && navigation) {
        const navigationEntry = indexedDocuments.get('docs:navigation') ?? {};
        const expected = expectedNavigationRecord(docsConfig, rawNavigation, {
            ...manifest,
            generatedAt: navigationEntry.record?.generatedAt,
        });
        validateRecordContract(
            navigationEntry.record,
            expected,
            `documents[${navigationEntry.index ?? -1}]`,
            errors,
        );
    }
    return errors;
}

function validateProvenance(value, label, errors) {
    const statuses = new Set(['machine', 'technical-approved', 'human-reviewed']);
    const providers = new Set(['openai', 'google', 'human']);
    report(errors, providers.has(value.provider), `${label}.provider is invalid.`);
    if (value.provider === 'human') {
        report(errors, value.model === null, `${label}.model must be null for human provenance.`);
        report(errors, value.reviewStatus === 'human-reviewed', `${label} human provenance must be human-reviewed.`);
    } else {
        report(errors, typeof value.model === 'string' && value.model.length > 0, `${label}.model is invalid.`);
    }
    report(errors, sha256Pattern.test(value.promptSha256 ?? ''), `${label}.promptSha256 is invalid.`);
    report(errors, sha256Pattern.test(value.styleGuideSha256 ?? ''), `${label}.styleGuideSha256 is invalid.`);
    report(errors, generatedAtPattern.test(value.generatedAt ?? ''), `${label}.generatedAt is invalid.`);
    report(errors, statuses.has(value.reviewStatus), `${label}.reviewStatus is invalid.`);
    if (value.reviewStatus === 'human-reviewed') {
        report(
            errors,
            reviewerLabelIsSafe(value.reviewer),
            `${label}.reviewer must be a stable non-contact label after human review.`,
        );
    } else {
        report(
            errors,
            value.reviewer === null || reviewerLabelIsSafe(value.reviewer),
            `${label}.reviewer must be null or a stable non-contact label.`,
        );
    }
}
