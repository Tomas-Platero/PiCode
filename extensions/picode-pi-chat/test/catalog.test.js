/*
 * Exercises the catalogue search and the package type resolver.
 *
 * pi's gallery tags every package with a type derived from the key names of the `pi`
 * object in the package's own manifest, and no API exposes it: the type has to be read
 * from the full npm document, one package per request. That makes both the paging of the
 * search and the fan-out of the resolver things a reviewer cannot see by reading a diff —
 * and both are wrong in ways that look fine until the registry answers oddly.
 *
 * Everything here is hermetic. `globalThis.fetch` is replaced by a stub before either
 * module is loaded, the stub records every URL it was asked for, and the real registry is
 * never reached.
 *
 * Run with: npm test
 */
const path = require("node:path");
const Module = require("node:module");

// pi-cli.ts imports runtime.ts, which imports `vscode`. The stub keeps both modules
// loadable outside an editor.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

// --- the stubbed registry ---------------------------------------------------

/** Every request the code under test made, in order. */
const calls = [];

/** How the next request is answered; each check installs its own handler. */
let respond = () => {
  throw new Error("the test did not declare what the registry answers");
};

globalThis.fetch = async (url, init) => {
  const call = { url: String(url), headers: (init && init.headers) || {} };
  calls.push(call);
  return respond(call);
};

/** A handler plus a clean request log, which is the setup every check needs. */
const resetRegistry = (handler) => {
  calls.length = 0;
  respond = handler;
};

const jsonResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null),
  },
  json: async () => body,
});

const searchObject = (name, version, keywords, monthly) => ({
  package: {
    name,
    version,
    description: `${name} lo hace`,
    keywords,
    links: { repository: `https://example.test/${name}` },
  },
  downloads: { monthly },
});

const {
  PI_TYPE_KEYS,
  typeTagsFromPiObject,
  encodePackageName,
  clearPackageTypeCache,
  resolvePackageTypes,
} = require("../out/catalog.js");
const { searchCatalog, searchCatalogPage } = require("../out/pi-cli.js");

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });
const tagsOf = (map, name) => (map.get(name) || []).join(",");

// --- the pure mapping -------------------------------------------------------

check(
  "the four keys are the ones pi's gallery reads, in the order it concatenates them",
  PI_TYPE_KEYS.map((entry) => entry.key).join(",") === "extensions,skills,prompts,themes",
  PI_TYPE_KEYS.map((entry) => entry.key).join(","),
);

// Every combination of the four keys, because the rule is a concatenation and an
// implementation that forgets one key or reorders two passes a single-key test.
for (let mask = 0; mask < 1 << PI_TYPE_KEYS.length; mask += 1) {
  const pi = {};
  const expected = [];
  PI_TYPE_KEYS.forEach((entry, index) => {
    if ((mask & (1 << index)) !== 0) {
      pi[entry.key] = [`./${entry.key}`];
      expected.push(entry.tag);
    }
  });

  const label =
    expected.length === 0 ? "an empty pi object is a plain package" : `${expected.join("+")} comes back in pi's order`;
  const want = expected.length > 0 ? expected.join(",") : "package";
  check(label, typeTagsFromPiObject(pi).join(",") === want, `${typeTagsFromPiObject(pi).join(",")} (want ${want})`);
}

