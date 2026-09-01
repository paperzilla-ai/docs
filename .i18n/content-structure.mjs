import { createHash } from 'node:crypto';

const translatableFrontmatterKeys = new Set(['title', 'sidebarTitle', 'name', 'description', 'keywords']);
const translatableJsxAttributes = new Set([
    'alt',
    'caption',
    'description',
    'label',
    'placeholder',
    'summary',
    'title',
]);

function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeNfc(text) {
    return text.replace(/\r\n/g, '\n').normalize('NFC');
}

export function sha256(text) {
    return createHash('sha256').update(normalizeNfc(text), 'utf8').digest('hex');
}

export function localizeDocsTarget(target, locale = 'es') {
    if (typeof target !== 'string') {
        return target;
    }
    const internalRoots = [
        '/answers',
        '/api-reference',
        '/guides',
        '/quickstart',
        '/snippets',
        '/what-is-paperzilla',
        '/index',
    ];
    const suffixStart = Math.min(
        ...['?', '#'].map((marker) => target.indexOf(marker)).filter((index) => index >= 0),
        target.length,
    );
    const route = target.slice(0, suffixStart);
    const suffix = target.slice(suffixStart);
    if (route === '/' || route === '/index') {
        return `/${locale}${suffix}`;
    }
    if (internalRoots.some((root) => route === root || route.startsWith(`${root}/`))) {
        return `/${locale}${target}`;
    }
    return target;
}

export function delocalizeDocsTarget(target, locale = 'es') {
    if (target === `/${locale}`) {
        return '/';
    }
    return typeof target === 'string' && target.startsWith(`/${locale}/`)
        ? target.slice(locale.length + 1)
        : target;
}

export function mapDocsPaths(text, locale = 'es', inverse = false) {
    const mapper = inverse ? delocalizeDocsTarget : localizeDocsTarget;
    let output = text;
    for (const pattern of [
        /(\]\()([^\s)]+)(?=\))/g,
        /(\bfrom\s+['"])(\/[^'"]+)(?=['"])/g,
        /(\b(?:href|to|path)\s*=\s*['"])(\/[^'"]+)(?=['"])/g,
    ]) {
        output = output.replace(pattern, (match, prefix, target) => `${prefix}${mapper(target, locale)}`);
    }
    return output;
}

