import { sha256 } from './content-structure.mjs';
import { englishDocsConfig, withNavigationFallback } from './deploy-config.mjs';

const brands = [
    'Paperzilla', 'arXiv', 'bioRxiv', 'medRxiv', 'ChemRxiv', 'ChinaXiv',
    'PubMed', 'Google Scholar', 'Hugging Face', 'OpenClaw', 'Codex', 'Claude',
    'Microsoft Teams', 'Telegram', 'Slack', 'GitHub', 'MCP', 'RSS', 'Atom',
    'CLI', 'API', 'Intercom', 'Feedly', 'Miniflux', 'Reeder', 'JSON',
];

function protectedTokens(value) {
    const tokens = [];
    for (const line of value.split('\n')) {
        const marker = line.match(/^(\s*)(#{1,6}\s+|-!\s+|[-*+]\s+|\d+[.)]\s+|>\s*|---\s*$)/);
        if (marker) {
            tokens.push(marker[1] + marker[2]);
        }
        const directive = line.match(/^\s*(?:::[:\w-]*|!!!\s+\w+)/);
        if (directive) {
            tokens.push(directive[0]);
        }
        const stripped = line.trim();
        const pipeCount = [...stripped].filter((character) => character === '|').length;
        if (pipeCount >= 2 || (pipeCount > 0 && stripped.startsWith('|') && stripped.endsWith('|'))) {
            tokens.push(`TABLE:${pipeCount}:${Number(stripped.startsWith('|'))}:${Number(stripped.endsWith('|'))}`);
        }
    }
    const pattern = /```.*?```|~~~.*?~~~|`[^`\n]+`|\{[%{].*?[}%]\}|<\/?[A-Za-z][^>]*>|!?(?:\[[^\]]*\])\(([^)]+)\)|https?:\/\/[^\s)>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gs;
    for (const match of value.matchAll(pattern)) {
        tokens.push(match[1] ?? match[0]);
    }
    for (const match of value.matchAll(/\*\*|__|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g)) {
        tokens.push(match[0]);
    }
    for (const brand of brands) {
        const count = value.split(brand).length - 1;
        tokens.push(...Array(count).fill(brand));
    }
    return tokens;
}

const labelKeys = new Set(['anchor', 'group', 'label', 'tab']);

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function prettyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function docsNavigationSource(value) {
    const sourceConfig = englishDocsConfig(value);
    const projection = {
        schemaVersion: 1,
        locale: 'en',
        source: 'docs.json',
        navigation: sourceConfig?.navigation,
        navbar: sourceConfig?.navbar,
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
    return navigationLabelSpans(value).map((span) => {
        const text = value.slice(span.start, span.end);
        const tokens = protectedTokens(text);
        return {
            kind: span.kind,
            protectedStructureSha256: sha256(tokens.join('\n')),
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

export function validateNavigation(sourceConfig, translationText, locale = 'es') {
    const sourceText = docsNavigationSource(sourceConfig);
    let comparableTranslation;
    try {
        comparableTranslation = mapDocsNavigation(translationText, locale, true);
    } catch {
        comparableTranslation = null;
    }
    if (comparableTranslation !== null) comparableTranslation = prettyJson(withNavigationFallback(JSON.parse(sourceText), JSON.parse(comparableTranslation)));
    const sourceSegments = extractNavigationSegments(sourceText);
    const translationSegments = comparableTranslation === null
        ? []
        : extractNavigationSegments(comparableTranslation);
    const compatible = comparableTranslation !== null
        && sourceSegments.length === translationSegments.length
        && skeleton(sourceText, sourceSegments) === skeleton(comparableTranslation, translationSegments)
        && sourceSegments.every((segment, index) => (
            segment.kind === translationSegments[index].kind
            && segment.protectedStructureSha256 === translationSegments[index].protectedStructureSha256
        ));
    return compatible;
}

export function navigationLabelKeys() {
    return new Set(labelKeys);
}
