import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newKeypairFile, readKeypair } from "../src/cli/keys";

describe("keypair files", () => {
  it("are written owner-only and read back to the same 64-byte key", () => {
    const dir = mkdtempSync(join(tmpdir(), "vja-keys-"));
    const k = newKeypairFile(join(dir, "a.json"));
    expect(statSync(join(dir, "a.json")).mode & 0o777).toBe(0o600);
    expect(readKeypair(join(dir, "a.json"))).toEqual(k.secret);
  });

  it("never overwrite an existing file or follow a planted symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "vja-keys-"));
    writeFileSync(join(dir, "taken.json"), "keep me");
    expect(() => newKeypairFile(join(dir, "taken.json"))).toThrow();
    expect(readFileSync(join(dir, "taken.json"), "utf8")).toBe("keep me");
    const target = join(dir, "elsewhere.json");
    symlinkSync(target, join(dir, "link.json"));
    expect(() => newKeypairFile(join(dir, "link.json"))).toThrow();
    expect(() => statSync(target)).toThrow(); // nothing was written through the link
  });

  it("also read inline from an environment value, without echoing a bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "vja-keys-"));
    const k = newKeypairFile(join(dir, "b.json"));
    expect(readKeypair(readFileSync(join(dir, "b.json"), "utf8"))).toEqual(k.secret);
    const secretish = JSON.stringify([...k.secret.slice(0, 63)]); // one byte short
    expect(() => readKeypair(secretish)).toThrow(/inline keypair/);
    try {
      readKeypair(secretish);
    } catch (e) {
      expect(String(e)).not.toContain(String(k.secret[0]) + "," + String(k.secret[1]));
    }
    expect(() => readKeypair("[1,2,")).toThrow(/inline keypair isn't valid JSON/);
    expect(() => readKeypair(JSON.stringify(Array(64).fill(256)))).toThrow(/64-byte/);
  });
});
