/*
 * Exercises the derivation behind the packages table in the settings tab.
 *
 * Every column of that table except Estado is derived from one stored source
 * string — pi's settings value carries no name, no author and no version — so a
 * wrong derivation is invisible in review: the table still looks like a table.
 * Two checks here exist because the owner's real settings file breaks the
 * obvious assumption: `npm:gentle-engram` and `npm:gentle-engram@0.1.14` are
 * stored at the same time, so a row is addressed by its index in the list and
 * never by its source.
 *
 * The module is a browser script rather than a CommonJS module, so it is loaded
 * here the same way the webview loads it: by running the file, which publishes
 * itself on `globalThis`.
 *
 * Run with: npm test
 */
const path = require("node:path");

require(path.join(__dirname, "..", "media", "package-rows.js"));

const {
  PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  parseSource,
  buildRows,
  filterRows,
  sortRows,
  paginate,
  summarize,
} = globalThis.PiCodePackageRows;

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/** The row identities in order: what "the order is untouched" is asserted with. */
const orderOf = (rows) => rows.map((row) => row.index).join(",");

const namesOf = (rows) => rows.map((row) => row.name);

// --- parseSource -----------------------------------------------------------

const PARSE_TABLE = [
  { input: "npm:pi-lens", origin: "npm", name: "pi-lens", author: "", version: "" },
  { input: "npm:@tintinweb/pi-subagents", origin: "npm", name: "pi-subagents", author: "@tintinweb", version: "" },
  { input: "npm:gentle-engram@0.1.14", origin: "npm", name: "gentle-engram", author: "", version: "0.1.14" },
  { input: "npm:@gtrabanco/pi-nan-provider@2.0.0", origin: "npm", name: "pi-nan-provider", author: "@gtrabanco", version: "2.0.0" },
  { input: "git:github.com/HazAT/pi-interactive-subagents", origin: "git", name: "pi-interactive-subagents", author: "HazAT", version: "" },
  { input: "git:github.com/HazAT/pi-interactive-subagents@v1", origin: "git", name: "pi-interactive-subagents", author: "HazAT", version: "v1" },
  { input: "D:\\ext\\my-pkg", origin: "other", name: "my-pkg", author: "", version: "" },
  { input: "", origin: "other", name: "", author: "", version: "" },
];

for (const expected of PARSE_TABLE) {
  const parsed = parseSource(expected.input);
  check(
    `${expected.input === "" ? "(empty spec)" : expected.input} parses to ${expected.origin} / ${
      expected.name || "(no name)"
    } / ${expected.author || "(no author)"} / ${expected.version || "(no version)"}`,
    parsed.origin === expected.origin &&
      parsed.name === expected.name &&
      parsed.author === expected.author &&
      parsed.version === expected.version,
    JSON.stringify(parsed),
  );
}

// --- buildRows -------------------------------------------------------------

const entries = [
  { source: "npm:pi-lens", paused: false },
  { source: "git:github.com/HazAT/pi-interactive-subagents", paused: true },
  { source: "D:\\ext\\my-pkg", paused: false },
];
const list = buildRows(entries);

check("buildRows keeps the stored position as the row identity", orderOf(list) === "0,1,2", orderOf(list));
check(
  "buildRows keeps the entry a row came from, so a write can be placed back",
  list[1].entry === entries[1],
  JSON.stringify(list[1].entry),
);
check(
  "buildRows carries the pause of each entry",
  list[0].paused === false && list[1].paused === true && list[2].paused === false,
  list.map((row) => row.paused).join(","),
);
check(
  "a missing entry still becomes a row instead of throwing",
  buildRows([undefined]).length === 1 && buildRows([undefined])[0].paused === false,
  JSON.stringify(buildRows([undefined])),
);

const duplicates = buildRows([
  { source: "npm:gentle-engram", paused: false },
  { source: "npm:gentle-engram@0.1.14", paused: true },
]);
check(
  "the owner's duplicate package yields two distinct rows, one of them pinned",
  duplicates.length === 2 &&
    duplicates[0] !== duplicates[1] &&
    duplicates[0].index !== duplicates[1].index &&
    duplicates[0].version === "" &&
    duplicates[1].version === "0.1.14" &&
    duplicates[0].name === duplicates[1].name,
  JSON.stringify(duplicates.map((row) => ({ index: row.index, version: row.version }))),
);

// --- filterRows ------------------------------------------------------------

