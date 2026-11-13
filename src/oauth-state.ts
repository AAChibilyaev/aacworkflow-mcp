import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OAuthStateConfig = { file: string; key: string };

const MAGIC = Buffer.from("AMO1");
const AAD = Buffer.from("aacworkflow-mcp/oauth-state/v1");

/** One process owns this file. Synchronous atomic writes serialize OAuth mutations. */
export class OAuthStateFile {
  private readonly key: Buffer;

  constructor(private readonly cfg: OAuthStateConfig) {
    if (!cfg.file || !/^[a-f0-9]{64}$/i.test(cfg.key)) {
      throw new Error("OAuth state requires a file path and a 64-character hexadecimal encryption key");
    }
    this.key = Buffer.from(cfg.key, "hex");
  }

  load(): unknown | undefined {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.cfg.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read encrypted OAuth state");
    }
    try {
      if (bytes.length < 32 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error("Invalid format");
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(4, 16));
      decipher.setAAD(AAD);
      decipher.setAuthTag(bytes.subarray(16, 32));
      const plain = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
      const state: unknown = JSON.parse(plain.toString("utf8"));
      chmodSync(this.cfg.file, 0o600);
      return state;
    } catch {
      // Do not expose the key, ciphertext, token contents, or crypto-library details.
      throw new Error("Cannot decrypt OAuth state; check its encryption key and integrity");
    }
  }

  save(state: unknown): void {
    const temporary = `${this.cfg.file}.tmp-${randomUUID()}`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.cfg.file), { recursive: true, mode: 0o700 });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
      const bytes = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.cfg.file);
      // Persist the directory entry as well on the Linux hosts this server targets.
      if (process.platform !== "win32") {
        fd = openSync(dirname(this.cfg.file), "r");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
      }
    } catch {
      throw new Error("Cannot persist encrypted OAuth state");
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Keep the original write error. */ } }
      try { unlinkSync(temporary); } catch { /* Already renamed, or not created. */ }
    }
  }
}
