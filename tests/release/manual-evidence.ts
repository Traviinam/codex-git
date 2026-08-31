import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export interface ManualEvidenceCheck {
  readonly codexVersion: string | null;
  readonly environment: string | null;
  readonly id: string;
  readonly performedAt: string | null;
  readonly record: string | null;
  readonly sourceRevision: string | null;
  readonly status: 'passed' | 'pending';
  readonly validUntil: string | null;
}

export interface ManualEvidenceRecord {
  readonly checks: readonly ManualEvidenceCheck[];
  readonly schemaVersion: 1;
}

export async function readManualEvidence(
  path: string,
): Promise<ManualEvidenceRecord> {
  return parseManualEvidence(JSON.parse(await readFile(path, 'utf8')));
}

export function parseManualEvidence(value: unknown): ManualEvidenceRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Manual evidence must use schemaVersion 1.');
  }
  if (!Array.isArray(value.checks)) {
    throw new Error('Manual evidence checks must be an array.');
  }
  const ids = new Set<string>();
  const checks = value.checks.map((check, index): ManualEvidenceCheck => {
    if (
      !isRecord(check) ||
      typeof check.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(check.id) ||
      (check.status !== 'passed' && check.status !== 'pending')
    ) {
      throw new Error(`Manual evidence check ${index} is invalid.`);
    }
    const codexVersion = optionalString(check.codexVersion);
    const environment = optionalString(check.environment);
    const performedAt = optionalString(check.performedAt);
    const record = optionalString(check.record);
    const sourceRevision = optionalString(check.sourceRevision);
    const validUntil = optionalString(check.validUntil);
    if (ids.has(check.id)) {
      throw new Error(`Manual evidence check ID ${check.id} is duplicated.`);
    }
    ids.add(check.id);
    if (
      check.status === 'passed' &&
      (codexVersion === null ||
        environment === null ||
        performedAt === null ||
        record === null ||
        sourceRevision === null ||
        validUntil === null)
    ) {
      throw new Error(
        `Passed manual evidence ${check.id} requires codexVersion, environment, performedAt, record, sourceRevision, and validUntil.`,
      );
    }
    return {
      codexVersion,
      environment,
      id: check.id,
      performedAt,
      record,
      sourceRevision,
      status: check.status,
      validUntil,
    };
  });
  return { checks, schemaVersion: 1 };
}

export async function collectProductSourceRevision(
  root: string,
): Promise<string> {
  const { stdout } = await executeFile(
    'git',
    ['ls-files', '-z', '--', 'apps', 'packages'],
    { cwd: root, encoding: 'buffer', maxBuffer: 4 * 1_024 * 1_024 },
  );
  const files = stdout
    .toString('utf8')
    .split('\0')
    .filter(
      (file) =>
        file.length > 0 &&
        !file.includes('/test/') &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(resolve(root, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function manualEvidenceCheckPasses(
  root: string,
  check: ManualEvidenceCheck | undefined,
  sourceRevision: string,
  generatedAt: Date,
  codexVersion: string,
): Promise<boolean> {
  if (
    check?.status !== 'passed' ||
    check.sourceRevision !== sourceRevision ||
    check.codexVersion !== codexVersion ||
    check.performedAt === null ||
    check.validUntil === null ||
    check.record === null
  ) {
    return false;
  }
  const performedAt = new Date(check.performedAt);
  const validUntil = new Date(check.validUntil);
  if (
    !Number.isFinite(performedAt.valueOf()) ||
    !Number.isFinite(validUntil.valueOf()) ||
    performedAt > generatedAt ||
    validUntil < generatedAt
  ) {
    return false;
  }
  const recordPath = check.record.split('#', 1)[0];
  if (recordPath === undefined || recordPath.length === 0) return false;
  const expectedRoot = resolve(root);
  const path = resolve(expectedRoot, recordPath);
  if (
    isAbsolute(recordPath) ||
    (path !== expectedRoot && !path.startsWith(`${expectedRoot}${sep}`))
  ) {
    return false;
  }
  try {
    const record = await stat(path);
    return record.isFile() && record.size > 0;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      'Manual evidence values must be non-empty strings or null.',
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
