/**
 * Minimal structured logger — JSON lines to stdout, errors to stderr.
 * Never pass raw tokens; callers must redact (e.g. first 8 chars + "…").
 */
type Fields = Record<string, unknown>;

function line(level: "info" | "warn" | "error", msg: string, fields?: Fields): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
}

export const logger = {
  info(msg: string, fields?: Fields) {
    console.log(line("info", msg, fields));
  },
  warn(msg: string, fields?: Fields) {
    console.warn(line("warn", msg, fields));
  },
  error(msg: string, fields?: Fields) {
    console.error(line("error", msg, fields));
  },
};

/** Redact a secret for logging: keep a short prefix so entries are still correlatable. */
export function redact(secret: string | undefined): string {
  if (!secret) return "";
  return secret.length <= 8 ? "***" : `${secret.slice(0, 8)}…`;
}
