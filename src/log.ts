// One-line structured logger: every hunt step logs as `[step] key=value …`
// so a night of unattended runs stays greppable.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function formatLine(step: string, fields?: LogFields): string {
  const parts = Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const s = String(v);
      return `${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`;
    });
  return parts.length ? `[${step}] ${parts.join(' ')}` : `[${step}]`;
}

export function log(step: string, fields?: LogFields): void {
  console.log(formatLine(step, fields));
}

export function logError(step: string, err: unknown, fields?: LogFields): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(formatLine(step, { ...fields, error: message }));
}
