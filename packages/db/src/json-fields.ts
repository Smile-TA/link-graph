/**
 * A typed reader over untrusted JSON, used by the fixture parser.
 *
 * It lives in its own file because it knows nothing about crawls: it is the "decode
 * one object, loudly" concern, and `fixture.ts` is the contract.
 */

/** `2026-08-20T09:00:00.000Z` or `...+02:00`. A bare local time is not an instant. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function fail(where: string, message: string): never {
  throw new Error(`fixture ${where}: ${message}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

export function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * A typed reader over one JSON object, which remembers the fields it was asked for.
 *
 * `done()` then rejects anything left over. That matters because a typo in an
 * optional field would otherwise be read as absent and silently change the answer —
 * and deriving the allowed set from the fields actually read, rather than from a
 * hand-maintained list beside each parse function, is what keeps the check honest
 * when a field is added.
 */
export class Fields {
  private readonly used = new Set<string>();

  constructor(
    private readonly o: Record<string, unknown>,
    private readonly where: string,
  ) {}

  private raw(key: string): unknown {
    this.used.add(key);
    return this.o[key];
  }

  private required(key: string): unknown {
    const value = this.raw(key);
    if (value === undefined || value === null) fail(this.where, `${key} is required`);
    return value;
  }

  str(key: string): string {
    const value = this.required(key);
    if (typeof value !== "string") fail(this.where, `${key} must be a string`);
    return value;
  }

  optStr(key: string): string | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") fail(this.where, `${key} must be a string`);
    return value;
  }

  bool(key: string): boolean {
    const value = this.required(key);
    if (typeof value !== "boolean") fail(this.where, `${key} must be a boolean`);
    return value;
  }

  optBool(key: string): boolean | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (typeof value !== "boolean") fail(this.where, `${key} must be a boolean`);
    return value;
  }

  optInt(key: string): number | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      fail(this.where, `${key} must be an integer`);
    }
    return value;
  }

  optNumber(key: string): number | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(this.where, `${key} must be a number`);
    }
    return value;
  }

  optStrArray(key: string): string[] | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      fail(this.where, `${key} must be an array of strings`);
    }
    return value as string[];
  }

  /**
   * An instant, and the offset is not optional. Measured: `new Date("2026-08-20T09:00:00")`
   * is read in the host's local zone, so the same fixture would mean 09:00 in CI and
   * 16:00 here — and step 13 orders crawls by time. `new Date` also accepts
   * "08/20/2026" happily, which is why the shape is checked rather than the parse.
   */
  optDate(key: string): Date | null {
    const value = this.raw(key);
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
      fail(
        this.where,
        `${key} must be an ISO 8601 instant with an offset, e.g. ` +
          `2026-08-20T09:00:00.000Z — got ${JSON.stringify(value)}`,
      );
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      fail(this.where, `${key} is not a valid date: ${value}`);
    }
    return date;
  }

  obj(key: string): Record<string, unknown> {
    return object(this.required(key), `${this.where}.${key}`);
  }

  array(key: string): unknown[] {
    const value = this.required(key);
    if (!Array.isArray(value)) fail(this.where, `${key} must be an array`);
    return value as unknown[];
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    return this.checkOneOf(key, this.str(key), allowed);
  }

  optOneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.optStr(key);
    return value === null ? fallback : this.checkOneOf(key, value, allowed);
  }

  private checkOneOf<T extends string>(
    key: string,
    value: string,
    allowed: readonly T[],
  ): T {
    if (!(allowed as readonly string[]).includes(value)) {
      fail(this.where, `${key} must be one of ${allowed.join(", ")}, got ${value}`);
    }
    return value as T;
  }

  /** Call once every field has been read: whatever is left is a typo. */
  done(): void {
    const unknownKeys = Object.keys(this.o).filter((k) => !this.used.has(k));
    if (unknownKeys.length > 0) {
      fail(
        this.where,
        `unknown field(s) ${unknownKeys.join(", ")} — known: ${[...this.used].join(", ")}`,
      );
    }
  }
}
