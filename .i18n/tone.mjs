#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { englishMdxInventory } from './content.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

const replacements = new Map(Object.entries({
    Use: 'Usa',
    use: 'usa',
    Consulte: 'Consulta',
    consulte: 'consulta',
    Cree: 'Crea',
    cree: 'crea',
    Abra: 'Abre',
    abra: 'abre',
    Elija: 'Elige',
    elija: 'elige',
    Añada: 'Añade',
    añada: 'añade',
    Haga: 'Haz',
    haga: 'haz',
    Guarde: 'Guarda',
    guarde: 'guarda',
    Compruebe: 'Comprueba',
    compruebe: 'comprueba',
    Confirme: 'Confirma',
    confirme: 'confirma',
    Describa: 'Describe',
    describa: 'describe',
    Revise: 'Revisa',
    revise: 'revisa',
    Active: 'Activa',
    active: 'activa',
    Desactive: 'Desactiva',
    desactive: 'desactiva',
    Establezca: 'Establece',
    establezca: 'establece',
    Pida: 'Pide',
    pida: 'pide',
    Permita: 'Permite',
    permita: 'permite',
    Trate: 'Trata',
    trate: 'trata',
    Mantenga: 'Mantén',
    mantenga: 'mantén',
    Prepare: 'Prepara',
    prepare: 'prepara',
    Sustituya: 'Sustituye',
    sustituya: 'sustituye',
    Ejecute: 'Ejecuta',
    ejecute: 'ejecuta',
    Pegue: 'Pega',
    pegue: 'pega',
    Vaya: 'Ve',
    vaya: 've',
    Siga: 'Sigue',
    siga: 'sigue',
    Cambie: 'Cambia',
    cambie: 'cambia',
    Edite: 'Edita',
    edite: 'edita',
    Busque: 'Busca',
    busque: 'busca',
    Quite: 'Quita',
    quite: 'quita',
    Seleccione: 'Selecciona',
    seleccione: 'selecciona',
    Genere: 'Genera',
    genere: 'genera',
    Escriba: 'Escribe',
    escriba: 'escribe',
    Pulse: 'Pulsa',
    pulse: 'pulsa',
    Pruebe: 'Prueba',
    pruebe: 'prueba',
    Espere: 'Espera',
    espere: 'espera',
    Introduzca: 'Introduce',
    introduzca: 'introduce',
    Desplácese: 'Desplázate',
    desplácese: 'desplázate',
    Elimine: 'Elimina',
    elimine: 'elimina',
    Copie: 'Copia',
    copie: 'copia',
    Comparta: 'Comparte',
    comparta: 'comparte',
    Marque: 'Marca',
    marque: 'marca',
    Limite: 'Limita',
    limite: 'limita',
    Obtenga: 'Obtén',
    obtenga: 'obtén',
    Imprima: 'Imprime',
    imprima: 'imprime',
    Muestre: 'Muestra',
    muestre: 'muestra',
    Liste: 'Lista',
    liste: 'lista',
    Devuelva: 'Devuelve',
    devuelva: 'devuelve',
    Añádala: 'Añádela',
    añádala: 'añádela',
    Instale: 'Instala',
    instale: 'instala',
    'Autentíquese': 'Autentícate',
    'autentíquese': 'autentícate',
    Mencione: 'Menciona',
    mencione: 'menciona',
    Conecte: 'Conecta',
    conecte: 'conecta',
    Configure: 'Configura',
    configure: 'configura',
    Corrija: 'Corrige',
    corrija: 'corrige',
    Reintente: 'Reintenta',
    reintente: 'reintenta',
    Vea: 'Ve',
    vea: 've',
    Descubra: 'Descubre',
    descubra: 'descubre',
    Empiece: 'Empieza',
    empiece: 'empieza',
    Invite: 'Invita',
    invite: 'invita',
    Actualice: 'Actualiza',
    actualice: 'actualiza',
    Acceda: 'Accede',
    acceda: 'accede',
    usted: 'tú',
    Usted: 'Tú',
}));

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const formalTokens = [...replacements.keys()].filter((word) => word === 'usted' || /^\p{Lu}/u.test(word));
const formalPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${formalTokens.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
);
const vosotrosPattern = /(?<![\p{L}\p{N}_])(?:vosotros|vosotras|vuestro|vuestra|vuestros|vuestras)(?![\p{L}\p{N}_])/giu;
const vosotrosImperativePattern = /(?<![\p{L}\p{N}_])(?:usad|consultad|cread|abrid|elegid|añadid|haced|guardad|comprobad|confirmad|describid|revisad|activad|desactivad|estableced|pedid|permitid|mantened|preparad|sustituid|ejecutad|pegad|seguid|cambiad|editad|buscad|quitad|seleccionad|generad|escribid|probad|esperad|introducid|eliminad|copiad|compartid|marcad|limitad|obtened|imprimid|mostrad|listad|devolved|instalad|mencionad|conectad|configurad|corregid|reintentad|descubrid|empezad|invitad|actualizad)(?![\p{L}\p{N}_])/giu;
const scannerOnlyPattern = /(?<![\p{L}\p{N}_])(?:Continúe|Vuelva|Debe|Amplíe|Envíe|Ábralo|Precise|Complete|Cierre|Repita|Descargue|confíe|Recibirá|mejore|inicie|aprenda|corríjalo|compruébelo|relaciónelo|guárdela|rótela|revóquela|especifíquelo|especifíquela|indíquelo|Pase|prográmela|trátela|quítelas|úsela|úselas|instálela|entréguelos|envíelo|péguela|guárdelo|consúltelos|regístrese|accederá)(?![\p{L}\p{N}_])/gu;
const formalPhrasePattern = /(?<![\p{L}\p{N}_])(?:ha (?:iniciado|valorado)|Si (?:acaba|empezó|instaló)|aún no lo instaló|que usó|donde lo dejó|no quiera|Solo verá)(?![\p{L}\p{N}_])/gu;

