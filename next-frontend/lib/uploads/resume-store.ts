import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface StoredUploadSession {
  fingerprint: string;
  sessionId: string;
  publicId: string;
  canonicalUrl: string;
  partSizeBytes: number;
  totalParts: number;
  uploadedParts: { part_number: number; etag: string }[];
  updatedAt: number;
}

interface UploadsDB extends DBSchema {
  sessions: {
    key: string;
    value: StoredUploadSession;
  };
}

const DB_NAME = "streamtube_uploads";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

let dbPromise: Promise<IDBPDatabase<UploadsDB>> | null = null;

function getDB(): Promise<IDBPDatabase<UploadsDB>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB is not supported in this environment"),
    );
  }

  if (!dbPromise) {
    dbPromise = openDB<UploadsDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "fingerprint" });
        }
      },
    });
  }
  return dbPromise;
}

export async function saveUploadSession(
  session: StoredUploadSession,
): Promise<void> {
  const db = await getDB();
  await db.put(STORE_NAME, { ...session, updatedAt: Date.now() });
}

export async function getUploadSession(
  fingerprint: string,
): Promise<StoredUploadSession | undefined> {
  const db = await getDB();
  return db.get(STORE_NAME, fingerprint);
}

export async function addUploadedPart(
  fingerprint: string,
  part: { part_number: number; etag: string },
): Promise<void> {
  const db = await getDB();
  const session = await db.get(STORE_NAME, fingerprint);
  if (session) {
    const existing = session.uploadedParts.filter(
      (p) => p.part_number !== part.part_number,
    );
    existing.push(part);
    existing.sort((a, b) => a.part_number - b.part_number);
    session.uploadedParts = existing;
    session.updatedAt = Date.now();
    await db.put(STORE_NAME, session);
  }
}

export async function deleteUploadSession(fingerprint: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, fingerprint);
}