export function restoreDocsSourcePaths(text, source, locale = 'es') {
    const patterns = [
        /(\]\()(\/[^)\s]+)/g,
        /(\bfrom\s+['"])(\/[^'"]+)/g,
        /(\b(?:href|to|path)\s*=\s*['"])(\/[^'"]+)/g,
    ];
    function targets(value) {
        const found = [];
        for (const pattern of patterns) {
            for (const match of value.matchAll(pattern)) {
                const start = match.index + match[1].length;
                found.push({ start, end: start + match[2].length, target: match[2] });
            }
        }
        return found.sort((left, right) => left.start - right.start);
    }
    const sourceTargets = targets(source);
    const localizedTargets = targets(text);
    if (sourceTargets.length !== localizedTargets.length) {
        throw new Error('Docs internal path count changed.');
    }
    const replacements = [];
    for (const [index, localized] of localizedTargets.entries()) {
        const sourceTarget = sourceTargets[index].target;
        const expected = localizeDocsTarget(sourceTarget, locale);
        if (localized.target !== expected) {
            throw new Error(`Docs path mapping changed: expected ${expected}, found ${localized.target}.`);
        }
        replacements.push({ ...localized, target: sourceTarget });
    }
    let output = text;
    for (const replacement of replacements.reverse()) {
        output = `${output.slice(0, replacement.start)}${replacement.target}${output.slice(replacement.end)}`;
    }
    return output;
}

function frontmatterParts(text) {
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) {
        return { frontmatter: '', body: text };
    }
    return {
        frontmatter: match[1],
        body: text.slice(match[0].length),
    };
}

function frontmatterEntries(text) {
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) {
        if (text.startsWith('---\n')) {
            throw new Error('Unclosed docs frontmatter.');
        }
        return [];
    }
    if (match[1] === '') {
        return [];
    }
    const entries = [];
    const seen = new Set();
    for (const line of match[1].split('\n')) {
        const field = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
        if (!field) {
            throw new Error('Docs frontmatter must use one top-level key per line.');
        }
        if (seen.has(field[1])) {
            throw new Error(`Duplicate frontmatter key: ${field[1]}.`);
        }
        seen.add(field[1]);
        entries.push({ key: field[1], raw: field[2].trim() });
    }
    return entries;
}

function scalarShape(raw) {
    if (raw === '') {
        throw new Error('Empty frontmatter values are not supported.');
    }
    if (raw.startsWith('"') || raw.endsWith('"')) {
        if (!(raw.startsWith('"') && raw.endsWith('"'))) {
            throw new Error('Unterminated double-quoted YAML scalar.');
        }
        try {
            if (typeof JSON.parse(raw) !== 'string') {
                throw new Error('Quoted scalar is not a string.');
            }
        } catch (error) {
            throw new Error(`Invalid double-quoted YAML scalar: ${error.message}`);
        }
        return 'string';
    }
    if (raw.startsWith("'") || raw.endsWith("'")) {
        if (!(raw.startsWith("'") && raw.endsWith("'")) || !/^'(?:[^']|'')*'$/.test(raw)) {
            throw new Error('Invalid single-quoted YAML scalar.');
        }
        return 'string';
    }
    const hasStructuredBoundary = /^[\[{]/.test(raw) || /[\]}]$/.test(raw);
    if (hasStructuredBoundary) {
        if (!((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}')))) {
            throw new Error('Unbalanced structured YAML value.');
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Structured frontmatter values must use deterministic JSON syntax: ${error.message}`);
        }
        function shape(value) {
            if (Array.isArray(value)) {
                return ['list', ...value.map(shape)];
            }
            if (value && typeof value === 'object') {
                return ['object', ...Object.entries(value).map(([key, child]) => [key, shape(child)])];
            }
            return value === null ? 'null' : typeof value;
        }
        return shape(parsed);
    }
    if (/:\s/.test(raw) || /^[&*!|>]/.test(raw)) {
        throw new Error('Unsupported or malformed YAML scalar syntax.');
    }
    if (/^(?:true|false)$/i.test(raw)) {
        return 'boolean';
    }
    if (/^(?:null|~)$/i.test(raw)) {
        return 'null';
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) {
        return 'number';
    }
    return 'string';
}

export function validateFrontmatterPair(source, translation) {
    const errors = [];
    let sourceEntries;
    let translationEntries;
    try {
        sourceEntries = frontmatterEntries(source);
        translationEntries = frontmatterEntries(translation);
    } catch (error) {
        return [error.message];
    }
    const sourceKeys = sourceEntries.map((entry) => entry.key);
    const translationKeys = translationEntries.map((entry) => entry.key);
    if (JSON.stringify(sourceKeys) !== JSON.stringify(translationKeys)) {
        return ['Frontmatter keys or key order changed.'];
    }
    for (const [index, sourceEntry] of sourceEntries.entries()) {
        const translatedEntry = translationEntries[index];
        let sourceShape;
        let translationShape;
        try {
            sourceShape = scalarShape(sourceEntry.raw);
            translationShape = scalarShape(translatedEntry.raw);
        } catch (error) {
            errors.push(`${sourceEntry.key}: ${error.message}`);
            continue;
        }
        if (JSON.stringify(sourceShape) !== JSON.stringify(translationShape)) {
            errors.push(`Frontmatter value shape changed for ${sourceEntry.key}.`);
        }
        if (!translatableFrontmatterKeys.has(sourceEntry.key) && sourceEntry.raw !== translatedEntry.raw) {
            errors.push(`Invariant frontmatter changed for ${sourceEntry.key}.`);
        }
    }
    return errors;
}

function frontmatterStructure(frontmatter) {
    if (!frontmatter) {
        return [];
    }
    return frontmatter.split('\n').map((line) => {
        const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
        if (!match) {
            return line;
        }
        const [, key, value] = match;
        return translatableFrontmatterKeys.has(key) ? `${key}:<translated>` : `${key}:${value}`;
    });
}

function fencedBlocks(text) {
    return [...text.matchAll(/^(```+|~~~+)([^\n]*)\n[\s\S]*?^\1\s*$/gm)].map((match) => match[0]);
}

