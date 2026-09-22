/*
 * The derivation behind the packages table in the settings tab.
 *
 * pi stores a package as one source string and nothing else: `npm:pi-lens`,
 * `git:github.com/HazAT/pi-interactive-subagents`, or a local path written by
 * hand. Every column of the table except Estado is therefore derived from that
 * string, and the only place a derivation can be wrong without looking wrong is
 * in code that has no test: so it lives in its own file, free of the DOM, and
 * `test/package-rows.test.js` asserts it directly.
 *
 * Two facts from the owner's real settings file shaped this file:
 *
 * 1. The same package may appear twice — `gentle-engram` and
 *    `gentle-engram@0.1.14` resolve to the same directory — so a row is
 *    identified by its position in the stored list and never by its source.
 * 2. Only a pinned spec carries a version in the value. Reading the installed
 *    `package.json` is a deliberate, available follow-up, not part of this: the
 *    Versión column is allowed to be "—" almost always.
 *
 * Written as a browser script for the same reason as `markdown.js`: the webview
 * loads it with a `<script>` tag, and the test requires this exact file — the one
 * the panel runs — instead of a copy of its logic.
 */
(function () {
  "use strict";

  var PAGE_SIZES = [20, 50, 100];
  // The size the table opens with, and one of PAGE_SIZES on purpose: the page-size
  // selector is built from that list alone, so a default outside the list would
  // make the control read a number different from the one the table is using. The
  // invariant is asserted in the test suite rather than guarded at runtime.
  var DEFAULT_PAGE_SIZE = 20;

  /**
   * Splits a trailing `@version` off a spec.
   *
   * The separator is the **last** `@` and only when it is not the first
   * character, because a leading `@` is a scope: `@tintinweb/pi-subagents` has
   * no version while `@gtrabanco/pi-nan-provider@2.0.0` has one.
   */
  function splitVersion(spec) {
    var at = spec.lastIndexOf("@");
    if (at <= 0) {
      return { body: spec, version: "" };
    }
    return { body: spec.slice(0, at), version: spec.slice(at + 1) };
  }

  /** The last segment of a slash- or backslash-separated path. */
  function baseName(path) {
    var parts = path.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  /**
   * Turns one stored source string into the columns of one table row.
   *
   * `origin` is the only thing the raw string says outright; `name`, `author` and
   * `version` are read out of the remainder, and anything unparseable stays an
   * empty string rather than a guess.
   */
  function parseSource(source) {
    var raw = typeof source === "string" ? source : "";
    var parsed = { source: raw, origin: "other", name: "", author: "", version: "" };
    var split;

    if (raw.startsWith("npm:")) {
      parsed.origin = "npm";
      split = splitVersion(raw.slice(4));
      parsed.version = split.version;

      var body = split.body;
      if (body.charAt(0) === "@") {
        var slash = body.indexOf("/");
        if (slash !== -1) {
          // The scope gets its own column, so it is stripped from the name: a
          // table where `@tintinweb` appears twice is a column worth deleting.
          parsed.author = body.slice(0, slash);
          body = body.slice(slash + 1);
        }
      }
      parsed.name = body;
      return parsed;
    }

    if (raw.startsWith("git:")) {
      parsed.origin = "git";
      split = splitVersion(raw.slice(4));
      parsed.version = split.version;

      var segments = split.body.split("/").filter(function (segment) {
        return segment !== "";
      });
      parsed.name = segments.length > 0 ? segments[segments.length - 1] : "";
      parsed.author = segments.length > 1 ? segments[segments.length - 2] : "";
      return parsed;
    }

    // Anything that is neither npm nor git is a local path, and the last segment
    // is all the name there is. `origin` stays "other" so the table can mark it.
    parsed.name = baseName(raw);
    return parsed;
  }

  /**
   * One row per stored entry, carrying the index it has in the stored list.
   *
   * The index — not the source — is the identity of a row: the same source may be
   * stored twice, and a write has to name the position it means.
   */
  function buildRows(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var rows = [];

    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      var record = entry !== null && typeof entry === "object" ? entry : {};
      var parsed = parseSource(record.source);

      rows.push({
        index: index,
        entry: entry,
        source: parsed.source,
        origin: parsed.origin,
        name: parsed.name,
        author: parsed.author,
        version: parsed.version,
        paused: Boolean(record.paused),
      });
    }

    return rows;
  }

  /**
   * Terms the search box matches against, joined so one term cannot span two
   * fields.
   *
   * Only the columns the table shows: the raw source is not on screen, so
   * searching for `github.com` finding a row whose Origen cell is just a git
   * mark would read as a bug.
   */
  function haystack(row) {
    return [row.name, row.author, row.version].join("\n").toLowerCase();
  }

  /**
   * The rows the table is allowed to show.
   *
   * Terms are ANDed the way the settings search treats them: `npm pi` narrows
   * instead of widening. `origin` and `status` accept "all" for "no filter".
   */
  function filterRows(rows, options) {
    var list = Array.isArray(rows) ? rows : [];
    var settings = options || {};
    var query = typeof settings.query === "string" ? settings.query : "";
    var origin = typeof settings.origin === "string" ? settings.origin : "all";
    var status = typeof settings.status === "string" ? settings.status : "all";
    var terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(function (term) {
        return term !== "";
      });

    return list.filter(function (row) {
      if (origin !== "all" && row.origin !== origin) {
        return false;
      }
      if (status === "active" && row.paused) {
        return false;
      }
      if (status === "paused" && !row.paused) {
        return false;
      }
      if (terms.length === 0) {
        return true;
      }
      var text = haystack(row);
      return terms.every(function (term) {
        return text.indexOf(term) !== -1;
      });
    });
  }

  /** Numeric so `0.1.14` does not sort before `0.1.9`. */
  function compareText(left, right) {
    return left.localeCompare(right, undefined, { numeric: true });
  }

  function compareRows(left, right, key) {
    if (key === "version") {
      // An empty version is not information: it goes last in ascending order
      // instead of sorting as an empty string before every real version.
      if (left.version === "" && right.version !== "") {
        return 1;
      }
      if (right.version === "" && left.version !== "") {
        return -1;
      }
      return compareText(left.version, right.version);
    }
    if (key === "status") {
      // Ascending means active first, which is the order the switch reads in.
      return left.paused === right.paused ? 0 : left.paused ? 1 : -1;
    }
    return compareText(left.name, right.name);
  }

  /**
   * Sorts a copy: the caller's array is the filter result the same render is
   * still reading, so it must come back unchanged.
   *
   * An unknown key is not a sort — the rows come back in the order they arrived.
   */
  function sortRows(rows, options) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    var settings = options || {};
    var key = typeof settings.key === "string" ? settings.key : "";

    if (key !== "name" && key !== "status" && key !== "version") {
      return list;
    }

    var direction = settings.direction === "desc" ? -1 : 1;
    list.sort(function (left, right) {
      return compareRows(left, right, key) * direction;
    });
    return list;
  }

  /**
   * The slice of rows one page shows, plus the numbers the footer prints.
   *
   * `page` is clamped into the range the current row count has, because removing
   * the last package of the last page would otherwise leave the table showing an
   * empty page with no way back.
   */
  function paginate(rows, options) {
    var list = Array.isArray(rows) ? rows : [];
    var settings = options || {};
    var total = list.length;

    var size =
      typeof settings.pageSize === "number" &&
      Number.isFinite(settings.pageSize) &&
      settings.pageSize > 0
        ? Math.floor(settings.pageSize)
        : DEFAULT_PAGE_SIZE;
    var pageCount = Math.max(1, Math.ceil(total / size));

    var requested =
      typeof settings.page === "number" && Number.isFinite(settings.page)
        ? Math.floor(settings.page)
        : 1;
    var page = Math.min(Math.max(requested, 1), pageCount);

    var startIndex = (page - 1) * size;
    var items = list.slice(startIndex, startIndex + size);

    return {
      page: page,
      pageCount: pageCount,
      // Row numbers, so the footer can say what it is showing without inventing
      // one more count in the renderer.
      start: total === 0 ? 0 : startIndex + 1,
      end: total === 0 ? 0 : startIndex + items.length,
      total: total,
      items: items,
      paged: total > size,
    };
  }

  /** Counts of the rows the filters left, i.e. of what the table is showing. */
  function summarize(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var paused = 0;

    for (var index = 0; index < list.length; index += 1) {
      if (list[index].paused) {
        paused += 1;
      }
    }

    return { total: list.length, paused: paused, active: list.length - paused };
  }

  globalThis.PiCodePackageRows = {
    PAGE_SIZES: PAGE_SIZES,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    parseSource: parseSource,
    buildRows: buildRows,
    filterRows: filterRows,
    sortRows: sortRows,
    paginate: paginate,
    summarize: summarize,
  };
})();
