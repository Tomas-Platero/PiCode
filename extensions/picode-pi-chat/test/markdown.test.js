/*
 * Exercises the Markdown renderer the transcript renders assistant replies with.
 *
 * Two of these checks are security checks, not formatting checks, and they are the
 * reason this suite exists at all: the replies come from a model, the renderer
 * writes HTML into a webview that can reach the editor, and a reply containing
 * `<script>` or a `javascript:` link must come out inert. A regression here would
 * be invisible in review because the output still looks like a rendered reply.
 *
 * The renderer is a browser script rather than a module, so it is loaded here the
 * same way the webview loads it: by running the file, which publishes itself on
 * `globalThis`.
 *
 * Run with: npm test
 */
const path = require("node:path");

require(path.join(__dirname, "..", "media", "markdown.js"));

const { renderMarkdown, escapeHtml } = globalThis.PiCodeMarkdown;

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: Boolean(ok), detail });

// --- escaping --------------------------------------------------------------

check(
  "the five characters that can break out of text become entities",
  escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;",
  escapeHtml(`&<>"'`),
);

const hostile = renderMarkdown("<script>alert(1)</script>");
check(
  "html in a reply is escaped rather than rendered",
  !hostile.includes("<script") && hostile.includes("&lt;script&gt;"),
  hostile,
);

check(
  "an attribute cannot be broken out of from inside a code fence",
  !renderMarkdown('```\n" onmouseover="alert(1)\n```').includes('onmouseover="alert(1)"'),
  "escaped",
);

// --- code ------------------------------------------------------------------

const fenced = renderMarkdown("```ts\nconst a = 1;\n```");
check(
  "a fenced block carries its language, a copy button and the code",
  fenced.includes('class="code-block-language">ts<') &&
    fenced.includes("code-block-copy") &&
    fenced.includes("const a = 1;"),
  fenced,
);
check(
  "a fence without a language still renders its header",
  renderMarkdown("```\nplain\n```").includes("code-block-header") &&
    !renderMarkdown("```\nplain\n```").includes("code-block-language"),
  "",
);

const unterminated = renderMarkdown("```\nstill code");
check(
  "an unterminated fence renders what the model did send",
  unterminated.includes("still code") && unterminated.includes("code-block-body"),
  unterminated,
);

const inlineCode = renderMarkdown("usa `**no**` aqui");
check(
  "inline code renders as code and its markdown is not interpreted",
  inlineCode.includes('<code class="md-code">**no**</code>') &&
    !inlineCode.includes("<strong>"),
  inlineCode,
);

// --- emphasis --------------------------------------------------------------

check("bold becomes strong", renderMarkdown("**hola**").includes("<strong>hola</strong>"), "");
check("italic becomes emphasis", renderMarkdown("*hola*").includes("<em>hola</em>"), "");
check(
  "an underscore inside a word is left alone",
  renderMarkdown("snake_case_name").includes("snake_case_name") &&
    !renderMarkdown("snake_case_name").includes("<em>"),
  renderMarkdown("snake_case_name"),
);

// --- links -----------------------------------------------------------------

const link = renderMarkdown("mira [la doc](https://example.com/a_b)");
check(
  "an http link becomes an anchor whose target travels in data-href",
  link.includes('data-href="https://example.com/a_b"') &&
    link.includes('href="#"') &&
    link.includes(">la doc</a>"),
  link,
);

for (const hostile of [
  "[click](javascript:alert(1))",
  "[click](data:text/html;base64,PHNjcmlwdD4=)",
  "[click](file:///etc/passwd)",
]) {
  const rendered = renderMarkdown(hostile);
  check(
    `a disallowed target (${hostile.slice(9, 24)}...) renders as text, never as an anchor`,
    !rendered.includes("<a ") && rendered.includes("click"),
    rendered,
  );
}

check(
  "a relative path is not made clickable",
  !renderMarkdown("[x](./docs/a.md)").includes("<a "),
  renderMarkdown("[x](./docs/a.md)"),
);

// --- block level -----------------------------------------------------------

check(
  "a bullet list becomes a list of items",
  (() => {
    const rendered = renderMarkdown("- uno\n- dos");
    return rendered.includes('<ul class="md-list">') && (rendered.match(/<li>/g) || []).length === 2;
  })(),
  renderMarkdown("- uno\n- dos"),
);

check(
  "a numbered list becomes an ordered list",
  renderMarkdown("1. uno\n2. dos").includes('<ol class="md-list">'),
  renderMarkdown("1. uno\n2. dos"),
);

check(
  "a heading renders at the size the sidebar can afford",
  renderMarkdown("## Título").includes('<h4 class="md-h2">Título</h4>') &&
    renderMarkdown("# Uno").includes('<h3 class="md-h1">'),
  renderMarkdown("## Título"),
);

check(
  "a quote renders as a quote",
  renderMarkdown("> citado").includes('<blockquote class="md-quote">citado</blockquote>'),
  renderMarkdown("> citado"),
);

check(
  "a rule renders as a rule",
  renderMarkdown("---").includes('<hr class="md-rule">'),
  renderMarkdown("---"),
);

const paragraph = renderMarkdown("linea uno\nlinea dos");
check(
  "a paragraph keeps its single newlines, because agent output uses them",
  paragraph.includes("linea uno<br>linea dos"),
  paragraph,
);

check("empty input renders nothing rather than a stray element", renderMarkdown("") === "", renderMarkdown(""));

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
