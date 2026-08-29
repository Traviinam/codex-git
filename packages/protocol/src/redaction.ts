const REDACTED = '[REDACTED]';

export interface DiagnosticRedactorOptions {
  readonly secrets?: readonly string[];
}

export type DiagnosticRedactor = (diagnostic: string) => string;

export function createDiagnosticRedactor(
  options: DiagnosticRedactorOptions = {},
): DiagnosticRedactor {
  const secrets = [...(options.secrets ?? [])]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  return (diagnostic) => {
    let redacted = diagnostic;

    for (const secret of secrets) {
      redacted = redacted.replaceAll(secret, REDACTED);
    }

    redacted = redacted.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu,
      `$1${REDACTED}@`,
    );
    redacted = redacted.replace(
      /\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?[^\s,;]+/giu,
      `$1$2${REDACTED}`,
    );
    redacted = redacted.replace(
      /\b((?:[a-z][a-z0-9_-]*[_-])?(?:token|password|passwd|secret|api[_-]?key|credential|access[_-]?key)(?:[_-][a-z0-9_-]+)?)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      `$1$2${REDACTED}`,
    );
    redacted = redacted.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/gu,
      REDACTED,
    );
    redacted = redacted.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      REDACTED,
    );

    return redacted;
  };
}

export const redactDiagnostic = createDiagnosticRedactor();
