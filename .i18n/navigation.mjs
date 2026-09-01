import { documentProtectedStructureSha256, protectedTokens } from './content-segments.mjs';
import { sha256 } from './content-structure.mjs';

const labelKeys = new Set(['anchor', 'group', 'label', 'tab']);

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function prettyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function docsNavigationSource(value) {
    const projection = {
        schemaVersion: 1,
        locale: 'en',
        source: 'docs.json',
        navigation: value?.navigation,
        navbar: value?.navbar,
    };
    if (!isObject(projection.navigation) || !isObject(projection.navbar)) {
        throw new Error('docs.json must contain navigation and navbar objects.');
    }
    return prettyJson(projection);
}

export function navigationLabelSpans(value) {
    JSON.parse(value);
    const spans = [];
    const pattern = /"(anchor|group|label|tab)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    for (const match of value.matchAll(pattern)) {
        const start = match.index + match[0].indexOf(match[2]);
        spans.push({ kind: `navigation-${match[1]}`, start, end: start + match[2].length });
    }
    return spans;
}

export function extractNavigationSegments(value) {
    const occurrences = new Map();
    return navigationLabelSpans(value).map((span) => {
        const text = value.slice(span.start, span.end);
        const sourceSha256 = sha256(text);
        const occurrenceKey = `${span.kind}:${sourceSha256}`;
        const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
        occurrences.set(occurrenceKey, occurrence);
        const tokens = protectedTokens(text);
        return {
            kind: span.kind,
            protectedStructureSha256: sha256(tokens.join('\n')),
            stableId: `${span.kind}:${sourceSha256.slice(0, 20)}:${occurrence}`,
            start: span.start,
            end: span.end,
            text,
        };
    });
}

function mapPages(value, locale, inverse) {
    if (Array.isArray(value)) {
        return value.map((child) => mapPages(child, locale, inverse));
    }
    if (!isObject(value)) {
        return value;
    }
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'pages' && Array.isArray(child)) {
            output[key] = child.map((page) => {
                if (typeof page !== 'string') {
                    return mapPages(page, locale, inverse);
                }
                if (inverse && page.startsWith(`${locale}/`)) {
                    return page.slice(locale.length + 1);
                }
                if (!inverse && !page.startsWith(`${locale}/`)) {
                    return `${locale}/${page}`;
                }
                return page;
            });
        } else {
            output[key] = mapPages(child, locale, inverse);
        }
    }
    return output;
}

export function mapDocsNavigation(value, locale, inverse = false) {
    const parsed = JSON.parse(value);
    if (!isObject(parsed)) {
        throw new Error('Docs navigation JSON root must be an object.');
    }
    const expectedLocale = inverse ? locale : 'en';
    if (parsed.schemaVersion !== 1 || parsed.source !== 'docs.json' || parsed.locale !== expectedLocale) {
        throw new Error('Docs navigation header changed.');
    }
    parsed.locale = inverse ? 'en' : locale;
    parsed.navigation = mapPages(parsed.navigation, locale, inverse);
    return prettyJson(parsed);
}

function skeleton(value, segments) {
    let output = value;
    for (const [index, segment] of Array.from(segments.entries()).reverse()) {
        output = `${output.slice(0, segment.start)}\0SEGMENT-${index}\0${output.slice(segment.end)}`;
    }
    return output;
}

export function expectedNavigationRecord(sourceConfig, translationText, metadata) {
    const sourceText = docsNavigationSource(sourceConfig);
    let comparableTranslation;
    try {
        comparableTranslation = mapDocsNavigation(translationText, 'es', true);
    } catch {
        comparableTranslation = null;
    }
    const sourceSegments = extractNavigationSegments(sourceText);
    const translationSegments = comparableTranslation === null
        ? []
        : extractNavigationSegments(comparableTranslation);
    const compatible = comparableTranslation !== null
        && sourceSegments.length === translationSegments.length
        && skeleton(sourceText, sourceSegments) === skeleton(comparableTranslation, translationSegments)
        && mapDocsNavigation(comparableTranslation, 'es') === translationText
        && sourceSegments.every((segment, index) => (
            segment.kind === translationSegments[index].kind
            && segment.protectedStructureSha256 === translationSegments[index].protectedStructureSha256
        ));
    const segments = compatible ? sourceSegments.map((segment, index) => ({
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
        translationSha256: sha256(translationSegments[index].text),
    })) : null;
    return {
        contentClass: 'docs',
        contentId: 'docs:navigation',
        generatedAt: metadata.generatedAt,
        model: 'gpt-5.6-sol',
        promptSha256: metadata.promptSha256,
        protectedStructureSha256: documentProtectedStructureSha256(sourceSegments),
        provider: 'openai',
        publicPath: null,
        reviewStatus: 'machine',
        reviewer: null,
        segments,
        sourcePath: 'docs.json',
        sourceSha256: sha256(sourceText),
        styleGuideSha256: metadata.styleGuideSha256,
        translatedPath: '.i18n/navigation.es.json',
        translationSha256: sha256(translationText),
    };
}

export function navigationLabelKeys() {
    return new Set(labelKeys);
}
