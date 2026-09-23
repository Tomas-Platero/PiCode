/*
 * The derivation behind the skills table in the settings tab.
 *
 * A skill arrives from `src/skills.ts` already resolved: which of pi's three
 * automatic routes found it, the name pi registered it under, and whether pi is
 * loading it right now. What the table still has to derive is the part a human
 * reads — one short Spanish label per route, the text the search box matches,
 * the order each column sorts in — and a wrong label renders as a perfectly
 * plausible label. So the derivation lives in its own file, free of the DOM, and
 * `test/skill-rows.test.js` asserts it directly.
 *
 * One fact from the discovery shape shaped this file: `packageName` is optional.
 * It comes from the installed package's manifest, and pi's listing is what fills
 * it, so a package whose name was not reported still has to be labelled with
 * something a human can match to the packages table — its source spec. The
 * project route has no such fallback because there is exactly one project.
 *
 * Written as a browser script for the same reason as `package-rows.js`: the
 * webview loads it with a `<script>` tag, and the test requires this exact file
 * — the one the panel runs — instead of a copy of its logic.
 */
(function () {
  "use strict";

  var PAGE_SIZES = [20, 50, 100];
  // The size the table opens with, and one of PAGE_SIZES on purpose: the page-size
  // selector is built from that list alone, so a default outside the list would
  // make the control read a number different from the one the table is using. The
  // invariant is asserted in the test suite rather than guarded at runtime.
  var DEFAULT_PAGE_SIZE = 20;

  /** A string field, or an empty one: never `undefined` in a row the renderer reads. */
  function text(value) {
    return typeof value === "string" ? value : "";
  }

  /**
   * The short Spanish label of the route a skill was found on.
   *
   * The package route prefers the manifest name — it is what the packages table
   * and pi's own listing show — and falls back to the source spec when pi did not
   * report one. An unknown route labels nothing rather than guessing.
   */
  function labelOf(record) {
    if (record.source === "pi") {
      return "pi";
    }
    if (record.source === "package") {
      var packageName = text(record.packageName);
      return packageName !== "" ? packageName : text(record.packageSource);
    }
    if (record.source === "project") {
      return "proyecto";
    }
    return "";
  }

  /**
   * One row per discovered skill, carrying the index it has in the discovery list.
   *
   * The index — not the name — is the identity of a row: two packages may each
   * ship a skill with the same name, and a toggle has to name the row it means.
   */
  function buildRows(skills) {
    var list = Array.isArray(skills) ? skills : [];
    var rows = [];

    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      var record = entry !== null && typeof entry === "object" ? entry : {};

      rows.push({
        index: index,
        skill: entry,
        name: text(record.name),
        description: text(record.description),
        origin: text(record.source),
        originLabel: labelOf(record),
        canToggle: Boolean(record.canToggle),
        enabled: Boolean(record.enabled),
        pattern: text(record.pattern),
        packageName: text(record.packageName),
      });
    }

    return rows;
  }

  /**
   * Terms the search box matches against, joined so one term cannot span two
   * fields.
   *
   * Only what the table shows: the package spec and the filter pattern are not on
   * screen, so searching for `npm:` or `skills/` finding a row would read as a bug.
   */
  function haystack(row) {
    return [row.name, row.description].join("\n").toLowerCase();
  }

  /**
   * The rows the table is allowed to show.
   *
   * Terms are combined with AND the way the settings search treats them: a second
   * word narrows instead of widening. `origin` and `state` accept "all" for "no
   * filter".
   */
  function filterRows(rows, options) {
    var list = Array.isArray(rows) ? rows : [];
    var settings = options || {};
    var query = text(settings.query);
    var origin = typeof settings.origin === "string" ? settings.origin : "all";
    var state = typeof settings.state === "string" ? settings.state : "all";
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
      if (state === "on" && !row.enabled) {
        return false;
      }
      if (state === "off" && row.enabled) {
        return false;
      }
      if (terms.length === 0) {
        return true;
      }
      var hay = haystack(row);
      return terms.every(function (term) {
        return hay.indexOf(term) !== -1;
      });
    });
  }

  function compareText(left, right) {
    return left.localeCompare(right, undefined, { numeric: true });
  }

  function compareRows(left, right, key) {
    if (key === "state") {
      // Ascending means enabled first, which is the order the switch reads in.
      return left.enabled === right.enabled ? 0 : left.enabled ? -1 : 1;
    }
    if (key === "origin") {
      return compareText(left.origin, right.origin);
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

    if (key !== "name" && key !== "origin" && key !== "state") {
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
   * `page` is clamped into the range the current row count has, because uninstalling
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
    var on = 0;

    for (var index = 0; index < list.length; index += 1) {
      if (list[index].enabled) {
        on += 1;
      }
    }

    return { total: list.length, on: on, off: list.length - on };
  }

  globalThis.PiCodeSkillRows = {
    PAGE_SIZES: PAGE_SIZES,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    buildRows: buildRows,
    filterRows: filterRows,
    sortRows: sortRows,
    paginate: paginate,
    summarize: summarize,
  };
})();
