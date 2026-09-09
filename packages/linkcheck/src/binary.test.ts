/**
 * Finding the checker, and refusing loudly when it is not there.
 *
 * A link checker that cannot find its binary and reports zero broken links is engineering
 * guide §1's opening bug with a different executable missing, so the only acceptable
 * behaviour is a refusal that names what is missing and how to get it.
 */
import { describe, expect, it } from "vitest";
import { LYCHEE_RELEASE, resolveLycheeBinary } from "./binary.js";

const present = { isExecutable: () => true };
const absent = { isExecutable: () => false };

describe("resolveLycheeBinary", () => {
  it("takes the path from LYCHEE_BIN when it is set", () => {
    expect(resolveLycheeBinary({ LYCHEE_BIN: "/opt/lychee" }, present)).toBe(
      "/opt/lychee",
    );
  });

  it("falls back to the vendored location when LYCHEE_BIN is unset", () => {
    const path = resolveLycheeBinary({}, present);
    expect(path).toMatch(/vendor\/lychee\/lychee$/);
  });

  it("ignores an empty LYCHEE_BIN rather than spawning the empty string", () => {
    expect(resolveLycheeBinary({ LYCHEE_BIN: "  " }, present)).toMatch(/vendor/);
  });

  /**
   * The whole point. The message has to carry the path tried, the release the code was
   * written against, and the command that produces it — a bare "not found" sends the
   * next person reading it to the wrong place (guide §6, errors carry context).
   */
  it("refuses when the binary is missing, naming the path, the release and the fix", () => {
    let message = "";
    try {
      resolveLycheeBinary({ LYCHEE_BIN: "/opt/nope" }, absent);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("/opt/nope");
    expect(message).toContain(LYCHEE_RELEASE);
    expect(message).toContain("LYCHEE_BIN");
    expect(message).toMatch(/fetch-lychee/);
  });

  it("says which of the two paths it tried when the fallback is the one missing", () => {
    let message = "";
    try {
      resolveLycheeBinary({}, absent);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/vendor\/lychee\/lychee/);
  });
});
