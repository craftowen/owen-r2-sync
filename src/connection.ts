import type { DriveTokens } from "./drive";

const PREFIX = "OWEN-GDRIVE-1";
const ITERATIONS = 210_000;
const MAX_AGE_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ConnectionPayload {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId: string | null;
  driveFolderName: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < 12) {
    throw new Error("Transfer passphrase must be at least 12 characters.");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: exactBuffer(salt), iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptConnectionPayload(
  input: Omit<ConnectionPayload, "version" | "issuedAt" | "expiresAt">,
  passphrase: string,
  now = Date.now()
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const payload: ConnectionPayload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + MAX_AGE_MS,
    ...input,
  };
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: exactBuffer(iv), additionalData: encoder.encode(PREFIX) },
    key,
    encoder.encode(JSON.stringify(payload))
  );
  return [PREFIX, toBase64Url(salt), toBase64Url(iv), toBase64Url(new Uint8Array(cipher))].join(".");
}

export async function decryptConnectionPayload(
  code: string,
  passphrase: string,
  now = Date.now()
): Promise<ConnectionPayload> {
  const [prefix, saltPart, ivPart, cipherPart, extra] = code.trim().split(".");
  if (prefix !== PREFIX || !saltPart || !ivPart || !cipherPart || extra) {
    throw new Error("Connection code format is invalid.");
  }
  const salt = fromBase64Url(saltPart);
  const iv = fromBase64Url(ivPart);
  const key = await deriveKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: exactBuffer(iv), additionalData: encoder.encode(PREFIX) },
    key,
    exactBuffer(fromBase64Url(cipherPart))
  );
  const payload = JSON.parse(decoder.decode(plain)) as Partial<ConnectionPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.clientId !== "string" ||
    typeof payload.clientSecret !== "string" ||
    typeof payload.refreshToken !== "string" ||
    !payload.clientId ||
    !payload.clientSecret ||
    !payload.refreshToken ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    payload.issuedAt > now + 5 * 60 * 1000 ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt < now ||
    payload.expiresAt - payload.issuedAt > MAX_AGE_MS
  ) {
    throw new Error("Connection code is expired or incomplete.");
  }
  if (
    payload.rootFolderId !== null &&
    (typeof payload.rootFolderId !== "string" || !payload.rootFolderId)
  ) {
    throw new Error("Connection code Drive folder is invalid.");
  }
  if (typeof payload.driveFolderName !== "string") {
    throw new Error("Connection code folder name is invalid.");
  }
  return payload as ConnectionPayload;
}

export function importedTokens(payload: ConnectionPayload): DriveTokens {
  return {
    accessToken: "",
    refreshToken: payload.refreshToken,
    expiresAt: 0,
  };
}

export async function presentConnectionCode(
  code: string,
  display: (value: string) => void,
  writeClipboard?: (value: string) => Promise<void>
): Promise<boolean> {
  display(code);
  if (!writeClipboard) return false;
  try {
    await writeClipboard(code);
    return true;
  } catch {
    return false;
  }
}
