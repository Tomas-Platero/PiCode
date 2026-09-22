/*
 * Exercises the skills host half: the frontmatter parser, pi's package manifest,
 * the package filter arithmetic, and the discovery of the three automatic routes.
 *
 * The value of this suite is that it is hermetic: every fixture is built in a
 * temporary directory, so the checks never read the developer's own agent
 * directory and never depend on which skills happen to be installed. What is
 * asserted is the contract the settings table consumes next: the registered name,
 * the description, the route, whether the skill can be switched at all, and
 * whether pi is loading it now.
 *
 * skills.ts imports pi-cli.ts, which imports runtime.ts, which imports `vscode`;
 * the stub keeps the whole listing testable outside an editor.
 *
 * Run with: npm test
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

const {
  parseSkillFrontmatter,
  parsePiManifest,
  packageLoadsSkill,
  skillFilterPattern,
  discoverSkills,
} = require(path.join(__dirname, "..", "out", "skills.js"));

const {
  PI_SETTING_DESCRIPTORS,
  coerceSettingValue,
  packageSkillFilter,
  withPackageSkill,
  toPackageSource,
} = require(path.join(__dirname, "..", "out", "pi-settings.js"));

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/* ------------------------------------------------------------------ *
 * Pure parsing
 * ------------------------------------------------------------------ */

const plain = parseSkillFrontmatter(
  "---\nname: alpha-skill\ndescription: Una skill de pi.\n---\n\nCuerpo.\n",
  "fallback",
);
check(
  "plain name and description are read",
  plain.name === "alpha-skill" && plain.description === "Una skill de pi.",
  JSON.stringify(plain),
);

const quoted = parseSkillFrontmatter(
  '---\nname: "echo-skill"\ndescription: \'Una descripción entre comillas.\'\n---\n',
  "fallback",
);
check(
  "a quoted value loses its quotes",
  quoted.name === "echo-skill" && quoted.description === "Una descripción entre comillas.",
  JSON.stringify(quoted),
);

const incomplete = parseSkillFrontmatter("---\ndescription: Sin nombre.\n---\n", "delta");
check(
  "a missing name falls back to the directory name",
  incomplete.name === "delta" && incomplete.description === "Sin nombre.",
  JSON.stringify(incomplete),
);

const noFrontmatter = parseSkillFrontmatter("Solo cuerpo, sin frontmatter.\n", "delta");
check(
  "a file with no frontmatter keeps the fallback and an empty description",
  noFrontmatter.name === "delta" && noFrontmatter.description === "",
  JSON.stringify(noFrontmatter),
);

const emptyName = parseSkillFrontmatter('---\nname: ""\ndescription: Vacío.\n---\n', "gamma");
check("an empty name also falls back", emptyName.name === "gamma", JSON.stringify(emptyName));

const manifest = parsePiManifest(
  JSON.stringify({ name: "demo-pkg", pi: { skills: ["./skills", 7, ""] } }),
);
check(
  "a package manifest keeps its name and its string skill paths",
  manifest !== undefined && manifest.name === "demo-pkg" && same(manifest.skills, ["./skills"]),
  JSON.stringify(manifest),
);
check("a package with no pi block contributes no skills", parsePiManifest('{"name":"x"}') === undefined, "");
check("a broken manifest contributes no skills", parsePiManifest("{not json") === undefined, "");

check(
  "the filter pattern is a POSIX path relative to the package root",
  skillFilterPattern(path.join("C:", "pkg"), path.join("C:", "pkg", "skills", "gamma", "SKILL.md")) ===
    "skills/gamma/SKILL.md",
  skillFilterPattern(path.join("C:", "pkg"), path.join("C:", "pkg", "skills", "gamma", "SKILL.md")),
);

/* ------------------------------------------------------------------ *
 * The package filter arithmetic
 * ------------------------------------------------------------------ */

const PATTERN = "skills/gamma/SKILL.md";
const OTHER = "skills/other/SKILL.md";
const active = { source: "npm:demo-pkg", paused: false };
const paused = { source: "npm:demo-pkg", paused: true };

