/*
 * Exercises the derivation behind the skills table in the settings tab.
 *
 * A discovered skill arrives from `src/skills.ts` already resolved — its route,
 * its name, whether pi is loading it — so the table's real work is turning that
 * list into rows a human can scan: one Spanish label per route, one filter the
 * search box can use, one order per column. None of that is visible in review,
 * because a wrong label still renders as a label.
 *
 * The module is a browser script rather than a CommonJS module, so it is loaded
 * here the same way the webview loads it: by running the file, which publishes
 * itself on `globalThis`.
 *
 * Run with: npm test
 */
const path = require("node:path");

require(path.join(__dirname, "..", "media", "skill-rows.js"));

const {
  PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  buildRows,
  filterRows,
  sortRows,
  paginate,
  summarize,
} = globalThis.PiCodeSkillRows;

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

/** The row identities in order: what "the order is untouched" is asserted with. */
const orderOf = (rows) => rows.map((row) => row.index).join(",");

const namesOf = (rows) => rows.map((row) => row.name);

const statesOf = (rows) => rows.map((row) => row.enabled).join(",");

// --- fixtures --------------------------------------------------------------

/* The four shapes the settings table has to render, one per route plus both
 * package cases: a package with a manifest name, and one whose name pi did not
 * report, which is labelled with its source spec instead. */
const skills = [
  {
    name: "gentle-ai",
    description: "Disciplina de harness para pi",
    source: "pi",
    canToggle: false,
    enabled: true,
    dir: "C:\\agent\\skills\\gentle-ai",
    path: "C:\\agent\\skills\\gentle-ai\\SKILL.md",
  },
  {
    name: "branch-pr",
    description: "Pull requests con comprobación de issue",
    source: "package",
    packageSource: "npm:gentle-pi",
    packageName: "gentle-pi",
    pattern: "skills/branch-pr/SKILL.md",
    canToggle: true,
    enabled: true,
  },
  {
    name: "vitest",
    description: "",
    source: "package",
    packageSource: "npm:pi-test-kit",
    pattern: "skills/vitest/SKILL.md",
    canToggle: true,
    enabled: false,
  },
  {
    name: "deploy",
    description: "Despliega el proyecto",
    source: "project",
    canToggle: false,
    enabled: false,
  },
];

const list = buildRows(skills);

// --- buildRows -------------------------------------------------------------

check("buildRows yields one row per discovered skill", list.length === 4, String(list.length));
check("buildRows keeps the discovery order as the row identity", orderOf(list) === "0,1,2,3", orderOf(list));
check(
  "buildRows keeps the skill a row came from, so a write can be placed back",
  list[1].skill === skills[1],
  JSON.stringify(list[1].skill),
);
check(
  "buildRows carries the name and the description",
  list[0].name === "gentle-ai" && list[0].description === "Disciplina de harness para pi",
  `${list[0].name} / ${list[0].description}`,
);
check(
  "a missing description becomes an empty string instead of undefined",
  buildRows([{ name: "sin-desc", source: "pi", canToggle: false, enabled: false }])[0].description === "",
  JSON.stringify(buildRows([{ name: "sin-desc", source: "pi" }])[0].description),
);
check(
  "buildRows carries the route as the row origin",
  list.map((row) => row.origin).join(",") === "pi,package,package,project",
  list.map((row) => row.origin).join(","),
);
check(
  "only the package rows can be toggled",
  list.map((row) => row.canToggle).join(",") === "false,true,true,false",
  list.map((row) => row.canToggle).join(","),
);
check(
  "buildRows carries whether pi is loading each skill",
  statesOf(list) === "true,true,false,false",
  statesOf(list),
);
check(
  "only the package row carries its filter pattern",
  list[1].pattern === "skills/branch-pr/SKILL.md" && list[1].canToggle === true,
  String(list[1].pattern),
);
check(
  "the package row carries the package name for its label",
  list[1].packageName === "gentle-pi",
  String(list[1].packageName),
);
check(
  "a missing skill still becomes a row instead of throwing",
  buildRows([undefined]).length === 1 &&
    buildRows([undefined])[0].name === "" &&
    buildRows([undefined])[0].enabled === false,
  JSON.stringify(buildRows([undefined])),
);
check("an empty discovery yields no rows", buildRows([]).length === 0, String(buildRows([]).length));

// --- the three labels ------------------------------------------------------

check(
  "the pi route is labelled pi",
  list[0].originLabel === "pi",
  list[0].originLabel,
);
check(
  "the package route is labelled with the package name",
  list[1].originLabel === "gentle-pi",
  list[1].originLabel,
);
check(
  "a package with no reported name falls back to its source spec",
  list[2].originLabel === "npm:pi-test-kit",
  list[2].originLabel,
);
check(
  "the project route is labelled proyecto",
  list[3].originLabel === "proyecto",
  list[3].originLabel,
);

// --- filterRows ------------------------------------------------------------

