import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const manifestDoc = {
  get: async () => {
    reads++;
    beforeReadingManifest?.();
    return snapshot();
  },
  collection: () => manifestDoc,
  doc: () => manifestDoc,
  listCollections: async () => {
    beforeListingCollections?.();
    return [];
  },
};
function snapshot() {
  const data = manifest;
  return { exists: data !== undefined, data: () => data };
}
let manifest: Record<string, unknown> | undefined;
let reads = 0;
let writes = 0;
let transactions = 0;
let beforeListingCollections: (() => void) | undefined;
let beforeReadingManifest: (() => void) | undefined;
let tail = Promise.resolve<unknown>(undefined);
const firestore = {
  collection: () => manifestDoc,
  runTransaction<T>(callback: (tx: { get: typeof manifestDoc.get; set: (doc: unknown, data: Record<string, unknown>) => void }) => Promise<T>): Promise<T> {
    transactions++;
    const result = tail.then(() => callback({
      get: manifestDoc.get,
      set: (_doc, data) => { writes++; manifest = data; },
    }));
    tail = result.catch(() => undefined);
    return result;
  },
};

// Resolve the server's extensionless imports and replace its Firestore entry
// point so this test cannot contact a live project.
Object.defineProperty(globalThis, Symbol.for("picode.test.manifest.firestore"), { value: firestore });
register("data:text/javascript," + encodeURIComponent(`
  const fake = 'data:text/javascript,' + encodeURIComponent(
    'export const firestore = () => globalThis[Symbol.for("picode.test.manifest.firestore")];'
  );
  export async function resolve(specifier, context, next) {
    if (specifier === './firebase-admin' && context.parentURL?.includes('/src/lib/')) {
      return next(fake, context);
    }
    try {
      return await next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
      throw error;
    }
  }
`));
const { readOrCreateManifest, writeResource } = await import("../src/lib/store.ts");

test("an unchanged manifest takes one Firestore read and no transaction", async () => {
  manifest = { latest: { settings: "settings-ref" }, revisions: {}, usedBytes: 0, session: "session", ref: "revision" };
  assert.deepEqual(await readOrCreateManifest("user"), {
    latest: { settings: "settings-ref" }, session: "session", ref: "revision", collections: {},
  });
  assert.equal(reads, 1);
  assert.equal(transactions, 0);
  assert.equal(writes, 0);
});

test("concurrent first reads create a single shared manifest", async () => {
  manifest = undefined;
  writes = 0;
  const [first, second] = await Promise.all([readOrCreateManifest("user"), readOrCreateManifest("user")]);
  assert.ok(first.session);
  assert.deepEqual(second, first);
  assert.equal(writes, 1);
});

test("a legacy manifest is still upgraded on demand", async () => {
  manifest = { latest: { settings: "settings-ref" }, session: "legacy-session", ref: "legacy-revision" };
  const result = await readOrCreateManifest("user");
  assert.deepEqual(result.latest, { settings: "settings-ref" });
  assert.equal(result.session, "legacy-session");
  assert.deepEqual(manifest.revisions, {});
  assert.equal(manifest.usedBytes, 0);
});

test("a current manifest is read once when committing an upload", async () => {
  manifest = { latest: {}, revisions: {}, usedBytes: 0, session: "session", ref: "revision" };
  reads = 0;
  transactions = 0;
  const ref = await writeResource("user", "settings", { version: 1, content: "{}" }, undefined, "pro");
  assert.equal(reads, 1);
  assert.equal(transactions, 1);
  assert.deepEqual(manifest.latest, { settings: ref });
  assert.equal(manifest.session, "session");
});

test("upload upgrades a legacy manifest before committing a revision", async () => {
  manifest = { latest: {}, session: "legacy-session", ref: "legacy-revision" };
  const ref = await writeResource("user", "settings", { version: 1, content: "{}" }, undefined, "pro");
  assert.deepEqual(manifest.latest, { settings: ref });
  assert.equal(manifest.session, "legacy-session");
  assert.ok(typeof manifest.usedBytes === "number" && manifest.usedBytes > 0);
});

test("a legacy upgrade cannot recreate a manifest cleared during its scan", async () => {
  manifest = { latest: { settings: "old-settings" }, session: "old-session", ref: "old-revision" };
  beforeListingCollections = () => { manifest = undefined; };
  try {
    await assert.rejects(readOrCreateManifest("user"), { status: 503 });
    assert.equal(manifest, undefined);
  } finally {
    beforeListingCollections = undefined;
  }
});

test("an upload cannot recreate a manifest cleared between upgrade and commit", async () => {
  manifest = { latest: {}, session: "old-session", ref: "old-revision" };
  beforeReadingManifest = () => {
    if (manifest?.revisions !== undefined) {
      manifest = undefined;
    }
  };
  try {
    await assert.rejects(writeResource("user", "settings", { version: 1, content: "{}" }, undefined, "pro"), { status: 503 });
    assert.equal(manifest, undefined);
  } finally {
    beforeReadingManifest = undefined;
  }
});
