#!/usr/bin/env node

import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDocsPublication } from './publication.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

async function canonicalPathForCreation(value) {
    let cursor = path.resolve(value);
    const missing = [];
    while (true) {
        try {
            const existing = await realpath(cursor);
            return path.join(existing, ...missing.reverse());
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
                throw error;
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) {
                throw error;
            }
            missing.push(path.basename(cursor));
            cursor = parent;
        }
    }
}

export async function assertPathOutsideRoot(value, root = repositoryRoot) {
    const [candidate, canonicalRoot] = await Promise.all([
        canonicalPathForCreation(value),
        realpath(root),
    ]);
    const relative = path.relative(canonicalRoot, candidate);
    const contained = relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
    );
    if (contained) {
        throw new Error('Output must resolve outside the docs repository, including through symlinks.');
    }
    return candidate;
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function canonicalJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function englishDocsConfig(value, sourceLocale = 'en') {
    const config = clone(value);
    const languages = config?.navigation?.languages;
    if (!Array.isArray(languages)) {
        return config;
    }
    const source = languages.find((entry) => entry?.language === sourceLocale);
    if (!isObject(source)) {
        throw new Error(`docs.json has no ${sourceLocale} source-language navigation entry.`);
    }
    const {
        language: _language,
        default: _default,
        navbar,
        footer,
        banner,
        ...navigation
    } = source;
    config.navigation = navigation;
    if (navbar === undefined) {
        delete config.navbar;
    } else {
        config.navbar = navbar;
    }
    if (footer !== undefined) {
        config.footer = footer;
    }
    if (banner !== undefined) {
        config.banner = banner;
    }
    return config;
}

function localeEntry(locale, navigation, fallbackConfig) {
    if (!isObject(navigation?.navigation) || !isObject(navigation?.navbar)) {
        throw new Error(`Localized navigation for ${locale.tag} is incomplete.`);
    }
    if (navigation.locale !== locale.tag || navigation.source !== 'docs.json') {
        throw new Error(`Localized navigation header for ${locale.tag} is invalid.`);
    }
    return {
        language: locale.tag,
        ...clone(navigation.navigation),
        navbar: clone(navigation.navbar),
        ...(fallbackConfig.footer === undefined ? {} : { footer: clone(fallbackConfig.footer) }),
        ...(fallbackConfig.banner === undefined ? {} : { banner: clone(fallbackConfig.banner) }),
    };
}

export function buildDeployConfig(currentConfig, registry, localizedNavigation = {}) {
    const sourceConfig = englishDocsConfig(currentConfig, registry.sourceLocale);
    const liveLocales = registry.locales.filter((locale) => locale.stage === 'live');
    const sourceLocale = liveLocales.find((locale) => locale.tag === registry.sourceLocale);
    if (!sourceLocale) {
        throw new Error('The source docs locale must remain live.');
    }
    if (liveLocales.length === 1) {
        return sourceConfig;
    }

    const sourceNavigation = {
        schemaVersion: 1,
        locale: registry.sourceLocale,
        source: 'docs.json',
        navigation: sourceConfig.navigation,
        navbar: sourceConfig.navbar,
    };
    const languages = liveLocales.map((locale, index) => {
        const navigation = locale.tag === registry.sourceLocale
            ? sourceNavigation
            : localizedNavigation[locale.tag];
        const entry = localeEntry(locale, navigation, sourceConfig);
        if (index === 0) {
            return { language: entry.language, default: true, ...Object.fromEntries(
                Object.entries(entry).filter(([key]) => key !== 'language'),
            ) };
        }
        return entry;
    });
    const output = clone(sourceConfig);
    output.navigation = { languages };
    delete output.navbar;
    delete output.banner;
    delete output.footer;
    return output;
}

export function registryWithFutureLiveLocale(registry, localeTag) {
    const output = clone(registry);
    const locale = output.locales.find((entry) => entry.tag === localeTag);
    if (!locale || locale.tag === output.sourceLocale) {
        throw new Error(`Cannot project unknown or source locale ${localeTag}.`);
    }
    locale.stage = 'live';
    locale.indexable = true;
    return output;
}

async function loadInputs() {
    const [rawConfig, rawRegistry, rawSpanish] = await Promise.all([
        readFile(path.join(repositoryRoot, 'docs.json'), 'utf8'),
        readFile(path.join(internalDirectory, 'locales.generated.json'), 'utf8'),
        readFile(path.join(internalDirectory, 'navigation.es.json'), 'utf8'),
    ]);
    return {
        rawConfig,
        config: JSON.parse(rawConfig),
        registry: JSON.parse(rawRegistry),
        localizedNavigation: { es: JSON.parse(rawSpanish) },
    };
}

async function writeAtomic(output, content, { outsideRoot = null } = {}) {
    if (outsideRoot) {
        await assertPathOutsideRoot(output, outsideRoot);
    }
    await mkdir(path.dirname(output), { recursive: true });
    if (outsideRoot) {
        await assertPathOutsideRoot(output, outsideRoot);
    }
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    if (outsideRoot) {
        await assertPathOutsideRoot(output, outsideRoot);
    }
    await rename(temporary, output);
}

function parseArguments(argv) {
    const [command, ...rest] = argv;
    const options = { command, output: null, futureLive: null };
    for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--output') {
            options.output = path.resolve(rest[++index]);
        } else if (rest[index] === '--future-live') {
            options.futureLive = rest[++index];
        } else {
            throw new Error(`Unknown argument: ${rest[index]}`);
        }
    }
    return options;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const inputs = await loadInputs();
    inputs.registry = await loadDocsPublication(repositoryRoot, inputs.registry);
    if (options.command === 'check') {
        if (options.output || options.futureLive) {
            throw new Error('check does not accept generation options.');
        }
        const expected = canonicalJson(buildDeployConfig(
            inputs.config,
            inputs.registry,
            inputs.localizedNavigation,
        ));
        if (inputs.rawConfig !== expected) {
            throw new Error('docs.json is stale for the current registry stage; generate the deploy config.');
        }
        console.log('Docs deploy config matches the current locale stages.');
        return;
    }
    if (options.command !== 'generate' || !options.output) {
        throw new Error('Usage: deploy-config.mjs check | generate --output PATH [--future-live es]');
    }
    let registry = inputs.registry;
    if (options.futureLive) {
        registry = registryWithFutureLiveLocale(registry, options.futureLive);
        await assertPathOutsideRoot(options.output, repositoryRoot);
    }
    const output = canonicalJson(buildDeployConfig(inputs.config, registry, inputs.localizedNavigation));
    await writeAtomic(options.output, output, {
        outsideRoot: options.futureLive ? repositoryRoot : null,
    });
    console.log(`Generated docs deploy config: ${options.output}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
    await main();
}
