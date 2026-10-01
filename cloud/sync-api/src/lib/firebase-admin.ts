import { App, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let cachedApp: App | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function initAdmin(): App {
  const existing = getApps().find((app) => app.name === "picode-sync-api");
  if (existing) {
    return existing;
  }
  const projectId = requiredEnv("FIREBASE_PROJECT_ID");
  const clientEmail = requiredEnv("FIREBASE_CLIENT_EMAIL");
  // Env files commonly store the key with literal "\n"; restore real newlines.
  const privateKey = requiredEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  return initializeApp(
    {
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    },
    "picode-sync-api",
  );
}

export function firebaseAdmin(): App {
  cachedApp ??= initAdmin();
  return cachedApp;
}

export function firestore() {
  return getFirestore(firebaseAdmin());
}

export const FIRESTORE_COLLECTIONS = {
  /** Per-user sync manifest: /users/{uid}/manifest */
  users: "users",
  /** Per-user, per-collection resource payloads: /users/{uid}/data/{collection}/{ref} */
  data: "data",
} as const;