function imports(text) {
    return text.split('\n').filter((line) => /^\s*(?:import|export)\b/.test(line));
}

function markdownLinks(text) {
    const links = [];
    const pattern = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of text.matchAll(pattern)) {
        links.push(`${match[1] || 'link'}:${match[2]}`);
    }
    return links;
}

function inlineCode(text) {
    return [...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => match[0]);
}

function markdownShape(text) {
    return text.split('\n').map((line) => {
        const heading = line.match(/^(#{1,6})\s+/);
        if (heading) {
            return `heading:${heading[1].length}`;
        }
        const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+/);
        if (list) {
            return `list:${list[1].length}:${/\d/.test(list[2]) ? 'ordered' : 'unordered'}`;
        }
        if (/^\s*>/.test(line)) {
            return `quote:${line.match(/^\s*/)[0].length}`;
        }
        if (/^\s*\|.*\|\s*$/.test(line)) {
            return `table:${(line.match(/\|/g) ?? []).length}`;
        }
        if (line.trim() === '') {
            return 'blank';
        }
        return 'text';
    });
}

function jsxStructure(text) {
    const structures = [];
    const tagPattern = /<\/?([A-Za-z][A-Za-z0-9.]*)\b([^<>]*?)\/?>/g;
    for (const match of text.matchAll(tagPattern)) {
        const whole = match[0];
        const closing = whole.startsWith('</');
        const selfClosing = /\/\s*>$/.test(whole);
        const attributes = [];
        if (!closing) {
            const attributePattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|\{[^{}]*\}))?/g;
            for (const attribute of match[2].matchAll(attributePattern)) {
                const name = attribute[1];
                let value = attribute[2] ?? '<boolean>';
                if (translatableJsxAttributes.has(name) && /^(?:"[^"]*"|'[^']*')$/.test(value)) {
                    value = '<translated>';
                }
                attributes.push(`${name}=${value}`);
            }
        }
        structures.push({
            name: match[1],
            closing,
            selfClosing,
            attributes,
        });
    }
    return structures;
}

function rawDirectives(text) {
    return text.split('\n').filter((line) => /^\s*:::[A-Za-z]/.test(line));
}

export function protectedStructure(text) {
    const normalized = normalizeNfc(text);
    const { frontmatter, body } = frontmatterParts(normalized);
    return {
        frontmatter: frontmatterStructure(frontmatter),
        imports: imports(body),
        fencedBlocks: fencedBlocks(body),
        inlineCode: inlineCode(body),
        linkTargets: markdownLinks(body),
        jsx: jsxStructure(body),
        markdownShape: markdownShape(body),
        directives: rawDirectives(body),
    };
}

export function localizedProtectedStructure(text, locale = 'es') {
    const structure = protectedStructure(text);
    structure.imports = structure.imports.map((line) => line.replace(
        /(\bfrom\s+['"])(\/[^'"]+)(['"])/,
        (match, before, target, after) => `${before}${localizeDocsTarget(target, locale)}${after}`,
    ));
    structure.linkTargets = structure.linkTargets.map((entry) => {
        const separator = entry.indexOf(':');
        return `${entry.slice(0, separator + 1)}${localizeDocsTarget(entry.slice(separator + 1), locale)}`;
    });
    structure.jsx = structure.jsx.map((tag) => ({
        ...tag,
        attributes: tag.attributes.map((attribute) => {
            const separator = attribute.indexOf('=');
            if (separator === -1) {
                return attribute;
            }
            const name = attribute.slice(0, separator);
            const rawValue = attribute.slice(separator + 1);
            if (!['href', 'to', 'path'].includes(name) || !/^(?:"[^"]*"|'[^']*')$/.test(rawValue)) {
                return attribute;
            }
            const quote = rawValue[0];
            const target = rawValue.slice(1, -1);
            return `${name}=${quote}${localizeDocsTarget(target, locale)}${quote}`;
        }),
    }));
    return structure;
}

export function protectedStructureSha256(text) {
    return sha256(canonicalJson(protectedStructure(text)));
}

export function localizedProtectedStructureSha256(text, locale = 'es') {
    return sha256(canonicalJson(localizedProtectedStructure(text, locale)));
}
