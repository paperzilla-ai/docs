import { createHash } from 'node:crypto';
import { glob, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './deploy-config.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

export const matrixPath = path.join(internalDirectory, 'launch-review-matrix.generated.json');

const matrixKeys = ['schemaVersion', 'localeRegistrySha256', 'artifacts', 'reviews', 'promotionApprovals'];
const artifactKeys = [
    'id', 'locale', 'repository', 'surface', 'sourcePaths', 'artifactPaths',
    'requiredRoles', 'requiredFor',
];
const reviewKeys = [
    'locale', 'artifactId', 'surface', 'role', 'reviewerAuthority', 'sourceSha256',
    'artifactSha256', 'reviewerLabel', 'timestamp', 'decision', 'exceptions',
];
const approvalKeys = [
    'locale', 'targetStage', 'approverRole', 'reviewerLabel', 'timestamp',
    'decision', 'reviewSetSha256', 'exceptions',
];
const roles = new Set([
    'linguistic', 'editorial', 'product-technical', 'legal-risk', 'commercial',
    'auth-email', 'seo',
]);
const targets = new Set(['preview', 'live', 'run7-complete']);
const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reviewerContactPattern = /(?:@|:\/\/|\bwww\.|\bmailto:|\btel:|\b(?:phone|mobile|whatsapp)\b|(?:\+?\d[\d(). -]{6,}\d))/i;
const promotionRoles = {
    preview: 'trusted-spanish-reviewer',
    live: 'mark',
    'run7-complete': 'mark',
};
const reviewAuthorities = {
    linguistic: 'trusted-spanish-reviewer',
    editorial: 'trusted-spanish-reviewer',
    'product-technical': 'mark',
    'legal-risk': 'mark',
    commercial: 'mark',
    'auth-email': 'mark',
    seo: 'mark',
};
const docsArtifactContracts = [
    {
        id: 'documentation',
        locale: 'es',
        repository: 'docs',
        surface: 'documentation',
        sourcePaths: ['.i18n/content.manifest.json', 'docs.json'],
        artifactPaths: ['.i18n/content.manifest.json', '.i18n/navigation.es.json', 'es/**/*.mdx'],
        requiredRoles: ['linguistic', 'editorial', 'product-technical', 'seo'],
        requiredFor: ['preview', 'live', 'run7-complete'],
    },
    {
        id: 'documentation-runtime-and-deployment',
        locale: 'es',
        repository: 'docs',
        surface: 'documentation-runtime-and-deployment',
        sourcePaths: [
            '.i18n/content.manifest.json',
            '.i18n/navigation.es.json',
            '.i18n/locales.generated.json',
        ],
        artifactPaths: [
            '.mintignore',
            'docs.json',
            '.i18n/check.mjs',
            '.i18n/deploy-config.mjs',
            '.i18n/launch-review.mjs',
            '.i18n/navigation.mjs',
            '.i18n/preview.mjs',
            '.i18n/artifact-guard.mjs',
            '.i18n/hosted-smoke.mjs',
            '.i18n/content.mjs',
            '.i18n/content-segments.mjs',
            '.i18n/content-structure.mjs',
            '.i18n/retired-content.mjs',
            '.i18n/tone.mjs',
            '.github/workflows/i18n.yml',
            'package.json',
            'package-lock.json',
        ],
        requiredRoles: ['product-technical', 'seo'],
        requiredFor: ['preview', 'live', 'run7-complete'],
    },
];

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
    return isObject(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function report(errors, condition, message) {
    if (!condition) {
        errors.push(message);
    }
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function hasNoContactDetails(value) {
    return typeof value === 'string' && !reviewerContactPattern.test(value);
}

function reviewerLabelIsSafe(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= 80
        && !/[<>\r\n]/.test(value)
        && hasNoContactDetails(value);
}

function pathListIsValid(value) {
    return Array.isArray(value)
        && value.length > 0
        && new Set(value).size === value.length
        && value.every((entry) => (
            typeof entry === 'string'
            && entry.length > 0
            && !entry.startsWith('/')
            && !entry.split('/').includes('..')
        ));
}

function exceptionsAreValid(value) {
    return Array.isArray(value) && value.every((entry) => (
        typeof entry === 'string'
        && entry.length > 0
        && entry.length <= 500
        && hasNoContactDetails(entry)
    ));
}

function timestampIsOffsetDate(value) {
    return typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        && !Number.isNaN(Date.parse(value));
}

function timestampIdentity(value) {
    return timestampIsOffsetDate(value) ? new Date(value).toISOString() : String(value ?? '');
}

async function expandPaths(root, patterns) {
    const canonicalRoot = await realpath(root);
    const matches = new Map();
    for (const pattern of patterns) {
        const patternMatches = [];
        for await (const relativePath of glob(pattern, { cwd: root })) {
            const absolutePath = path.join(root, relativePath);
            const canonicalPath = await realpath(absolutePath);
            const canonicalRelative = path.relative(canonicalRoot, canonicalPath);
            const isContained = canonicalRelative !== ''
                && canonicalRelative !== '..'
                && !canonicalRelative.startsWith(`..${path.sep}`)
                && !path.isAbsolute(canonicalRelative);
            if (!isContained) {
                throw new Error(`Review path resolves outside the repository: ${relativePath}`);
            }
            if ((await stat(canonicalPath)).isFile()) {
                const normalized = canonicalRelative.split(path.sep).join('/');
                patternMatches.push(normalized);
                matches.set(normalized, canonicalPath);
            }
        }
        if (patternMatches.length === 0) {
            throw new Error(`Review path pattern matched no files: ${pattern}`);
        }
    }
    return [...matches.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relativePath, absolutePath]) => ({ relativePath, absolutePath }));
}

export async function aggregateSha256(root, patterns) {
    const digest = createHash('sha256');
    for (const { relativePath, absolutePath } of await expandPaths(root, patterns)) {
        digest.update(relativePath, 'utf8');
        digest.update('\0');
        digest.update(await readFile(absolutePath));
        digest.update('\0');
    }
    return digest.digest('hex');
}

export function reviewSetSha256(matrix, locale) {
    return sha256(canonicalJson({
        locale,
        reviews: matrix.reviews.filter((review) => review?.locale === locale),
    }));
}

function latestBy(records, key) {
    const latest = new Map();
    for (const record of records) {
        if (!timestampIsOffsetDate(record?.timestamp)) {
            continue;
        }
        const identity = key(record);
        const previous = latest.get(identity);
        if (!previous || Date.parse(record.timestamp) > Date.parse(previous.timestamp)) {
            latest.set(identity, record);
        }
    }
    return latest;
}

export async function artifactReviewState(matrix, artifactId, root = repositoryRoot) {
    const artifact = matrix.artifacts.find((entry) => entry?.id === artifactId);
    if (!artifact) {
        throw new Error(`Launch-review matrix has no ${artifactId} artifact.`);
    }
    const [sourceSha256, artifactSha256] = await Promise.all([
        aggregateSha256(root, artifact.sourcePaths),
        aggregateSha256(root, artifact.artifactPaths),
    ]);
    const latest = latestBy(
        matrix.reviews.filter((review) => review?.artifactId === artifact.id),
        (review) => review.role,
    );
    const currentApprovedRoles = artifact.requiredRoles.filter((role) => {
        const review = latest.get(role);
        return review?.decision === 'approved'
            && review.sourceSha256 === sourceSha256
            && review.artifactSha256 === artifactSha256;
    });
    return {
        artifact,
        sourceSha256,
        artifactSha256,
        currentApprovedRoles,
        pendingRoles: artifact.requiredRoles.filter((role) => !currentApprovedRoles.includes(role)),
    };
}

export async function documentationReviewState(matrix, root = repositoryRoot) {
    return artifactReviewState(matrix, 'documentation', root);
}

function structuralErrors(matrix, rawMatrix, registry, rawRegistry) {
    const errors = [];
    if (!isObject(matrix)) {
        return ['Launch-review matrix root must be an object.'];
    }
    report(errors, hasExactKeys(matrix, matrixKeys), 'Launch-review matrix fields or order differ from v1.');
    report(errors, matrix.schemaVersion === 1, 'Launch-review matrix schemaVersion must be 1.');
    report(errors, rawMatrix === canonicalJson(matrix), 'Launch-review matrix must be canonical two-space JSON with a final newline.');
    report(errors, sha256Pattern.test(matrix.localeRegistrySha256 ?? ''), 'Launch-review registry hash is invalid.');
    report(errors, matrix.localeRegistrySha256 === sha256(rawRegistry), 'Launch-review registry hash is stale.');
    const localeTags = new Set(registry.locales.map((locale) => locale.tag));
    const artifacts = Array.isArray(matrix.artifacts) ? matrix.artifacts : [];
    const artifactIds = new Set();
    for (const [index, artifact] of artifacts.entries()) {
        const label = `artifacts[${index}]`;
        report(errors, hasExactKeys(artifact, artifactKeys), `${label} fields or order differ from v1.`);
        report(errors, identifierPattern.test(artifact?.id ?? ''), `${label}.id is invalid.`);
        report(errors, !artifactIds.has(artifact?.id), `${label}.id is duplicated.`);
        artifactIds.add(artifact?.id);
        report(errors, localeTags.has(artifact?.locale), `${label}.locale is not registered.`);
        report(errors, ['backend', 'frontend', 'docs'].includes(artifact?.repository), `${label}.repository is invalid.`);
        report(errors, identifierPattern.test(artifact?.surface ?? ''), `${label}.surface is invalid.`);
        report(errors, pathListIsValid(artifact?.sourcePaths), `${label}.sourcePaths is invalid.`);
        report(errors, pathListIsValid(artifact?.artifactPaths), `${label}.artifactPaths is invalid.`);
        report(errors, Array.isArray(artifact?.requiredRoles) && artifact.requiredRoles.length > 0
            && artifact.requiredRoles.every((role) => roles.has(role)), `${label}.requiredRoles is invalid.`);
        report(errors, new Set(artifact?.requiredRoles ?? []).size === (artifact?.requiredRoles?.length ?? -1), `${label}.requiredRoles contains duplicates.`);
        report(errors, Array.isArray(artifact?.requiredFor) && artifact.requiredFor.length > 0
            && artifact.requiredFor.every((target) => targets.has(target)), `${label}.requiredFor is invalid.`);
        report(errors, new Set(artifact?.requiredFor ?? []).size === (artifact?.requiredFor?.length ?? -1), `${label}.requiredFor contains duplicates.`);
        report(errors, !(artifact?.requiredFor ?? []).includes('preview')
            || artifact.requiredFor.includes('live'), `${label} preview requirement must continue through live.`);
    }
    const docsArtifacts = artifacts.filter((artifact) => artifact?.repository === 'docs');
    report(
        errors,
        docsArtifacts.length === docsArtifactContracts.length,
        'Launch-review matrix docs artifact set changed unexpectedly.',
    );
    for (const expected of docsArtifactContracts) {
        const matches = artifacts.filter((artifact) => artifact?.id === expected.id);
        report(errors, matches.length === 1, `Matrix must contain exactly one ${expected.id} artifact.`);
        if (matches.length === 1) {
            report(
                errors,
                JSON.stringify(matches[0]) === JSON.stringify(expected),
                `${expected.id} artifact contract changed unexpectedly.`,
            );
        }
    }
    const reviews = Array.isArray(matrix.reviews) ? matrix.reviews : [];
    const reviewEvents = new Set();
    for (const [index, review] of reviews.entries()) {
        const label = `reviews[${index}]`;
        const artifact = artifacts.find((entry) => entry.id === review?.artifactId);
        const eventIdentity = JSON.stringify([
            review?.locale,
            review?.artifactId,
            review?.role,
            timestampIdentity(review?.timestamp),
        ]);
        report(errors, hasExactKeys(review, reviewKeys), `${label} fields or order differ from v1.`);
        report(
            errors,
            !reviewEvents.has(eventIdentity),
            `${label} duplicates a review identity and timestamp; event ordering would be ambiguous.`,
        );
        reviewEvents.add(eventIdentity);
        report(errors, Boolean(artifact), `${label}.artifactId is unknown.`);
        if (artifact) {
            report(errors, review.locale === artifact.locale && review.surface === artifact.surface, `${label} does not match its artifact.`);
            report(errors, artifact.requiredRoles.includes(review.role), `${label}.role is not required.`);
        }
        report(
            errors,
            review?.reviewerAuthority === reviewAuthorities[review?.role],
            `${label}.reviewerAuthority does not own ${review?.role ?? 'this role'}.`,
        );
        report(errors, sha256Pattern.test(review?.sourceSha256 ?? '') && sha256Pattern.test(review?.artifactSha256 ?? ''), `${label} hashes are invalid.`);
        report(errors, reviewerLabelIsSafe(review?.reviewerLabel), `${label}.reviewerLabel must be a stable non-contact label.`);
        report(errors, timestampIsOffsetDate(review?.timestamp), `${label}.timestamp is invalid.`);
        report(errors, ['approved', 'rejected'].includes(review?.decision), `${label}.decision is invalid.`);
        report(errors, exceptionsAreValid(review?.exceptions), `${label}.exceptions is invalid or contains contact details.`);
    }
    const approvals = Array.isArray(matrix.promotionApprovals) ? matrix.promotionApprovals : [];
    const approvalEvents = new Set();
    for (const [index, approval] of approvals.entries()) {
        const label = `promotionApprovals[${index}]`;
        const eventIdentity = JSON.stringify([
            approval?.locale,
            approval?.targetStage,
            approval?.approverRole,
            timestampIdentity(approval?.timestamp),
        ]);
        report(errors, hasExactKeys(approval, approvalKeys), `${label} fields or order differ from v1.`);
        report(
            errors,
            !approvalEvents.has(eventIdentity),
            `${label} duplicates a promotion-approval identity and timestamp; event ordering would be ambiguous.`,
        );
        approvalEvents.add(eventIdentity);
        report(errors, promotionRoles[approval?.targetStage] === approval?.approverRole, `${label}.approverRole is invalid.`);
        report(errors, localeTags.has(approval?.locale), `${label}.locale is not registered.`);
        report(errors, reviewerLabelIsSafe(approval?.reviewerLabel), `${label}.reviewerLabel must be a stable non-contact label.`);
        report(errors, timestampIsOffsetDate(approval?.timestamp), `${label}.timestamp is invalid.`);
        report(errors, ['approved', 'rejected'].includes(approval?.decision), `${label}.decision is invalid.`);
        report(errors, sha256Pattern.test(approval?.reviewSetSha256 ?? ''), `${label}.reviewSetSha256 is invalid.`);
        report(errors, exceptionsAreValid(approval?.exceptions), `${label}.exceptions is invalid or contains contact details.`);
    }
    return errors;
}

async function targetGateErrors(matrix, registry, root) {
    const spanish = registry.locales.find((locale) => locale.tag === 'es');
    if (spanish?.stage === 'retired') {
        const state = await artifactReviewState(matrix, 'documentation', root);
        const latestReviews = latestBy(
            matrix.reviews.filter((review) => review?.artifactId === state.artifact.id),
            (review) => review.role,
        );
        const errors = [];
        for (const role of state.artifact.requiredRoles) {
            const review = latestReviews.get(role);
            if (!review) {
                errors.push(`documentation: retired artifact is missing its frozen ${role} review`);
            } else if (review.decision !== 'approved') {
                errors.push(`documentation: retired artifact's latest ${role} review is not approved`);
            } else if (review.artifactSha256 !== state.artifactSha256) {
                errors.push(`documentation: retired artifact changed after its ${role} approval`);
            }
        }
        return errors;
    }
    const targetStages = spanish?.stage === 'preview'
        ? ['preview']
        : spanish?.stage === 'live' ? ['preview', 'live'] : [];
    if (targetStages.length === 0) {
        return [];
    }
    const errors = [];
    const docsArtifacts = matrix.artifacts.filter((artifact) => artifact?.repository === 'docs');
    const states = new Map((await Promise.all(docsArtifacts.map(async (artifact) => (
        [artifact.id, await artifactReviewState(matrix, artifact.id, root)]
    )))).map(([artifactId, state]) => [artifactId, state]));
    for (const target of targetStages) {
        const applicableStates = [...states.values()].filter((state) => (
            state.artifact.requiredFor.includes(target)
        ));
        for (const state of applicableStates) {
            const latestReviews = latestBy(
                matrix.reviews.filter((review) => review?.artifactId === state.artifact.id),
                (review) => review.role,
            );
            for (const role of state.artifact.requiredRoles) {
                const review = latestReviews.get(role);
                if (!review) {
                    errors.push(`${state.artifact.id}: missing ${role} review for ${target}`);
                } else if (review.decision !== 'approved') {
                    errors.push(`${state.artifact.id}: latest ${role} review is not approved`);
                } else if (review.sourceSha256 !== state.sourceSha256 || review.artifactSha256 !== state.artifactSha256) {
                    errors.push(`${state.artifact.id}: ${role} review hashes are stale`);
                }
            }
        }
        const latestApprovals = latestBy(
            matrix.promotionApprovals.filter((approval) => approval?.locale === 'es'),
            (approval) => approval.targetStage,
        );
        const approval = latestApprovals.get(target);
        if (!approval) {
            errors.push(`documentation: missing explicit ${target} promotion approval`);
        } else if (approval.decision !== 'approved') {
            errors.push(`documentation: latest ${target} promotion approval is not approved`);
        } else if (approval.reviewSetSha256 !== reviewSetSha256(matrix, 'es')) {
            errors.push(`documentation: ${target} promotion approval is stale after review changes`);
        }
    }
    return errors;
}

export async function validateLaunchReviewMatrix({
    root = repositoryRoot,
    matrix,
    rawMatrix,
    registry,
    rawRegistry,
}) {
    const errors = structuralErrors(matrix, rawMatrix, registry, rawRegistry);
    if (errors.length === 0) {
        try {
            errors.push(...await targetGateErrors(matrix, registry, root));
        } catch (error) {
            errors.push(`Cannot validate documentation review hashes: ${error.message}`);
        }
    }
    return errors;
}

export async function loadAndValidateLaunchReview(root = repositoryRoot) {
    try {
        const [rawMatrix, rawRegistry] = await Promise.all([
            readFile(path.join(root, '.i18n/launch-review-matrix.generated.json'), 'utf8'),
            readFile(path.join(root, '.i18n/locales.generated.json'), 'utf8'),
        ]);
        const matrix = JSON.parse(rawMatrix);
        const registry = JSON.parse(rawRegistry);
        return {
            matrix,
            rawMatrix,
            errors: await validateLaunchReviewMatrix({
                root,
                matrix,
                rawMatrix,
                registry,
                rawRegistry,
            }),
        };
    } catch (error) {
        return { matrix: null, rawMatrix: '', errors: [`Cannot read launch-review mirror: ${error.message}`] };
    }
}