check("an entry with no filter filters nothing", packageSkillFilter(active) === undefined, "");
check(
  "an unfiltered, unpaused package loads its skill",
  packageLoadsSkill(active, PATTERN) === true,
  "",
);
check("a paused package starts from nothing", packageLoadsSkill(paused, PATTERN) === false, "");
check(
  "an allow-list is what loads",
  packageLoadsSkill({ ...active, skills: [PATTERN] }, PATTERN) === true &&
    packageLoadsSkill({ ...active, skills: [OTHER] }, PATTERN) === false,
  "",
);
check(
  "an empty allow-list means all off, not no filter",
  packageSkillFilter({ ...active, skills: [] }) !== undefined &&
    packageLoadsSkill({ ...active, skills: [] }, PATTERN) === false,
  JSON.stringify(packageSkillFilter({ ...active, skills: [] })),
);
check(
  "a force-exclude marker turns the skill off",
  packageLoadsSkill({ ...active, skills: [`-${PATTERN}`] }, PATTERN) === false,
  "",
);
check(
  "a force-include marker turns a paused package's skill on",
  packageLoadsSkill({ ...paused, skills: [`+${PATTERN}`] }, PATTERN) === true,
  "",
);

/*
 * The four cases the write helper must produce, pinned one by one, plus the delta
 * case. With the default autoload pi reads the list as an allow-list (`applyPackageFilter`),
 * where an empty list means "all off" and a missing key means "load everything".
 * With `autoload: false` it reads the list as a delta (`applyPackageDeltaFilter`),
 * where only the named patterns load. The helper is told the package's complete set
 * of skill patterns so it can express "this one is off" from either starting point.
 */

// Case 1: no filter, one switched off, other skills exist -> allow-list of the rest.
const offWithOthers = withPackageSkill(active, PATTERN, false, [PATTERN, OTHER]);
check(
  "case 1: switching one off with others left writes the allow-list of the rest",
  same(packageSkillFilter(offWithOthers), [OTHER]),
  JSON.stringify(offWithOthers),
);
check(
  "case 1 stored: the allow-list names the other skill",
  same(toPackageSource(offWithOthers), { source: "npm:demo-pkg", skills: [OTHER] }),
  JSON.stringify(toPackageSource(offWithOthers)),
);

// Case 2: no filter, the package's only skill switched off -> empty allow-list.
const offOnly = withPackageSkill(active, PATTERN, false, [PATTERN]);
check(
  "case 2: switching off the package's only skill keeps an empty allow-list",
  same(packageSkillFilter(offOnly), []),
  JSON.stringify(offOnly),
);
check(
  "case 2 stored: the empty list is written, not dropped",
  same(toPackageSource(offOnly), { source: "npm:demo-pkg", skills: [] }),
  JSON.stringify(toPackageSource(offOnly)),
);

// Case 3: filtered, one switched off -> remove it; keep the empty list when last.
const filteredOff = withPackageSkill(
  { ...active, skills: [PATTERN, OTHER] },
  PATTERN,
  false,
  [PATTERN, OTHER],
);
check(
  "case 3: switching one off a filtered package keeps the remaining entry",
  same(toPackageSource(filteredOff), { source: "npm:demo-pkg", skills: [OTHER] }),
  JSON.stringify(toPackageSource(filteredOff)),
);
const lastOff = withPackageSkill({ ...active, skills: [PATTERN] }, PATTERN, false, [PATTERN]);
check(
  "switching the last skill off keeps an empty allow-list: dropping the key would turn every skill back on",
  same(toPackageSource(lastOff), { source: "npm:demo-pkg", skills: [] }),
  JSON.stringify(toPackageSource(lastOff)),
);

// Case 4: switching one on -> add it, and drop the key only once it names them all.
const alreadyAll = withPackageSkill(active, PATTERN, true, [PATTERN, OTHER]);
check(
  "case 4: switching one on where there is no filter changes nothing",
  toPackageSource(alreadyAll) === "npm:demo-pkg",
  JSON.stringify(toPackageSource(alreadyAll)),
);
const coversAll = withPackageSkill({ ...active, skills: [OTHER] }, PATTERN, true, [PATTERN, OTHER]);
check(
  "case 4: once the allow-list names every skill the key is dropped for a plain source",
  toPackageSource(coversAll) === "npm:demo-pkg",
  JSON.stringify(toPackageSource(coversAll)),
);
const stillPartial = withPackageSkill({ ...active, skills: [OTHER] }, PATTERN, true, [
  PATTERN,
  OTHER,
  "skills/third/SKILL.md",
]);
check(
  "case 4: a list that still misses a skill keeps the key",
  same(toPackageSource(stillPartial), { source: "npm:demo-pkg", skills: [OTHER, PATTERN] }),
  JSON.stringify(toPackageSource(stillPartial)),
);

