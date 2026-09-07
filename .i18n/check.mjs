import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAuthoredContent } from './content.mjs';
import { buildDeployConfig } from './deploy-config.mjs';
import { loadAndValidateLaunchReview } from './launch-review.mjs';
import { loadDocsPublication } from './publication.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);
const registryPath = path.join(internalDirectory, 'locales.generated.json');
const docsConfigPath = path.join(repositoryRoot, 'docs.json');
const mintIgnorePath = path.join(repositoryRoot, '.mintignore');
const agentsPath = path.join(repositoryRoot, 'AGENTS.md');
const canonicalPlan = 'docs/multilingual/00-rollout-index.md';

const rootKeys = [
    'schemaVersion',
    'sourceLocale',
    'defaultLocale',
    'defaultFormatLocale',
    'urlPolicy',
    'translation',
    'locales',
    'testLocales',
];
const translationKeys = ['promptPath', 'promptSha256', 'guides'];
const translationGuideKeys = ['path', 'sha256'];
const productionLocaleKeys = [
    'tag',
    'englishName',
    'nativeName',
    'direction',
    'fallback',
    'pathPrefix',
    'stage',
    'indexable',
];
const testLocaleKeys = ['tag', 'kind', 'direction', 'fallback'];
const stages = new Set(['planned', 'preview', 'live', 'retired']);
const directions = new Set(['ltr', 'rtl']);
const languageTagPattern = /^[A-Za-z]{2,8}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const guidanceFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const expectedEnglishLocale = {
    tag: 'en',
    englishName: 'English',
    nativeName: 'English',
    direction: 'ltr',
    fallback: null,
    pathPrefix: '',
    stage: 'live',
    indexable: true,
};

export const expectedPseudoLocale = {
    tag: 'en-XA',
    kind: 'pseudo',
    direction: 'ltr',
    fallback: 'en',
};

export function authoredContentOptionsForLocale(registry, localeTag = 'es') {
    const locale = registry?.locales?.find((entry) => entry?.tag === localeTag);
    return {
        requireHumanReview: ['preview', 'live', 'retired'].includes(locale?.stage),
        sourceMode: locale?.stage === 'retired' ? 'frozen' : 'current',
    };
}

function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
    return isPlainObject(value)
        && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function matchesExpected(value, expected) {
    return JSON.stringify(value) === JSON.stringify(expected);
}