check(
  "the search matches a skill name, case-insensitively",
  namesOf(filterRows(list, { query: "VITEST" })).join(",") === "vitest",
  namesOf(filterRows(list, { query: "VITEST" })).join(","),
);
check(
  "the search matches the description",
  namesOf(filterRows(list, { query: "harness" })).join(",") === "gentle-ai",
  namesOf(filterRows(list, { query: "harness" })).join(","),
);
check(
  "search terms are ANDed, so a second term only narrows",
  namesOf(filterRows(list, { query: "branch pr" })).join(",") === "branch-pr" &&
    filterRows(list, { query: "branch inexistente" }).length === 0,
  namesOf(filterRows(list, { query: "branch pr" })).join(","),
);
check(
  "the search matches the name and the description, not the package spec",
  filterRows(list, { query: "npm:" }).length === 0 &&
    filterRows(list, { query: "skills/" }).length === 0,
  `${filterRows(list, { query: "npm:" }).length} / ${filterRows(list, { query: "skills/" }).length}`,
);
check(
  "the origin filter keeps one route and lets all of them through",
  filterRows(list, { origin: "package" }).length === 2 &&
    filterRows(list, { origin: "pi" }).length === 1 &&
    filterRows(list, { origin: "project" }).length === 1 &&
    filterRows(list, { origin: "all" }).length === 4,
  String(filterRows(list, { origin: "package" }).length),
);
check(
  "the state filter separates enabled from disabled",
  namesOf(filterRows(list, { state: "on" })).join(",") === "gentle-ai,branch-pr" &&
    namesOf(filterRows(list, { state: "off" })).join(",") === "vitest,deploy" &&
    filterRows(list, { state: "all" }).length === 4,
  namesOf(filterRows(list, { state: "on" })).join(","),
);
check(
  "a query, an origin and a state combine with AND",
  namesOf(filterRows(list, { query: "pull", origin: "package", state: "on" })).join(",") ===
    "branch-pr" && filterRows(list, { query: "deploy", origin: "package", state: "all" }).length === 0,
  namesOf(filterRows(list, { query: "pull", origin: "package", state: "on" })).join(","),
);
check(
  "an absent filter object filters nothing",
  filterRows(list, {}).length === 4 && filterRows(list, undefined).length === 4,
  "",
);

const beforeFilter = orderOf(list);
filterRows(list, { query: "deploy", origin: "project", state: "off" });
check("filtering never mutates the rows it was given", orderOf(list) === beforeFilter, orderOf(list));

// --- sortRows --------------------------------------------------------------

const untouchedBefore = orderOf(list);
const sortedByName = sortRows(list, { key: "name", direction: "asc" });
check(
  "name ascending orders the table alphabetically",
  namesOf(sortedByName).join(",") === "branch-pr,deploy,gentle-ai,vitest",
  namesOf(sortedByName).join(","),
);
check(
  "name descending is name ascending reversed",
  namesOf(sortRows(list, { key: "name", direction: "desc" })).join(",") ===
    namesOf(sortedByName).slice().reverse().join(","),
  namesOf(sortRows(list, { key: "name", direction: "desc" })).join(","),
);

const originsAsc = sortRows(list, { key: "origin", direction: "asc" });
check(
  "origin ascending groups the routes together",
  originsAsc.map((row) => row.origin).join(",") === "package,package,pi,project",
  originsAsc.map((row) => row.origin).join(","),
);
check(
  "origin descending is origin ascending reversed",
  sortRows(list, { key: "origin", direction: "desc" })
    .map((row) => row.origin)
    .join(",") === originsAsc.map((row) => row.origin).slice().reverse().join(","),
  sortRows(list, { key: "origin", direction: "desc" })
    .map((row) => row.origin)
    .join(","),
);

const byStateAsc = sortRows(list, { key: "state", direction: "asc" });
check(
  "state ascending puts the enabled skills first",
  statesOf(byStateAsc) === "true,true,false,false",
  statesOf(byStateAsc),
);
check(
  "state descending puts the disabled skills first",
  statesOf(sortRows(list, { key: "state", direction: "desc" })) === "false,false,true,true",
  statesOf(sortRows(list, { key: "state", direction: "desc" })),
);
check(
  "an unknown sort key leaves the order untouched",
  orderOf(sortRows(list, { key: "packageName", direction: "desc" })) === untouchedBefore,
  orderOf(sortRows(list, { key: "packageName", direction: "desc" })),
);
check(
  "sorting returns a copy and never mutates the rows it was given",
  sortRows(list, { key: "name", direction: "desc" }) !== list && orderOf(list) === untouchedBefore,
  orderOf(list),
);

// --- paginate --------------------------------------------------------------

const many = buildRows(
  Array.from({ length: 45 }, (_, index) => ({
    name: "skill-" + index,
    description: "",
    source: "pi",
    canToggle: false,
    enabled: false,
  })),
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
  paginate(list, { page: 1, pageSize: DEFAULT_PAGE_SIZE }).paged === false && firstPage.paged === true,
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
  "summarize counts the enabled and disabled rows it was given",
  summarize(list).total === 4 && summarize(list).on === 2 && summarize(list).off === 2,
  JSON.stringify(summarize(list)),
);
check(
  "summarize of nothing is zeroes rather than a missing object",
  summarize([]).total === 0 && summarize([]).on === 0 && summarize([]).off === 0,
  JSON.stringify(summarize([])),
);
check(
  "summarize counts the filtered rows, not the whole discovered list",
  JSON.stringify(summarize(filterRows(list, { state: "off" }))) ===
    JSON.stringify({ total: 2, on: 0, off: 2 }),
  JSON.stringify(summarize(filterRows(list, { state: "off" }))),
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