check(
  "the search matches a package name, case-insensitively",
  namesOf(filterRows(list, { query: "LENS" })).join(",") === "pi-lens",
  namesOf(filterRows(list, { query: "LENS" })).join(","),
);
check(
  "the search matches the author column",
  namesOf(filterRows(list, { query: "hazat" })).join(",") === "pi-interactive-subagents",
  namesOf(filterRows(list, { query: "hazat" })).join(","),
);
check(
  "the search matches the version column",
  namesOf(filterRows(buildRows([{ source: "npm:gentle-engram@0.1.14" }, { source: "npm:gentle-engram" }]), { query: "0.1.14" })).join(",") ===
    "gentle-engram",
  "one row",
);
check(
  "search terms are ANDed, so a second term only narrows",
  namesOf(filterRows(list, { query: "pi subagents" })).join(",") ===
    "pi-interactive-subagents" && filterRows(list, { query: "pi inexistente" }).length === 0,
  namesOf(filterRows(list, { query: "pi subagents" })).join(","),
);
check(
  "the search matches what the table shows, not the raw source string",
  filterRows(list, { query: "github.com" }).length === 0 &&
    filterRows(list, { query: "npm:" }).length === 0,
  `${filterRows(list, { query: "github.com" }).length} / ${filterRows(list, { query: "npm:" }).length}`,
);
check(
  "the origin filter keeps one origin and lets all of them through",
  filterRows(list, { origin: "git" }).length === 1 &&
    filterRows(list, { origin: "npm" }).length === 1 &&
    filterRows(list, { origin: "other" }).length === 1 &&
    filterRows(list, { origin: "all" }).length === 3,
  `${filterRows(list, { origin: "git" }).length}`,
);
check(
  "the status filter separates paused from active",
  namesOf(filterRows(list, { status: "paused" })).join(",") === "pi-interactive-subagents" &&
    filterRows(list, { status: "active" }).length === 2 &&
    filterRows(list, { status: "all" }).length === 3,
  namesOf(filterRows(list, { status: "paused" })).join(","),
);
check(
  "a query, an origin and a status combine with AND",
  namesOf(filterRows(list, { query: "subagents", origin: "git", status: "paused" })).join(",") ===
    "pi-interactive-subagents" &&
    filterRows(list, { query: "lens", origin: "git", status: "all" }).length === 0,
  namesOf(filterRows(list, { query: "subagents", origin: "git", status: "paused" })).join(","),
);
check(
  "an absent filter object filters nothing",
  filterRows(list, {}).length === 3 && filterRows(list, undefined).length === 3,
  "",
);

const beforeFilter = orderOf(list);
filterRows(list, { query: "pi", origin: "npm", status: "paused" });
check("filtering never mutates the rows it was given", orderOf(list) === beforeFilter, orderOf(list));

// --- sortRows --------------------------------------------------------------

const untouchedBefore = orderOf(list);
const sortedByName = sortRows(list, { key: "name", direction: "asc" });
check(
  "name ascending orders the table alphabetically",
  namesOf(sortedByName).join(",") ===
    ["my-pkg", "pi-interactive-subagents", "pi-lens"].join(","),
  namesOf(sortedByName).join(","),
);
check(
  "name descending is name ascending reversed",
  namesOf(sortRows(list, { key: "name", direction: "desc" })).join(",") ===
    namesOf(sortedByName).slice().reverse().join(","),
  namesOf(sortRows(list, { key: "name", direction: "desc" })).join(","),
);

const byStatusAsc = sortRows(list, { key: "status", direction: "asc" });
check(
  "status ascending puts the active packages first",
  byStatusAsc.map((row) => row.paused).join(",") === "false,false,true",
  byStatusAsc.map((row) => row.paused).join(","),
);
check(
  "status descending puts the paused packages first",
  sortRows(list, { key: "status", direction: "desc" }).map((row) => row.paused).join(",") ===
    "true,false,false",
  sortRows(list, { key: "status", direction: "desc" }).map((row) => row.paused).join(","),
);