function report(errors, condition, message) {
    if (!condition) {
        errors.push(message);
    }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isLocaleSegment(segment) {
    return /^[a-z]{2}(?:-(?:[A-Z][a-z]{3}|[A-Z]{2}|[0-9]{3}))*$/.test(segment);
}

export function findNavigationLanguageKeys(value, location = 'navigation') {
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

export function findLocalizedNavigationValues(value, location = 'navigation') {
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

export function validateRegistry(registry, rawRegistry) {
    const errors = [];
    if (!isPlainObject(registry)) {
        return ['The generated locale registry root must be an object.'];
    }

    report(
        errors,
        hasExactKeys(registry, rootKeys),
        'The generated locale registry fields or field order differ from the canonical contract.',
    );
    report(errors, registry.schemaVersion === 1, 'The locale registry schemaVersion must be 1.');
    report(errors, registry.sourceLocale === 'en', 'English must remain the source locale.');
    report(errors, registry.defaultLocale === 'en', 'English must remain the default locale.');
    report(errors, registry.defaultFormatLocale === 'en-US', 'en-US must remain the default format locale.');
    report(
        errors,
        matchesExpected(registry.urlPolicy, { prefixDefaultLocale: false }),
        'Existing English documentation URLs must remain unprefixed.',
    );

    const translation = isPlainObject(registry.translation) ? registry.translation : {};
    report(
        errors,
        hasExactKeys(translation, translationKeys),
        'Translation metadata differs from the canonical contract.',
    );
    report(
        errors,
        typeof translation.promptPath === 'string' && guidanceFilePattern.test(translation.promptPath),
        'Translation metadata must identify the shared prompt path.',
    );
    report(
        errors,
        sha256Pattern.test(translation.promptSha256 ?? ''),
        'Translation metadata must contain the shared prompt SHA-256.',
    );
    const guides = isPlainObject(translation.guides) ? translation.guides : {};
    report(errors, isPlainObject(translation.guides), 'Translation guides must be an object keyed by locale.');
    for (const [tag, guide] of Object.entries(guides)) {
        const label = `translation.guides.${tag}`;
        report(errors, languageTagPattern.test(tag), `${label} has an invalid locale tag.`);
        report(errors, hasExactKeys(guide, translationGuideKeys), `${label} differs from the guide contract.`);
        if (!isPlainObject(guide)) {
            continue;
        }
        report(
            errors,
            typeof guide.path === 'string' && guidanceFilePattern.test(guide.path),
            `${label}.path is invalid.`,
        );
        report(errors, sha256Pattern.test(guide.sha256 ?? ''), `${label}.sha256 is invalid.`);
    }

    const locales = Array.isArray(registry.locales) ? registry.locales : [];
    report(errors, locales.length > 0, 'The locale registry must contain production locales.');
    const tags = new Set();
    const prefixes = new Set();
    for (const [index, locale] of locales.entries()) {
        const label = `locales[${index}]`;
        report(errors, hasExactKeys(locale, productionLocaleKeys), `${label} differs from the production-locale contract.`);
        if (!isPlainObject(locale)) {
            continue;
        }
        report(errors, typeof locale.tag === 'string' && languageTagPattern.test(locale.tag), `${label}.tag is invalid.`);
        report(errors, !tags.has(locale.tag), `${label}.tag duplicates ${locale.tag}.`);
        tags.add(locale.tag);
        report(errors, typeof locale.englishName === 'string' && locale.englishName.length > 0, `${label}.englishName is empty.`);
        report(errors, typeof locale.nativeName === 'string' && locale.nativeName.length > 0, `${label}.nativeName is empty.`);
        report(errors, directions.has(locale.direction), `${label}.direction must be ltr or rtl.`);
        report(errors, locale.fallback === null || typeof locale.fallback === 'string', `${label}.fallback is invalid.`);
        report(errors, stages.has(locale.stage), `${label}.stage is invalid.`);
        report(errors, typeof locale.indexable === 'boolean', `${label}.indexable must be boolean.`);
        report(
            errors,
            (locale.stage === 'live') === (locale.indexable === true),
            `${label} must be indexable exactly when it is live.`,
        );
        report(
            errors,
            typeof locale.pathPrefix === 'string' && /^(?:|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(locale.pathPrefix),
            `${label}.pathPrefix is invalid.`,
        );
        if (locale.pathPrefix) {
            report(errors, !prefixes.has(locale.pathPrefix), `${label}.pathPrefix duplicates ${locale.pathPrefix}.`);
            prefixes.add(locale.pathPrefix);
        }
    }

    for (const [index, locale] of locales.entries()) {
        if (isPlainObject(locale) && typeof locale.fallback === 'string') {
            report(errors, tags.has(locale.fallback), `locales[${index}].fallback is not a production locale.`);
        }
    }

    report(errors, matchesExpected(locales[0], expectedEnglishLocale), 'English must remain the first, live, indexable locale.');
    const managedNonSourceTags = locales
        .filter((locale) => locale?.tag !== registry.sourceLocale && locale?.stage !== 'retired')
        .map((locale) => locale.tag);
    report(
        errors,
        managedNonSourceTags.every((tag) => isPlainObject(guides[tag])),
        'Every managed non-source locale must have translation-guide metadata.',
    );
    report(
        errors,
        Object.keys(guides).every((tag) => tags.has(tag) && tag !== registry.sourceLocale),
        'Translation-guide metadata must reference registered non-source locales only.',
    );

    const testLocales = Array.isArray(registry.testLocales) ? registry.testLocales : [];
    report(
        errors,
        testLocales.length === 1 && hasExactKeys(testLocales[0], testLocaleKeys)
            && matchesExpected(testLocales[0], expectedPseudoLocale),
        'en-XA must remain the sole English-fallback pseudolocale.',
    );
    report(errors, !tags.has('en-XA'), 'en-XA must remain test-only and outside the production locale list.');
    if (typeof rawRegistry === 'string') {
        report(
            errors,
            rawRegistry === canonicalJson(registry),
            'The generated locale registry must use canonical two-space JSON with a final newline.',
        );
    }
    return errors;
}

export function findTextExposure(text, location, registry) {
    const matches = [];
    if (/\bhreflang\b/i.test(text)) {
        matches.push(`${location}: hreflang`);
    }

    const productionPrefixes = (registry?.locales ?? [])
        .filter((locale) => (
            locale?.tag !== registry?.defaultLocale
            && locale?.stage !== 'live'
            && locale?.pathPrefix
        ))
        .map((locale) => locale.pathPrefix);
    const testTags = (registry?.testLocales ?? []).map((locale) => locale?.tag).filter(Boolean);
    for (const prefix of [...new Set([...productionPrefixes, ...testTags])]) {
        const routePattern = new RegExp(`/${escapeRegex(prefix)}(?=$|[\\s/?#\"')>])`, 'i');
        if (routePattern.test(text)) {
            matches.push(`${location}: /${prefix}`);
        }
    }
    for (const tag of testTags) {
        const tagPattern = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegex(tag)}(?=$|[^A-Za-z0-9-])`, 'i');
        if (tagPattern.test(text)) {
            matches.push(`${location}: pseudolocale ${tag}`);
        }
    }
    return matches;
}

export function findMintIgnoreNegations(text) {
    return text.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('!'));
}

export async function findLocalizedPublicPaths(root = repositoryRoot) {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
        .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory() && isLocaleSegment(entry.name))
        .map((entry) => entry.name)
        .sort();
}

async function findPublicMdxFiles(directory = repositoryRoot, excludedTopLevel = new Set(), depth = 0) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        if (depth === 0 && excludedTopLevel.has(entry.name)) {
            continue;
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await findPublicMdxFiles(entryPath, excludedTopLevel, depth + 1));
        } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

async function main() {
    const errors = [];
    let rawRegistry = '';
    let registry = null;
    try {
        rawRegistry = await readFile(registryPath, 'utf8');
        registry = JSON.parse(rawRegistry);
        errors.push(...validateRegistry(registry, rawRegistry));
    } catch (error) {
        errors.push(`Cannot read valid JSON from ${path.relative(repositoryRoot, registryPath)}: ${error.message}`);
    }

    let rawDocsConfig = '';
    let docsConfig = null;
    try {
        rawDocsConfig = await readFile(docsConfigPath, 'utf8');
        docsConfig = JSON.parse(rawDocsConfig);
    } catch (error) {
        errors.push(`Cannot read valid docs.json: ${error.message}`);
    }

    let publicRegistry = registry;
    if (registry) {
        try {
            publicRegistry = await loadDocsPublication(repositoryRoot, registry);
        } catch (error) {
            errors.push(error.message);
        }
    }
    const liveNonSourceLocales = (publicRegistry?.locales ?? []).filter((locale) => (
        locale?.tag !== registry?.sourceLocale && locale?.stage === 'live'
    ));
    const hiddenNonSourceLocales = (publicRegistry?.locales ?? []).filter((locale) => (
        locale?.tag !== registry?.sourceLocale && locale?.stage !== 'live'
    ));
    const trackedNonSourceLocales = (registry?.locales ?? []).filter((locale) => (
        locale?.tag !== registry?.sourceLocale && locale?.pathPrefix
    ));

    if (docsConfig) {
        const languageKeys = findNavigationLanguageKeys(docsConfig.navigation);
        report(
            errors,
            liveNonSourceLocales.length > 0
                ? JSON.stringify(languageKeys) === JSON.stringify(['navigation.languages'])
                : languageKeys.length === 0,
            liveNonSourceLocales.length > 0
                ? `Live localized docs require exactly navigation.languages; found ${languageKeys.join(', ')}.`
                : `Planned, preview, and retired locales must not expose a Mintlify language selector; found ${languageKeys.join(', ')}.`,
        );

        const localizedNavigationValues = findLocalizedNavigationValues(docsConfig.navigation);
        report(
            errors,
            liveNonSourceLocales.length > 0 || localizedNavigationValues.length === 0,
            `Hidden docs navigation must not reference localized public paths; found ${localizedNavigationValues.join(', ')}.`,
        );

        if (registry) {
            const localizedNavigation = {};
            for (const locale of trackedNonSourceLocales) {
                try {
                    localizedNavigation[locale.tag] = JSON.parse(await readFile(
                        path.join(internalDirectory, `navigation.${locale.tag}.json`),
                        'utf8',
                    ));
                } catch (error) {
                    errors.push(`Cannot read localized navigation for ${locale.tag}: ${error.message}`);
                }
            }
            try {
                const expectedConfig = canonicalJson(buildDeployConfig(
                    docsConfig,
                    publicRegistry,
                    localizedNavigation,
                ));
                report(
                    errors,
                    rawDocsConfig === expectedConfig,
                    'docs.json is stale or does not exactly match the current registry stages.',
                );
            } catch (error) {
                errors.push(`Cannot derive the stage-aware docs config: ${error.message}`);
            }
        }
    }

    const localizedPublicPaths = await findLocalizedPublicPaths();
    const trackedPrefixes = trackedNonSourceLocales
        .map((locale) => locale.pathPrefix)
        .sort();
    report(
        errors,
        JSON.stringify(localizedPublicPaths) === JSON.stringify(trackedPrefixes),
        `Tracked locale trees must exactly match registered non-source locale prefixes; found ${localizedPublicPaths.join(', ')}.`,
    );

    if (registry) {
        errors.push(...findTextExposure(rawDocsConfig, 'docs.json', publicRegistry));
        const hiddenPrefixes = hiddenNonSourceLocales.map((locale) => locale.pathPrefix);
        for (const filePath of await findPublicMdxFiles(repositoryRoot, new Set(hiddenPrefixes))) {
            const relativePath = path.relative(repositoryRoot, filePath);
            const content = await readFile(filePath, 'utf8');
            errors.push(...findTextExposure(content, relativePath, publicRegistry));
        }
    }

    const mintIgnore = await readFile(mintIgnorePath, 'utf8');
    const mintIgnoreLines = mintIgnore.split(/\r?\n/);
    const mintIgnoreNegations = findMintIgnoreNegations(mintIgnore);
    report(errors, mintIgnoreLines.includes('.i18n/'), '.mintignore must exclude the internal .i18n/ directory.');
    report(errors, mintIgnoreLines.includes('AGENTS.md'), '.mintignore must exclude internal AGENTS.md instructions.');
    for (const locale of hiddenNonSourceLocales) {
        const prefix = locale.pathPrefix;
        const exactEntry = `${prefix}/`;
        report(
            errors,
            mintIgnoreLines.filter((line) => line === exactEntry).length === 1,
            `.mintignore must contain exactly one exact ${exactEntry} exclusion while ${prefix} is ${locale.stage}.`,
        );
    }
    for (const locale of liveNonSourceLocales) {
        const exactEntry = `${locale.pathPrefix}/`;
        report(
            errors,
            !mintIgnoreLines.includes(exactEntry),
            `.mintignore must not exclude live locale ${exactEntry}.`,
        );
    }
    report(
        errors,
        mintIgnoreNegations.length === 0,
        `.mintignore must not contain negation rules that can weaken locale exclusions; found ${mintIgnoreNegations.join(', ')}.`,
    );
    errors.push(...await validateAuthoredContent(
        repositoryRoot,
        authoredContentOptionsForLocale(registry),
    ));
    const launchReview = await loadAndValidateLaunchReview(repositoryRoot);
    errors.push(...launchReview.errors);

    const agents = await readFile(agentsPath, 'utf8');
    report(errors, agents.includes(canonicalPlan), `AGENTS.md must point to the canonical backend plan at ${canonicalPlan}.`);
    report(
        errors,
        agents.includes('do not create or use Git worktrees'),
        'AGENTS.md must require ordinary branches and prohibit Git worktrees.',
    );

    if (errors.length > 0) {
        console.error('Multilingual docs exposure check failed:');
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Multilingual docs exposure check passed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
    await main();
}
