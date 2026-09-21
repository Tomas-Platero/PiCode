/*
 * A small Markdown renderer for the assistant's replies.
 *
 * Written by hand rather than pulled in as a dependency: the view is a sidebar in
 * a privileged webview, so the surface has to be small enough to audit. It renders
 * the subset an agent's answers actually use, and everything outside that subset
 * stays literal text rather than being guessed at.
 *
 * Two rules shape the whole file:
 *
 * 1. Escape first, format second. Every piece of input is turned into entities
 *    before any markup is produced, so a reply containing `<script>` is text. The
 *    only HTML in the result is what this file writes.
 * 2. Never trust a link. A URL is only rendered as an anchor when its scheme is
 *    http, https or mailto. `javascript:` and `data:` are the reason this is a rule
 *    and not a preference.
 *
 * The renderer is a browser script, not a module, because `media/main.js` is one
 * too. It publishes itself on `globalThis`, which is `window` inside the webview
 * and the same object in Node, so the test can require this exact file instead of
 * a copy of its logic.
 */
(function () {
  "use strict";

  var SCHEMES = ["http://", "https://", "mailto:"];

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Placeholder machinery for inline code.
   *
   * Inline code must survive the bold and link passes untouched, and the only way
   * to guarantee that is to take it out of the text before those passes run. The
   * marker uses a control character that cannot appear in the input, so a reply
   * cannot forge a placeholder and smuggle its own HTML through it.
   */
  var PLACEHOLDER_START = String.fromCharCode(1);
  var PLACEHOLDER_END = String.fromCharCode(2);

  function placeholder(index) {
    return PLACEHOLDER_START + index + PLACEHOLDER_END;
  }

  var PLACEHOLDER_PATTERN = new RegExp(PLACEHOLDER_START + "(\\d+)" + PLACEHOLDER_END, "g");

  /**
   * Applies inline formatting to text that is already escaped.
   *
   * Order matters: code is lifted out first, then bold before italic so `**x**`
   * is not read as an empty italic pair, and links last so a URL containing
   * underscores is not mangled by the emphasis pass.
   */
  function renderInline(escaped) {
    var code = [];
    var text = escaped.replace(/`([^`]+)`/g, function (_match, inner) {
      code.push(inner);
      return placeholder(code.length - 1);
    });

    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    // Emphasis only at a word boundary, so `snake_case_name` keeps its underscores.
    text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      if (!isAllowedUrl(url)) {
        return label;
      }
      // The webview cannot navigate, so the real target travels in data-href and
      // the host opens it. `href` stays inert.
      return (
        '<a class="md-link" href="#" data-href="' +
        url +
        '" title="' +
        url +
        '">' +
        label +
        "</a>"
      );
    });

    return text.replace(PLACEHOLDER_PATTERN, function (_match, index) {
      return '<code class="md-code">' + code[Number(index)] + "</code>";
    });
  }

  /** Escapes raw text and applies inline formatting to it. */
  function inline(raw) {
    return renderInline(escapeHtml(raw));
  }

  /** True when a URL may become an anchor. Everything else renders as text. */
  function isAllowedUrl(url) {
    var lowered = String(url).toLowerCase();
    for (var index = 0; index < SCHEMES.length; index += 1) {
      if (lowered.startsWith(SCHEMES[index])) {
        return true;
      }
    }
    return false;
  }

  function codeBlock(language, lines) {
    var header =
      '<div class="code-block-header">' +
      (language.length > 0
        ? '<span class="code-block-language">' + language + "</span>"
        : "<span></span>") +
      '<button type="button" class="code-block-copy codicon codicon-copy"' +
      ' title="Copiar código" aria-label="Copiar código"></button>' +
      "</div>";

    return (
      '<div class="code-block">' +
      header +
      '<pre class="code-block-body"><code>' +
      lines.join("\n") +
      "</code></pre></div>"
    );
  }

  function isFence(line) {
    return /^\s*```+/.test(line);
  }

  function fenceLength(line) {
    var match = /^\s*(`+)/.exec(line);
    return match ? match[1].length : 0;
  }

  function closesFence(line, length) {
    var match = /^\s*(`+)\s*$/.exec(line);
    return match !== null && match[1].length >= length;
  }

  /**
   * Renders a Markdown document to HTML.
   *
   * Block level is handled by one pass over the lines with a small amount of state,
   * because the alternatives — a full parser or a regular expression per construct —
   * are either far more code than this view justifies or subtly wrong about nesting.
   */
  function renderMarkdown(text) {
    // Block markers are read from the raw lines and the escaping happens as each
    // piece of content is emitted. Escaping first would rewrite the blockquote
    // marker itself, since `>` is exactly the character the quote syntax uses.
    var lines = String(text).split("\n");
    var out = [];
    var paragraph = [];
    var list = null;
    var quote = [];

    function flushParagraph() {
      if (paragraph.length > 0) {
        out.push(
          '<p class="md-p">' +
            renderInline(paragraph.map(escapeHtml).join("<br>")) +
            "</p>",
        );
        paragraph = [];
      }
    }

    function flushList() {
      if (list !== null) {
        out.push("<" + list.tag + ' class="md-list">' + list.items.join("") + "</" + list.tag + ">");
        list = null;
      }
    }

    function flushQuote() {
      if (quote.length > 0) {
        out.push(
          '<blockquote class="md-quote">' +
            renderInline(quote.map(escapeHtml).join("<br>")) +
            "</blockquote>",
        );
        quote = [];
      }
    }

    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];

      if (isFence(line)) {
        flushAll();
        var length = fenceLength(line);
        var language = line.replace(/^\s*`+/, "").trim();
        var body = [];
        index += 1;
        // An unterminated fence runs to the end of the input. Rendering what the
        // model did send is better than swallowing it.
        while (index < lines.length && !closesFence(lines[index], length)) {
          body.push(lines[index]);
          index += 1;
        }
        out.push(codeBlock(language, body.map(escapeHtml)));
        continue;
      }

      if (/^\s*$/.test(line)) {
        flushAll();
        continue;
      }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading !== null) {
        flushAll();
        var level = heading[1].length;
        // A sidebar has no room for six heading sizes. `#` is rare in an agent's
        // reply and `##`/`###` are common, so the first gets its own size and the
        // next two share one rather than all three collapsing together.
        var size = "h3";
        if (level === 1) {
          size = "h1";
        } else if (level <= 3) {
          size = "h2";
        }
        var tag = "h" + (Number(size.charAt(1)) + 2);
        out.push(
          "<" + tag + ' class="md-' + size + '">' + inline(heading[2]) + "</" + tag + ">",
        );
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushAll();
        out.push('<hr class="md-rule">');
        continue;
      }

      var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet !== null || numbered !== null) {
        flushParagraph();
        flushQuote();
        var tag = bullet !== null ? "ul" : "ol";
        if (list === null || list.tag !== tag) {
          flushList();
          list = { tag: tag, items: [] };
        }
        list.items.push("<li>" + inline((bullet || numbered)[1]) + "</li>");
        continue;
      }

      var quoted = /^\s*>\s?(.*)$/.exec(line);
      if (quoted !== null) {
        flushParagraph();
        flushList();
        quote.push(quoted[1]);
        continue;
      }

      flushList();
      flushQuote();
      paragraph.push(line);
    }

    flushAll();
    return out.join("");
  }

  globalThis.PiCodeMarkdown = {
    renderMarkdown: renderMarkdown,
    escapeHtml: escapeHtml,
  };
})();