// The delta case: a paused package's list turns skills on, and the pause survives.
const pausedOn = withPackageSkill(paused, PATTERN, true, [PATTERN]);
check(
  "delta: switching one on for a paused package names it in the delta and keeps the pause",
  pausedOn.paused === true && same(packageSkillFilter(pausedOn), [PATTERN]),
  JSON.stringify(pausedOn),
);
check(
  "delta stored: autoload=false plus the delta",
  same(toPackageSource(pausedOn), {
    source: "npm:demo-pkg",
    autoload: false,
    skills: [PATTERN],
  }),
  JSON.stringify(toPackageSource(pausedOn)),
);
check(
  "delta: a paused package loads exactly what its delta names",
  packageLoadsSkill(pausedOn, PATTERN) === true && packageLoadsSkill(pausedOn, OTHER) === false,
  JSON.stringify(pausedOn),
);
const pausedOff = withPackageSkill(pausedOn, PATTERN, false, [PATTERN]);
check(
  "delta: switching it off again keeps the pause and an empty delta",
  same(toPackageSource(pausedOff), {
    source: "npm:demo-pkg",
    autoload: false,
    skills: [],
  }) && packageLoadsSkill(pausedOff, PATTERN) === false,
  JSON.stringify(toPackageSource(pausedOff)),
);

const otherFilters = { ...active, extensions: ["ext/a.ts"], themes: ["themes/dark.json"] };
const otherSwitched = withPackageSkill(otherFilters, PATTERN, true, [PATTERN]);
check(
  "the other three filters survive the switch",
  same(otherSwitched.extensions, ["ext/a.ts"]) && same(otherSwitched.themes, ["themes/dark.json"]),
  JSON.stringify(otherSwitched),
);
check(
  "a plain string stays a plain string",
  toPackageSource({ source: "npm:demo-pkg", paused: false }) === "npm:demo-pkg",
  JSON.stringify(toPackageSource({ source: "npm:demo-pkg", paused: false })),
);

const packagesSetting = PI_SETTING_DESCRIPTORS.find((entry) => entry.key === "packages");
const coerced = coerceSettingValue(packagesSetting, [
  { source: "npm:demo-pkg", paused: true, skills: [PATTERN], extensions: ["ext/a.ts"] },
]);
check(
  "coercion accepts and keeps the four filters",
  same(coerced, [
    { source: "npm:demo-pkg", paused: true, extensions: ["ext/a.ts"], skills: [PATTERN] },
  ]),
  JSON.stringify(coerced),
);
check(
  "coercion refuses a filter that is not a list",
  coerceSettingValue(packagesSetting, [{ source: "npm:demo-pkg", paused: false, skills: PATTERN }]) ===
    undefined,
  "",
);
check(
  "coercion keeps an empty list, because pi reads it as all off",
  same(coerceSettingValue(packagesSetting, [
    { source: "npm:demo-pkg", paused: false, skills: [] },
  ]), [{ source: "npm:demo-pkg", paused: false, skills: [] }]),
  JSON.stringify(
    coerceSettingValue(packagesSetting, [{ source: "npm:demo-pkg", paused: false, skills: [] }]),
  ),
);

/* ------------------------------------------------------------------ *
 * Discovery over a temporary tree
 * ------------------------------------------------------------------ */

