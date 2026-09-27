import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Credentials people give Romanum, such as Open Cloud API keys, are encrypted with AES-256-GCM before they're
// stored. The 32-byte key comes from ROMANUM_SECRETS_KEY (base64). In local development it's generated once under
// .local/, beside the local database's credentials; a production deployment must set the variable.

export type SealedSecret = { keyVersion: number; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };

/** Bumped when the encryption key is replaced, so each stored secret says which key sealed it. */
const KEY_VERSION = 1;

function decodeKey(value: string, source: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new Error(`${source} must be 32 bytes, base64-encoded.`);
  return key;
}

async function localKey(): Promise<Buffer> {
  // A static path, so the build traces only this file.
  const file = path.join(process.cwd(), ".local", "secrets", "credentials.key");
  try {
    return decodeKey(await readFile(file, "utf8"), "The local secrets key");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another process created it first; use that one.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return decodeKey(await readFile(file, "utf8"), "The local secrets key");
}

let loading: Promise<Buffer> | undefined;

/** The key that seals stored credentials. */
export function secretsKey(): Promise<Buffer> {
  if (!loading) {
    const configured = process.env.ROMANUM_SECRETS_KEY;
    loading = configured
      ? Promise.resolve().then(() => decodeKey(configured, "ROMANUM_SECRETS_KEY"))
      : process.env.NODE_ENV === "production"
        ? Promise.reject(new Error("ROMANUM_SECRETS_KEY is required in production."))
        : localKey();
    // A failure isn't kept, so a later call can succeed once the key is in place.
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

/**
 * Encrypts a secret. `context` names the record it belongs to and must match to open it, so a sealed secret can't
 * be copied onto another record.
 */
export function sealSecret(plain: string, context: string, key: Buffer): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { keyVersion: KEY_VERSION, iv, ciphertext, tag: cipher.getAuthTag() };
}

/** Decrypts a sealed secret. Throws if it was altered, sealed for another record or sealed with another key. */
export function openSecret(sealed: SealedSecret, context: string, key: Buffer): string {
  if (sealed.keyVersion !== KEY_VERSION) throw new Error("This secret was sealed with a key Romanum no longer has.");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}