check(
  "a manifest with no pi object is a plain package",
  typeTagsFromPiObject(undefined).join(",") === "package",
  typeTagsFromPiObject(undefined).join(","),
);
check(
  "a null pi is a plain package rather than a crash",
  typeTagsFromPiObject(null).join(",") === "package",
  typeTagsFromPiObject(null).join(","),
);
check(
  "a pi that is not an object is a plain package",
  typeTagsFromPiObject("extensions").join(",") === "package" &&
    typeTagsFromPiObject(["./extensions"]).join(",") === "package",
  typeTagsFromPiObject("extensions").join(","),
);
check(
  "a pi object of unrecognised keys is a plain package",
  typeTagsFromPiObject({ extension: true, mcp: [] }).join(",") === "package",
  typeTagsFromPiObject({ extension: true, mcp: [] }).join(","),
);
check(
  "a key counts when it is present, even empty: the tag comes from the key name",
  typeTagsFromPiObject({ extensions: [] }).join(",") === "extension",
  typeTagsFromPiObject({ extensions: [] }).join(","),
);
check(
  "inherited keys are not keys of the manifest",
  typeTagsFromPiObject(Object.create({ themes: true })).join(",") === "package",
  typeTagsFromPiObject(Object.create({ themes: true })).join(","),
);

// --- the name encoding ------------------------------------------------------

check("a plain name goes through untouched", encodePackageName("pi-lens") === "pi-lens", encodePackageName("pi-lens"));
check(
  "a scoped name has its separator encoded and keeps its @",
  encodePackageName("@tintinweb/pi-subagents") === "@tintinweb%2Fpi-subagents",
  encodePackageName("@tintinweb/pi-subagents"),
);

// --- an async pass over the stub --------------------------------------------