function mapOutsideFences(text, transform) {
    let fence = null;
    return text.split('\n').map((line) => {
        const match = line.match(/^\s*(```+|~~~+)/);
        if (match) {
            fence = fence === null ? match[1][0] : null;
            return line;
        }
        if (fence !== null || /^\s*(?:import|export)\b/.test(line)) {
            return line;
        }
        const protectedValues = [];
        const masked = line.replace(
            /`[^`\n]+`|https?:\/\/[^\s)>]+|\b(?:href|path)=(?:"[^"]*"|'[^']*')/g,
            (value) => {
                const marker = `\uE000${protectedValues.length}\uE001`;
                protectedValues.push(value);
                return marker;
            },
        );
        const transformed = transform(masked);
        return transformed.replace(/\uE000(\d+)\uE001/g, (match, index) => protectedValues[Number(index)]);
    }).join('\n');
}

export function normalizeDirectVoice(text) {
    return mapOutsideFences(text, (line) => line.replace(formalPattern, (word) => replacements.get(word) ?? word));
}

export function findFormalVoice(text) {
    const matches = [];
    mapOutsideFences(text, (line) => {
        for (const match of line.matchAll(formalPattern)) {
            matches.push(match[0]);
        }
        for (const match of line.matchAll(vosotrosPattern)) {
            matches.push(match[0]);
        }
        for (const match of line.matchAll(vosotrosImperativePattern)) {
            matches.push(match[0]);
        }
        for (const match of line.matchAll(scannerOnlyPattern)) {
            matches.push(match[0]);
        }
        for (const match of line.matchAll(formalPhrasePattern)) {
            matches.push(match[0]);
        }
        return line;
    });
    return matches;
}

async function apply(root = repositoryRoot) {
    for (const relativePath of await englishMdxInventory(root)) {
        const translationPath = path.join(root, 'es', relativePath);
        const current = await readFile(translationPath, 'utf8');
        const normalized = normalizeDirectVoice(current);
        if (normalized !== current) {
            await writeFile(translationPath, normalized, 'utf8');
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== 'apply' || process.argv.length !== 3) {
        throw new Error('Usage: node .i18n/tone.mjs apply');
    }
    await apply();
    console.log('Normalized Spanish docs to neutral direct tú voice outside protected code fences.');
}