function writeSkill(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), text);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picode-skills-"));
  try {
    const agentDir = path.join(root, "agent");
    const projectDir = path.join(root, "project");
    const packageRoot = path.join(root, "pkgs", "demo-pkg");
    const bareRoot = path.join(root, "pkgs", "bare-pkg");

    // Route 1: pi's own default directory.
    writeSkill(
      path.join(agentDir, "skills", "alpha"),
      "---\nname: alpha-skill\ndescription: Una skill de pi.\n---\n\nCuerpo.\n",
    );
    // Route 1: an incomplete frontmatter, which must fall back to the directory name.
    writeSkill(path.join(agentDir, "skills", "delta"), "Solo cuerpo, sin frontmatter.\n");
    // Route 3: the project's own directory.
    writeSkill(
      path.join(projectDir, ".pi", "skills", "beta"),
      "---\nname: beta-skill\ndescription: Una skill del proyecto.\n---\n",
    );
    // Route 1: a directory whose SKILL.md is missing must be skipped, not fatal.
    fs.mkdirSync(path.join(agentDir, "skills", "broken"), { recursive: true });
    // Route 2: a package that declares a skills directory.
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "demo-pkg", pi: { skills: ["./skills"] } }),
    );
    writeSkill(
      path.join(packageRoot, "skills", "gamma"),
      "---\nname: gamma-skill\ndescription: Una skill de un paquete.\n---\n",
    );
    // Route 2: a package with no manifest contributes none.
    fs.mkdirSync(bareRoot, { recursive: true });

    const listPackages = async () => [
      { scope: "User packages", source: "npm:demo-pkg", path: packageRoot },
      { scope: "User packages", source: "npm:bare-pkg", path: bareRoot },
      { scope: "User packages", source: "npm:no-path" },
    ];

    const found = await discoverSkills({
      agentDir,
      cwd: projectDir,
      listPackages,
      packageEntries: [{ source: "npm:demo-pkg", paused: false, skills: [PATTERN] }],
    });
    const byName = new Map(found.skills.map((entry) => [entry.name, entry]));

    check(
      "every readable skill on every route is listed",
      same(
        [...byName.keys()].sort(),
        ["alpha-skill", "beta-skill", "delta", "gamma-skill"],
      ),
      JSON.stringify([...byName.keys()]),
    );
    check(
      "pi's own directory yields a pi skill that cannot be switched",
      byName.get("alpha-skill").source === "pi" &&
        byName.get("alpha-skill").canToggle === false &&
        byName.get("alpha-skill").enabled === true,
      JSON.stringify(byName.get("alpha-skill")),
    );
    check(
      "the project's directory yields a project skill that cannot be switched",
      byName.get("beta-skill").source === "project" &&
        byName.get("beta-skill").canToggle === false,
      JSON.stringify(byName.get("beta-skill")),
    );
    check(
      "the fallback directory names a skill whose frontmatter has no name",
      byName.get("delta").source === "pi" && byName.get("delta").description === "",
      JSON.stringify(byName.get("delta")),
    );
    check(
      "a package skill carries its package and can be switched",
      byName.get("gamma-skill").source === "package" &&
        byName.get("gamma-skill").packageSource === "npm:demo-pkg" &&
        byName.get("gamma-skill").packageName === "demo-pkg" &&
        byName.get("gamma-skill").canToggle === true &&
        byName.get("gamma-skill").pattern === PATTERN &&
        byName.get("gamma-skill").enabled === true,
      JSON.stringify(byName.get("gamma-skill")),
    );
    check(
      "a directory with no SKILL.md is reported and skipped",
      !byName.has("broken") &&
        found.problems.some((problem) => problem.path.includes("broken")) &&
        found.problems.some((problem) => problem.message.includes("SKILL.md")),
      JSON.stringify(found.problems),
    );
    check(
      "a package with no path is reported rather than dropped silently",
      found.problems.some(
        (problem) => problem.path === "npm:no-path" && problem.message.includes("ruta"),
      ),
      JSON.stringify(found.problems),
    );
    check(
      "a package with no manifest contributes no skills and no problem",
      !found.skills.some((entry) => entry.packageSource === "npm:bare-pkg"),
      JSON.stringify(found.skills),
    );

    const filteredOut = await discoverSkills({
      agentDir,
      cwd: projectDir,
      listPackages,
      packageEntries: [{ source: "npm:demo-pkg", paused: false, skills: ["skills/other/SKILL.md"] }],
    });
    check(
      "a filtered-out package skill is reported off",
      filteredOut.skills.find((entry) => entry.name === "gamma-skill").enabled === false,
      JSON.stringify(filteredOut.skills.find((entry) => entry.name === "gamma-skill")),
    );

    const pausedPackage = await discoverSkills({
      agentDir,
      cwd: projectDir,
      listPackages,
      packageEntries: [{ source: "npm:demo-pkg", paused: true }],
    });
    check(
      "a paused package's skills are reported off",
      pausedPackage.skills.find((entry) => entry.name === "gamma-skill").enabled === false,
      JSON.stringify(pausedPackage.skills.find((entry) => entry.name === "gamma-skill")),
    );

    const listingFailed = await discoverSkills({
      agentDir,
      cwd: projectDir,
      listPackages: async () => {
        throw new Error("pi no está disponible");
      },
    });
    check(
      "a failed package listing is a problem, not a thrown error",
      listingFailed.problems.some((problem) => problem.message.includes("pi no está disponible")) &&
        listingFailed.skills.some((entry) => entry.source === "pi"),
      JSON.stringify(listingFailed.problems),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
