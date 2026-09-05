/**
 * Single source of truth for allowed browser/socket origins.
 *
 * Reads `CORS_ORIGINS` directly from process.env (ConfigModule assigns .env
 * values into process.env, so this matches application config and works in
 * module/decorator positions where ConfigService is not injectable).
 *
 * - Comma-separated list of explicit origins.
 * - A literal `*` reflects any origin — callers must NOT combine that with
 *   `credentials: true`.
 */
export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS || 'http://localhost:3000';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The `origin` value accepted by both `app.enableCors()` and
 * `@WebSocketGateway({ cors: { origin } })`.
 */
export function corsOriginOption(): string[] | true {
  const list = corsOrigins();
  return list.includes('*') ? true : list;
}

/** True only when CORS is wide open (safe to combine with `credentials: false`). */
export function corsIsWildcard(): boolean {
  return corsOrigins().includes('*');
}