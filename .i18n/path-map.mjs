#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { englishMdxInventory, localizeDocsTarget } from './content.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

export function localizeMdxPaths(text, locale = 'es') {
    let localized = text.replace(
        /(\bfrom\s+['"])(\/[^'"]+)(['"])/g,
        (match, before, target, after) => `${before}${localizeDocsTarget(target, locale)}${after}`,
    );
    localized = localized.replace(
        /(\]\()((?:\/)[^\s)]+)(\))/g,
        (match, before, target, after) => `${before}${localizeDocsTarget(target, locale)}${after}`,
    );
    localized = localized.replace(
        /(\b(?:href|to|path)=['"])(\/[^'"]+)(['"])/g,
        (match, before, target, after) => `${before}${localizeDocsTarget(target, locale)}${after}`,
    );
    return localized;
}

export function localizeNavigationPaths(value, locale = 'es', key = '') {
    if (Array.isArray(value)) {
        return value.map((child) => {
            if (key === 'pages' && typeof child === 'string') {
                return child.startsWith(`${locale}/`) ? child : `${locale}/${child}`;
            }
            return localizeNavigationPaths(child, locale);
        });
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
            childKey,
            localizeNavigationPaths(child, locale, childKey),
        ]));
    }
    return value;
}

export async function applyPathMap(root = repositoryRoot, locale = 'es') {
    for (const relativePath of await englishMdxInventory(root)) {
        const translationPath = path.join(root, locale, relativePath);
        const current = await readFile(translationPath, 'utf8');
        const localized = localizeMdxPaths(current, locale);
        if (localized !== current) {
            await writeFile(translationPath, localized, 'utf8');
        }
    }

    const navigationPath = path.join(root, '.i18n/navigation.es.json');
    const navigation = JSON.parse(await readFile(navigationPath, 'utf8'));
    navigation.navigation = localizeNavigationPaths(navigation.navigation, locale);
    navigation.navbar = localizeNavigationPaths(navigation.navbar, locale);
    await writeFile(navigationPath, `${JSON.stringify(navigation, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== 'apply' || process.argv.length !== 3) {
        throw new Error('Usage: node .i18n/path-map.mjs apply');
    }
    await applyPathMap();
    console.log('Applied deterministic Spanish docs path mapping.');
}