async function main() {
  // The search URL, its paging and its keyword re-check.
  resetRegistry(() =>
    jsonResponse({
      total: 42,
      objects: [
        searchObject("pi-lens", "1.2.3", ["pi-package", "lens"], 1200),
        searchObject("left-pad", "1.0.0", ["padding"], 9000),
      ],
    }),
  );
  const page = await searchCatalogPage("memory", { limit: 10, offset: 20 });
  check(
    "the search asks for the keyword, the page size and the offset",
    calls[0] &&
      calls[0].url ===
        "https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package%20memory&size=10&from=20",
    calls[0] && calls[0].url,
  );
  check(
    "the search asks for the full document, not json in general",
    calls[0] && calls[0].headers.accept === "application/json",
    JSON.stringify(calls[0] && calls[0].headers),
  );
  check(
    "the page carries the registry total and the offset it started at",
    page.total === 42 && page.offset === 20,
    JSON.stringify({ total: page.total, offset: page.offset }),
  );
  check(
    "the keyword re-check still drops what the registry returned for the keyword alone",
    page.packages.length === 1 && page.packages[0].name === "pi-lens",
    page.packages.map((pkg) => pkg.name).join(","),
  );
  check(
    "a kept result carries its version, description, downloads and repository",
    page.packages[0].version === "1.2.3" &&
      page.packages[0].description === "pi-lens lo hace" &&
      page.packages[0].monthlyDownloads === 1200 &&
      page.packages[0].repository === "https://example.test/pi-lens",
    JSON.stringify(page.packages[0]),
  );

  resetRegistry(() => jsonResponse({ total: 7, objects: [searchObject("pi-lens", "1.2.3", ["pi-package"], 0)] }));
  const single = await searchCatalog("");
  check(
    "the single-page search still works for its existing caller",
    Array.isArray(single) && single.length === 1 && single[0].name === "pi-lens",
    JSON.stringify(single.map((pkg) => pkg.name)),
  );
  check(
    "an empty query asks for the keyword alone, with the default page size at the start",
    calls[0] &&
      calls[0].url === "https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=25&from=0",
    calls[0] && calls[0].url,
  );

  resetRegistry(() => jsonResponse({ objects: [] }));
  const clamped = await searchCatalogPage("x", { limit: 500, offset: -5 });
  check(
    "a page size past what the registry accepts is clamped instead of failing there",
    calls[0] && calls[0].url.endsWith("&size=250&from=0"),
    calls[0] && calls[0].url,
  );
  check(
    "a page with no count falls back to the offset plus what came back",
    clamped.total === 0 && clamped.offset === 0,
    JSON.stringify({ total: clamped.total, offset: clamped.offset }),
  );

  resetRegistry(() => jsonResponse({ objects: [searchObject("pi-lens", "1.2.3", ["pi-package"], 5)] }));
  const uncounted = await searchCatalogPage("lens", { offset: 50 });
  check(
    "a registry that prints no total still yields a usable floor",
    uncounted.total === 51 && uncounted.offset === 50,
    JSON.stringify({ total: uncounted.total, offset: uncounted.offset }),
  );

  // A scoped name, resolved through the encoded path.
  resetRegistry(() =>
    jsonResponse({ name: "@tintinweb/pi-subagents", version: "2.0.0", pi: { extensions: ["./ext"] } }),
  );
  clearPackageTypeCache();
  const scoped = await resolvePackageTypes([{ name: "@tintinweb/pi-subagents", version: "2.0.0" }]);
  check(
    "a scoped package is requested with its slash encoded and its @ kept",
    calls.length === 1 && calls[0].url === "https://registry.npmjs.org/@tintinweb%2Fpi-subagents/latest",
    calls.map((call) => call.url).join(" "),
  );
  check(
    "the type request asks for the full document, which is where pi is",
    calls[0] && calls[0].headers.accept === "application/json",
    JSON.stringify(calls[0] && calls[0].headers),
  );
  check(
    "a scoped package resolves to its tag",
    tagsOf(scoped, "@tintinweb/pi-subagents") === "extension",
    tagsOf(scoped, "@tintinweb/pi-subagents"),
  );

  // A 404.
  resetRegistry(() => jsonResponse({ error: "Not found" }, 404));
  clearPackageTypeCache();
  const missing = await resolvePackageTypes([{ name: "does-not-exist", version: "1.0.0" }]);
  check(
    "a 404 is a plain package rather than a failure",
    tagsOf(missing, "does-not-exist") === "package",
    tagsOf(missing, "does-not-exist"),
  );
  check("a 404 is not retried", calls.length === 1, `${calls.length} requests`);

  // A refusal, then a success.
  let attempt = 0;
  resetRegistry(() => {
    attempt += 1;
    return attempt === 1
      ? jsonResponse({ error: "throttled" }, 503, { "retry-after": "0" })
      : jsonResponse({ version: "1.0.0", pi: { skills: ["./skills"] } });
  });
  clearPackageTypeCache();
  const retried = await resolvePackageTypes([{ name: "flaky", version: "1.0.0" }], { retryDelayMs: 1 });
  check(
    "a refusal is waited out and the retry's answer is the one used",
    calls.length === 2 && tagsOf(retried, "flaky") === "skill",
    `${calls.length} requests, ${tagsOf(retried, "flaky")}`,
  );

  resetRegistry(() => jsonResponse({ error: "throttled" }, 429, { "retry-after": "0" }));
  clearPackageTypeCache();
  const throttled = await resolvePackageTypes([{ name: "throttled" }], { maxAttempts: 2, retryDelayMs: 1 });
  check(
    "a package that keeps being refused comes back as a plain package",
    tagsOf(throttled, "throttled") === "package",
    tagsOf(throttled, "throttled"),
  );
  check("retries stop at the attempt limit", calls.length === 2, `${calls.length} requests`);

  resetRegistry(() => jsonResponse({ error: "bad request" }, 400));
  clearPackageTypeCache();
  await resolvePackageTypes([{ name: "rejected" }], { maxAttempts: 3, retryDelayMs: 1 });
  check("a client error that will not change is not retried", calls.length === 1, `${calls.length} requests`);

  // The cache.
  resetRegistry(() => jsonResponse({ version: "1.0.0", pi: { themes: ["./themes"] } }));
  clearPackageTypeCache();
  const firstAsk = await resolvePackageTypes([{ name: "cached-pkg", version: "1.0.0" }]);
  const secondAsk = await resolvePackageTypes([{ name: "cached-pkg", version: "1.0.0" }]);
  check(
    "the second ask about the same name and version costs no request",
    calls.length === 1,
    `${calls.length} requests`,
  );
  check(
    "the cached answer is the same tags",
    tagsOf(firstAsk, "cached-pkg") === "theme" && tagsOf(secondAsk, "cached-pkg") === "theme",
    `${tagsOf(firstAsk, "cached-pkg")} / ${tagsOf(secondAsk, "cached-pkg")}`,
  );

  await resolvePackageTypes([{ name: "cached-pkg", version: "2.0.0" }]);
  check(
    "another version is asked again, so a package that gained a type is not served a stale tag",
    calls.length === 2,
    `${calls.length} requests`,
  );

  clearPackageTypeCache();
  await resolvePackageTypes([{ name: "cached-pkg", version: "1.0.0" }]);
  check("clearing the cache makes the next ask go out again", calls.length === 3, `${calls.length} requests`);

  resetRegistry(() => jsonResponse({ version: "1.0.0", pi: { prompts: ["./prompts"] } }));
  clearPackageTypeCache();
  await resolvePackageTypes([
    { name: "dupe-pkg", version: "1.0.0" },
    { name: "dupe-pkg", version: "1.0.0" },
  ]);
  check("the same row twice costs one request", calls.length === 1, `${calls.length} requests`);

  // One package failing while its siblings still resolve.
  resetRegistry((call) => {
    if (call.url.includes("boom")) {
      return jsonResponse({ error: "nope" }, 400);
    }
    if (call.url.includes("offline")) {
      throw new Error("la red se cayó");
    }
    if (call.url.includes("pi-lens")) {
      return jsonResponse({ version: "1.0.0", pi: { extensions: ["./ext"] } });
    }
    return jsonResponse({ version: "1.0.0", pi: { prompts: ["./prompts"] } });
  });
  clearPackageTypeCache();
  const batch = await resolvePackageTypes([
    { name: "boom", version: "1.0.0" },
    { name: "offline", version: "1.0.0" },
    { name: "pi-lens", version: "1.0.0" },
    { name: "prompt-pack", version: "1.0.0" },
  ]);
  check(
    "a package the registry refuses falls back without failing the batch",
    tagsOf(batch, "boom") === "package",
    tagsOf(batch, "boom"),
  );
  check(
    "a package that cannot be reached falls back the same way",
    tagsOf(batch, "offline") === "package",
    tagsOf(batch, "offline"),
  );
  check(
    "the siblings of a failing package still resolve",
    tagsOf(batch, "pi-lens") === "extension" && tagsOf(batch, "prompt-pack") === "prompt",
    `${tagsOf(batch, "pi-lens")} / ${tagsOf(batch, "prompt-pack")}`,
  );
  check(
    "every package asked about is in the answer, failed ones included",
    batch.size === 4,
    `${batch.size} entries`,
  );

  // Bounded concurrency.
  let inFlight = 0;
  let maxInFlight = 0;
  resetRegistry(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return jsonResponse({ version: "1.0.0", pi: {} });
  });
  clearPackageTypeCache();
  const fanOut = await resolvePackageTypes(
    Array.from({ length: 6 }, (_, index) => ({ name: `fanout-${index}`, version: "1.0.0" })),
    { concurrency: 2 },
  );
  check(
    "the fan-out stays at the requested number of requests in flight",
    maxInFlight === 2,
    `${maxInFlight} in flight at once`,
  );
  check(
    "the fan-out answers every package",
    fanOut.size === 6 && calls.length === 6,
    `${fanOut.size} entries over ${calls.length} requests`,
  );
}

let failed = 0;
const report = () => {
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${result.label}${result.ok || !result.detail ? "" : ` -> ${result.detail}`}`,
    );
    if (!result.ok) {
      failed += 1;
    }
  }
  console.log(
    failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} of ${results.length} CHECKS FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
};

main().then(report, (error) => {
  console.error(error);
  process.exit(1);
});
