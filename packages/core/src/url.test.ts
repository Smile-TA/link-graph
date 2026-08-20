import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./url.js";

// Fixtures are real hosts from the estate (docs/census.json), not invented ones.
const lionstreet = {
  canonicalHost: "lionstreet.com",
  aliases: ["lionstreet.com", "www.lionstreet.com"],
};

describe("normalizeUrl", () => {
  it("treats a www alias as the same site as the apex host", () => {
    const apex = normalizeUrl("https://lionstreet.com/about/", lionstreet);
    const www = normalizeUrl("https://www.lionstreet.com/about/", lionstreet);
    expect(www?.href).toBe(apex?.href);
    expect(www?.isInternal).toBe(true);
  });

  it("upgrades http to https and lowercases the host", () => {
    const r = normalizeUrl("http://WWW.LionStreet.com/About/", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/About/");
  });

  it("strips the fragment but keeps the path", () => {
    const r = normalizeUrl("https://lionstreet.com/privacy/#texting", lionstreet);
    expect(r?.href).toBe("https://lionstreet.com/privacy/");
  });

  it("strips tracking parameters and keeps meaningful ones", () => {
    const r = normalizeUrl(
      "https://lionstreet.com/x/?utm_source=a&id=7&fbclid=z",
      lionstreet,
    );
    expect(r?.href).toBe("https://lionstreet.com/x/?id=7");
  });

  it("keeps the root-relative path, matching the pw-template convention", () => {
    const r = normalizeUrl("https://lionstreet.com/team/bob/", lionstreet);
    expect(r?.path).toBe("/team/bob/");
  });

  it("marks a genuinely different host as external", () => {
    const r = normalizeUrl("https://integrity.com/privacy-policy/", lionstreet);
    expect(r?.isInternal).toBe(false);
    expect(r?.host).toBe("integrity.com");
  });

  it("resolves a relative href against the page it was found on", () => {
    const r = normalizeUrl("../contact/", lionstreet, "https://lionstreet.com/a/b/");
    expect(r?.href).toBe("https://lionstreet.com/a/contact/");
  });

  it("returns null for non-navigable schemes rather than throwing", () => {
    expect(normalizeUrl("mailto:a@b.com", lionstreet)).toBeNull();
    expect(normalizeUrl("tel:+15551234567", lionstreet)).toBeNull();
    expect(normalizeUrl("javascript:void(0)", lionstreet)).toBeNull();
    expect(normalizeUrl("#anchor-only", lionstreet)).toBeNull();
  });

  it("returns null for unparseable input rather than throwing", () => {
    expect(normalizeUrl("http://", lionstreet)).toBeNull();
    expect(normalizeUrl("", lionstreet)).toBeNull();
  });
});
