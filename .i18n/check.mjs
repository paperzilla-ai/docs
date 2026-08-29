import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);
const registryPath = path.join(internalDirectory, 'locales.generated.json');
const docsConfigPath = path.join(repositoryRoot, 'docs.json');
const mintIgnorePath = path.join(repositoryRoot, '.mintignore');
const agentsPath = path.join(repositoryRoot, 'AGENTS.md');
const canonicalPlan = 'docs/multilingual/00-rollout-index.md';

const expectedRegistry = {
    schemaVersion: 1,
    sourceLocale: 'en',
    defaultLocale: 'en',
    defaultFormatLocale: 'en-US',
    urlPolicy: {
        prefixDefaultLocale: false,
    },
    locales: [
        {
            tag: 'en',
            englishName: 'English',
            nativeName: 'English',
            direction: 'ltr',
            fallback: null,
            pathPrefix: '',
            stage: 'live',
            indexable: true,
        },
    ],
    testLocales: [
        {
            tag: 'en-XA',
            kind: 'pseudo',
            direction: 'ltr',
            fallback: 'en',
        },
    ],
};

const errors = [];

function report(condition, message) {
    if (!condition) {
        errors.push(message);
    }
}

function isLocaleSegment(segment) {
    return /^[a-z]{2}(?:-(?:[A-Z][a-z]{3}|[A-Z]{2}|[0-9]{3}))*$/.test(segment);
}

function findNavigationLanguageKeys(value, location = 'navigation') {
    if (!value || typeof value !== 'object') {
        return [];
    }

    const matches = [];
    for (const [key, child] of Object.entries(value)) {
        const childLocation = `${location}.${key}`;
        if (key === 'languages') {
            matches.push(childLocation);
        }
        matches.push(...findNavigationLanguageKeys(child, childLocation));
    }
    return matches;
}

function isLocalizedPath(value) {
    const normalized = value.replace(/^\/+/, '');
    const firstSegment = normalized.split('/')[0];
    return isLocaleSegment(firstSegment);
}

function findLocalizedNavigationValues(value, location = 'navigation') {
    if (!value || typeof value !== 'object') {
        return [];
    }

    const matches = [];
    for (const [key, child] of Object.entries(value)) {
        const childLocation = `${location}.${key}`;
        if (key === 'pages' && Array.isArray(child)) {
            child.forEach((page, index) => {
                if (typeof page === 'string' && isLocalizedPath(page)) {
                    matches.push(`${childLocation}.${index}: ${page}`);
                }
            });
        }
        if (key === 'href' && typeof child === 'string' && isLocalizedPath(child)) {
            matches.push(`${childLocation}: ${child}`);
        }
        matches.push(...findLocalizedNavigationValues(child, childLocation));
    }
    return matches;
}

async function findLocalizedPublicPaths() {
    const entries = await readdir(repositoryRoot, { withFileTypes: true });
    return entries
        .filter((entry) => !entry.name.startsWith('.') && isLocaleSegment(entry.name))
        .map((entry) => entry.name)
        .sort();
}

async function main() {
    let rawRegistry;
    let registry;
    try {
        rawRegistry = await readFile(registryPath, 'utf8');
        registry = JSON.parse(rawRegistry);
    } catch (error) {
        errors.push(`Cannot read valid JSON from ${path.relative(repositoryRoot, registryPath)}: ${error.message}`);
        registry = null;
    }

    if (registry) {
        const expectedBytes = `${JSON.stringify(expectedRegistry, null, 2)}\n`;
        report(
            rawRegistry === expectedBytes,
            'The generated locale registry must match the approved Foundation contract byte-for-byte (two-space JSON with a final newline).',
        );

        const publicLocales = Array.isArray(registry.locales) ? registry.locales : [];
        const liveLocales = publicLocales.filter((locale) => locale.stage === 'live');
        const indexableLocales = publicLocales.filter((locale) => locale.indexable === true);
        report(
            publicLocales.length === 1 && publicLocales[0]?.tag === 'en',
            'English must be the sole public locale during Foundation.',
        );
        report(
            liveLocales.length === 1 && liveLocales[0]?.tag === 'en',
            'English must be the sole live locale during Foundation.',
        );
        report(
            indexableLocales.length === 1 && indexableLocales[0]?.tag === 'en',
            'English must be the sole indexable locale during Foundation.',
        );

        const testLocales = Array.isArray(registry.testLocales) ? registry.testLocales : [];
        const pseudoLocale = testLocales.find((locale) => locale.tag === 'en-XA');
        report(
            Boolean(pseudoLocale) && pseudoLocale.kind === 'pseudo' && pseudoLocale.fallback === 'en',
            'en-XA must exist only as an English-fallback pseudolocale.',
        );
        report(
            !publicLocales.some((locale) => locale.tag === 'en-XA'),
            'en-XA must remain test-only and must not appear in the public locale list.',
        );
    }

    let docsConfig;
    try {
        docsConfig = JSON.parse(await readFile(docsConfigPath, 'utf8'));
    } catch (error) {
        errors.push(`Cannot read valid docs.json: ${error.message}`);
        docsConfig = null;
    }

    if (docsConfig) {
        const languageKeys = findNavigationLanguageKeys(docsConfig.navigation);
        report(
            languageKeys.length === 0,
            `Foundation must not expose a Mintlify language selector; found ${languageKeys.join(', ')}.`,
        );

        const localizedNavigationValues = findLocalizedNavigationValues(docsConfig.navigation);
        report(
            localizedNavigationValues.length === 0,
            `Foundation navigation must not reference localized public paths; found ${localizedNavigationValues.join(', ')}.`,
        );
    }

    const localizedPublicPaths = await findLocalizedPublicPaths();
    report(
        localizedPublicPaths.length === 0,
        `Foundation must not contain top-level localized public paths; found ${localizedPublicPaths.join(', ')}.`,
    );

    const mintIgnore = await readFile(mintIgnorePath, 'utf8');
    report(
        mintIgnore.split(/\r?\n/).includes('.i18n/'),
        '.mintignore must exclude the internal .i18n/ directory.',
    );
    report(
        mintIgnore.split(/\r?\n/).includes('AGENTS.md'),
        '.mintignore must exclude internal AGENTS.md instructions.',
    );

    const agents = await readFile(agentsPath, 'utf8');
    report(
        agents.includes(canonicalPlan),
        `AGENTS.md must point to the canonical backend plan at ${canonicalPlan}.`,
    );

    if (errors.length > 0) {
        console.error('Multilingual Foundation check failed:');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Multilingual Foundation check passed.');
}

await main();
