/**
 * One platform's way of running a program at login.
 *
 * `enable` must be idempotent: running it twice leaves exactly one registration, and running it
 * with a different interval replaces the old one rather than adding a second.
 */
export interface AutostartBackend {
  /** Human-readable mechanism name, shown in `status` and `enable` output. */
  name: string
  /** Where the registration lives, so the user can inspect or remove it themselves. */
  location: () => string
  enable: (intervalSeconds: number, otlp?: boolean) => void
  disable: () => void
}
