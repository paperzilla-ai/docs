import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeNfc, protectedStructureSha256, localizedProtectedStructureSha256, validateFrontmatterPair } from './content-structure.mjs';
import { validateNavigation } from './navigation.mjs';
export * from './content-structure.mjs';
export const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function walkMdx(directory, prefix = '', excluded = new Set(['es'])) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || (prefix === '' && excluded.has(entry.name))) {
            continue;
        }
        const relative = path.posix.join(prefix, entry.name);
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walkMdx(absolute, relative, excluded));
        } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
            files.push(relative);
        }
    }
    return files;
}

export async function englishMdxInventory(root = repositoryRoot) {
    const registry = JSON.parse(await readFile(path.join(root, '.i18n/locales.generated.json'), 'utf8'));
    return walkMdx(root, '', new Set(registry.locales.map(({ pathPrefix }) => pathPrefix).filter(Boolean)));
}

async function translatedMdxInventory(root = repositoryRoot, locale = 'es') {
    const localeRoot = path.join(root, locale);
    const entries = await readdir(localeRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
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

export async function validateAuthoredContent(root = repositoryRoot) {
    const errors = [];
    const registry = JSON.parse(await readFile(path.join(root, '.i18n/locales.generated.json'), 'utf8'));
    const english = await englishMdxInventory(root);
    for (const locale of registry.locales.filter(({ tag, stage }) => tag !== registry.sourceLocale && stage !== 'retired')) {
        const translated = await translatedMdxInventory(root, locale.tag);
        for (const relative of translated) {
            if (!english.includes(relative)) {
                errors.push(`Translation has no English original: ${locale.tag}/${relative}`);
                continue;
            }
            const source = await readFile(path.join(root, relative), 'utf8');
            const translation = await readFile(path.join(root, locale.tag, relative), 'utf8');
            if (!translation.trim() || translation !== normalizeNfc(translation)) {
                errors.push(`Invalid translation text: ${locale.tag}/${relative}`);
            }
            errors.push(...validateFrontmatterPair(source, translation).map((error) => `${relative}: ${error}`));
            if (protectedStructureSha256(translation) !== localizedProtectedStructureSha256(source, locale.tag, root)) {
                errors.push(`${locale.tag}/${relative} changed protected MDX/frontmatter/code/link/component structure.`);
            }
        }
        try {
            const navigation = await readFile(path.join(root, `.i18n/navigation.${locale.tag}.json`), 'utf8');
            const config = JSON.parse(await readFile(path.join(root, 'docs.json'), 'utf8'));
            if (!validateNavigation(config, navigation, locale.tag)) errors.push(`Invalid ${locale.tag} navigation structure.`);
        } catch (error) {
            if (error.code !== 'ENOENT') errors.push(error.message);
        }
    }
    return errors;
}
