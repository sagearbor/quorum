import { openDB, type IDBPDatabase } from "idb";
import type { ContributeRequest } from "@quorum/types";

interface QueuedContribution {
  id: string;
  quorumId: string;
  payload: ContributeRequest;
  createdAt: number;
}

const DB_NAME = "quorum-offline";
const STORE_NAME = "pending-contributions";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function enqueue(
  quorumId: string,
  payload: ContributeRequest
): Promise<string> {
  const db = await getDb();
  const entry: QueuedContribution = {
    id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    quorumId,
    payload,
    createdAt: Date.now(),
  };
  await db.put(STORE_NAME, entry);
  return entry.id;
}

export async function dequeue(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

export async function getAllPending(): Promise<QueuedContribution[]> {
  const db = await getDb();
  return db.getAll(STORE_NAME);
}

export async function replayQueue(
  apiBase: string,
  onSuccess?: (id: string) => void,
  onError?: (id: string, error: unknown) => void
): Promise<void> {
  const pending = await getAllPending();
  for (const entry of pending) {
    try {
      const res = await fetch(
        `${apiBase}/quorums/${entry.quorumId}/contribute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.payload),
        }
      );
      if (res.ok) {
        await dequeue(entry.id);
        onSuccess?.(entry.id);
      } else {
        onError?.(entry.id, new Error(`HTTP ${res.status}`));
      }
    } catch (err) {
      onError?.(entry.id, err);
    }
  }
}

// Auto-replay on reconnect
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
    replayQueue(apiBase);
  });
}