const versions = buildRows([
  { source: "npm:a@0.1.14" },
  { source: "npm:b@0.1.9" },
  { source: "npm:c" },
  { source: "git:github.com/u/d@v1" },
]);
const versionsAsc = sortRows(versions, { key: "version", direction: "asc" }).map((row) => row.version);
check(
  "version ascending compares numerically, so 0.1.9 comes before 0.1.14",
  versionsAsc.indexOf("0.1.9") < versionsAsc.indexOf("0.1.14"),
  versionsAsc.join(","),
);
check(
  "a package with no version sorts last when ascending",
  versionsAsc[versionsAsc.length - 1] === "",
  versionsAsc.join(","),
);
check(
  "version descending is version ascending reversed",
  sortRows(versions, { key: "version", direction: "desc" })
    .map((row) => row.version)
    .join(",") === versionsAsc.slice().reverse().join(","),
  sortRows(versions, { key: "version", direction: "desc" })
    .map((row) => row.version)
    .join(","),
);
check(
  "an unknown sort key leaves the order untouched",
  orderOf(sortRows(list, { key: "author", direction: "desc" })) === untouchedBefore,
  orderOf(sortRows(list, { key: "author", direction: "desc" })),
);
check(
  "sorting returns a copy and never mutates the rows it was given",
  sortRows(list, { key: "name", direction: "desc" }) !== list && orderOf(list) === untouchedBefore,
  orderOf(list),
);

// --- paginate --------------------------------------------------------------

const many = buildRows(
  Array.from({ length: 45 }, (_, index) => ({ source: "npm:pkg-" + index, paused: false })),
);
const firstPage = paginate(many, { page: 1, pageSize: 20 });
check(
  "paginate reports the pages the row count needs",
  firstPage.pageCount === 3 && firstPage.total === 45 && firstPage.page === 1,
  JSON.stringify({ page: firstPage.page, pageCount: firstPage.pageCount, total: firstPage.total }),
);
check(
  "paginate slices the rows of the requested page",
  firstPage.items.length === 20 &&
    firstPage.items[0].index === 0 &&
    paginate(many, { page: 2, pageSize: 20 }).items[0].index === 20 &&
    paginate(many, { page: 2, pageSize: 20 }).items.length === 20 &&
    paginate(many, { page: 3, pageSize: 20 }).items.length === 5,
  firstPage.items.length + " items",
);
check(
  "paginate numbers the slice it is showing",
  firstPage.start === 1 && firstPage.end === 20 && paginate(many, { page: 2, pageSize: 20 }).start === 21,
  `${firstPage.start}-${firstPage.end}`,
);
check(
  "paginate clamps a page past the last one onto the last one",
  paginate(many, { page: 99, pageSize: 20 }).page === 3,
  String(paginate(many, { page: 99, pageSize: 20 }).page),
);
check(
  "paginate clamps a page before the first one onto the first one",
  paginate(many, { page: 0, pageSize: 20 }).page === 1 &&
    paginate(many, { page: -5, pageSize: 20 }).page === 1,
  String(paginate(many, { page: -5, pageSize: 20 }).page),
);
check(
  "paged is false while everything fits on one page",
  paginate(list, { page: 1, pageSize: DEFAULT_PAGE_SIZE }).paged === false &&
    firstPage.paged === true,
  `${paginate(list, { page: 1, pageSize: DEFAULT_PAGE_SIZE }).paged} / ${firstPage.paged}`,
);
check(
  "an empty table still has one page and no rows to show",
  paginate([], { page: 1, pageSize: 20 }).pageCount === 1 &&
    paginate([], { page: 1, pageSize: 20 }).items.length === 0 &&
    paginate([], { page: 1, pageSize: 20 }).paged === false,
  JSON.stringify(paginate([], { page: 1, pageSize: 20 })),
);

// --- summarize -------------------------------------------------------------

check(
  "summarize counts active and paused over the rows it was given",
  summarize(list).total === 3 && summarize(list).active === 2 && summarize(list).paused === 1,
  JSON.stringify(summarize(list)),
);
check(
  "summarize of nothing is zeroes rather than a missing object",
  summarize([]).total === 0 && summarize([]).active === 0 && summarize([]).paused === 0,
  JSON.stringify(summarize([])),
);
check(
  "summarize counts the filtered rows, not the whole stored list",
  JSON.stringify(summarize(filterRows(list, { status: "paused" }))) ===
    JSON.stringify({ total: 1, paused: 1, active: 0 }),
  JSON.stringify(summarize(filterRows(list, { status: "paused" }))),
);

// --- constants -------------------------------------------------------------

check(
  "PAGE_SIZES offers the three page sizes the selector shows",
  Array.isArray(PAGE_SIZES) && PAGE_SIZES.join(",") === "20,50,100",
  String(PAGE_SIZES),
);
check(
  "DEFAULT_PAGE_SIZE is a size the selector offers",
  PAGE_SIZES.indexOf(DEFAULT_PAGE_SIZE) !== -1,
  String(DEFAULT_PAGE_SIZE),
);

let failed = 0;
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
