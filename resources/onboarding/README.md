# The setup window

The window PiCode shows **before the editor exists**: which pi runs, which model answers, how it
looks, and what else to switch on. The same page serves three situations —
[`onboarding.js`](onboarding.js) reads `mode` and starts from the state that is already configured
instead of asking again:

| `mode` | When |
| --- | --- |
| `first-run` | no `onboarding.json` recorded for this installation |
| `update` | the recorded `onboardingVersion` or the product's major version changed |
| `setup` | `PiCode: Setup` from the Command Palette, with the editor already open |

## What is in here

| File | Its one job |
| --- | --- |
| [`index.html`](index.html) | the skeleton: rail, six steps, footer. No content — the steps are painted from data. |
| [`onboarding.js`](onboarding.js) | everything the page decides: which step, what it shows, and the calls it makes. Two languages (English, Spanish) in one table. |
| [`onboarding.css`](onboarding.css) | the look, and the palette: **fixed**, the product's. Three surfaces (canvas `#0B0F19`, rail `#111625`, card `#182030` with a `#2A364F` border), three text weights (`#F3F4F6` · `#9CA3AF` · `#6B7280`), one blue for the action (`#2563EB`, hover `#1D4ED8`) and one green for "this worked" (`#10B981`). |
| [`preload.cjs`](preload.cjs) | the only bridge to the main process: five named operations, no generic `invoke`. |
| [`host.cjs`](host.cjs) | the backend shim. It loads the connector's own `onboarding-host` and answers one command per process. |
| `media/picode.svg` | the robot mark, **copied verbatim** from `extensions/picode/media/picode.svg`. If the mark changes, this file changes with it. |

## Signing in to a subscription, before the editor exists

This was the one thing that looked impossible here: pi's subscription logins run in the editor's
account flow. They do not have to. The conversation with pi lives in
`extensions/picode/src/subscriptions.ts`, which has **no runtime `vscode` import** — the editor
supplies two things it lacks (a prompt and a notifier), and the setup window supplies its own.
So the same `runtime.login(providerId, 'oauth', …)` runs in the child process, over PiCode's own
profile, and the credential lands exactly where the editor will look for it.

What the window shows comes from pi, never from a guess: provider list (`getProviders()` filtered
to those with `oauth.login`), its questions (select / text / secret / manual code), and its
notices (`auth_url`, `device_code`, `progress`, `info`). The URL is opened in the system browser
through the same allowlisted `openExternal` the key links use.

Two things learned the hard way, both fixed:

- **The protocol cannot share stdout with pi.** Loading pi runs npm the first time (its declared
  packages get installed) and npm prints whatever it likes. Answers travel as lines prefixed with
  `##picode##`, and everything else on that pipe is logged and ignored. (fd 3 was the first
  attempt; it does not survive this spawn on Windows.)
- **Attempts need a number.** A cancelled sign-in's child is still exiting when the next one
  starts, and its `exit` would land on a window now watching a different attempt. Every event
  carries the run it belongs to; the page ignores the others.

Verified on a real window, not in theory: nine providers listed from pi (Anthropic, GitHub
Copilot, OpenAI, xAI, …), pi's own question rendered a second after the click, answering it
produced **Claude's real authorize URL**, and Cancel settled the panel to "the sign-in was
cancelled". The last step — approving the account — is the owner's, by definition.

## The model step is three tabs, not three stacked cards

Three cards that each opened a block underneath turned into a tower: two panels open at once, the
page taller than the window, and the last one sliding under the footer. Now:

- **A tab bar** — subscriptions, API key, local models (with its count). Exactly one panel is
  shown, and the panel is chosen by the tab rather than by which cards were clicked.
- **The layout has three bands**: a scrolling middle, a footer that is not part of the scroll, and
  nothing else. Measured on a real window: scroll 612.5 + footer 68.5 = 681 = the window height,
  and `elementFromPoint` in the footer's pixels answers *footer*, not the panel.
- **The API-key form asks for one thing.** A preset fills the address and the dialect; the key is
  the only field. `Advanced options` reveals name, address and dialect for a local server or an
  endpoint nobody has heard of.
- **Subscriptions are a two-column grid**, ordered like the editor orders them
  (`rankOf`/`FEATURED_SUBSCRIPTIONS` in `subscriptions.ts`): ChatGPT, Claude, Copilot, xAI, Kimi,
  OpenRouter first, then the rest by name, each with the note the product already had.

The first time in a fresh install, opening that tab costs ten-thirteen seconds: loading pi for the
first time also installs its declared packages. The panel says so instead of showing a spinner —
`subLoading` names the reason.

The list is **whatever pi reports**. This pi offers nine OAuth providers and neither Google Gemini
nor Mistral is among them, so they are not listed: a row that fails on click is worse than a row
that is not there. Both can still be used through the API-key tab.

## The extras step: one control, not two

It had a switch **and** three cards. With the switch off the cards were disabled, and nothing on
screen said which of the two was in charge — the copy was also describing plumbing ("what travels
with each message", "folder + file") rather than a choice a person makes.

Now the section is *AI Code Context & Privacy*, its subtitle says what it decides, and the three
cards **are** the control: `Full Workspace` (badge *Recommended*), `Active File Only`,
`Selection Only`, each with the privacy it buys and what it costs. Radio semantics
(`role="radiogroup"`, `aria-checked`), cobalt border and a lifted blue surface on the chosen one
(`#2563EB`, measured).

The product still keeps two settings — *whether* context travels (`picode.context.attach`) and
*how much* (`picode.context.mode`) — but this screen shows only the second. Choosing a card turns
the first on, which is what stops a card from looking selected while nothing is attached. If the
context is off in Settings, the step **says so** and any card turns it back on; a card is never
shown as chosen while the thing it describes is off.

## The model step, after the repairs

- The **white controls** were a real bug with a boring cause: deleting the old vertical-route
  styles took `.preset`, `.field` and the input rules with them, so the browser painted its own
  colours (`rgb(240,240,240)` on a pill, `rgb(255,255,255)` on the key field). Measured, restored,
  and every control now sets its own background and colour instead of trusting an ancestor.
- The **key field** no longer has a whole sentence as its placeholder: `sk-…` inside, the sentence
  underneath. That was the "two texts on top of each other" look.
- **Packages are installed before pi ever loads.** pi's own loader installs a declared-but-missing
  package the moment a session is built — one npm process per package, with no `windowsHide`, so
  each one flashes a console window. The connector already solved it for the editor
  (`packages-install.ts`); the setup calls it before any import, sign-in or provider list, so by the
  time pi runs, its check finds nothing to install and nothing flashes.
- **Importing brings what it says.** Measured on a scratch profile: `settings`, `models`, `mcp`,
  `skills`, `memory` and `sessions` copied, and the models that arrived are `omni`'s 165 — **13 of
  them NAN** (`NAN-DeepSeek_V4.1-Flash`, `NAN-GEMMA4`, `NAN-GLM_5.3-Flash`…). The credential named
  `nan` is a separate item and stays unticked, which is the rule.
- **Local models: two dropdowns, and the first one holds root names only.** `omni · 165 models`,
  `NAN · 6 models`, `nan-providers · 7 models`, `auto · 47 models`, `nvidia · 69 models`… — the
  provider and each of its model families as a plain name, without repeated `omni ›` prefixes. The
  second dropdown holds **only** that entry's models: picking `NAN` leaves exactly the six
  `NAN-…` ids. Nothing is renamed; a family is the namespace the ids already carry.
- **A stale default model is called out.** `deepseek/deepseek-v4-flash` in the profile in front of
  me names a provider that is not declared anywhere, so the editor cannot run it. The panel says
  so — *"the model in force is … and no provider here declares it. Pick one below and save it."* —
  instead of showing a list that never mentions it.
- **Counts read properly**: `1 model` / `2 models`, in the language on screen.
- **One width for the welcome.** Mark, sentence, the three cards and the account card share a
  single 720 px column; the cards are a grid of equal thirds (229 px each, measured) and the account
  card takes the full width of that column — before, each card sized to its own text and the account
  card capped at 520, so three widths met in a column that looked off-centre. The scroll area
  reserves its gutter on **both** edges (`scrollbar-gutter: stable both-edges`): reserving it on the
  right only left every centred block 15 px off. Measured after: 66 px left, 66 px right, 0
  difference.
- **The welcome is centred and its three cards are shortcuts**: 🤖 pi, ⚡ model, 🎨 theme, each
  with its value in `#F3F4F6`, hovering to a `#2563EB` border (verified by moving a real pointer),
  and each jumping to its step. The account card is one line plus one button with an `OPTIONAL`
  badge — no paragraph to read on the first second.

## What the public README says, and what it must not say

`README.md` at the root is read by everyone who finds the repository, so it carries only what is
true today and checkable: the setup is a window of its own before the editor, its themes are
painted in their own colours, and `PiCode: Setup` reopens it. Two claims that had been true and
stopped being true were corrected there rather than left to rot — "five steps … pick the packages"
(there are six, and packages left the setup) and "hover to try a theme on" (the window no longer
repaints itself; the cards carry their own colours).

## What each step decided to stop doing

- **Welcome** shows three facts that are **buttons**: pressing "Model" goes to the model step.
  A summary you cannot act on is a list of words.
- **Model** no longer offers "Connect a subscription" as a card. Its sign-in runs in the editor's
  account flow, and a card whose job is to say *you cannot use me yet* is worse than a sentence:
  it is a footnote below the choices now, and only while nothing is connected.
- **Extras** does not manage `pi packages` any more. Browsing a shelf is not a question a first
  run has to answer; packages live in Agent Customizations → Packages, in the editor.
- **Ready** asks one question — *Where do you want to start?* — with three cards (folder, clone,
  blank). The suggested prompts left this window: they belong in the chat, next to the project
  they talk about, and wiring them there is editor-side work, not a line in this page.
- **Notices** are banners with a close button, they leave on their own, and changing step takes
  them away. An alert that follows somebody from screen to screen is furniture.

A note on the layout bug behind "an empty box in the middle of the model step": `[hidden]` was
being beaten by our own `display: flex`, so a "hidden" panel stayed in the flow. One
`[hidden] { display: none !important }` and the box is gone (measured: height 0).

## The import card asks for its counts on sight

The scan is a child process that reads the other profile and answers **counts only** (~150 ms on
a profile with hundreds of sessions). It runs the moment the card is on screen, not when a card
is clicked: leaving it to a click left *"Reading your setup…"* on screen for ever on the default
choice, which is the built-in pi. `ensurePreview()` runs once, and the card tells three states
apart — reading, the counts, or the failure with a **Retry**.

## What the model step actually checks

- **Test connection** asks the endpoint what it has, with the key, and reports a **measured**
  latency and the real number of models — or the reason it failed: *the key was refused*, *the
  account has no credit left*, *that address has no model list*, *no answer within 20 s*, *the
  address could not be reached*. Nothing is saved until **Connect** is pressed.
- **Get a key** opens the provider's own key page in the browser. The main process only opens
  addresses on a short allowlist, so a page cannot send the owner anywhere it likes.
- **Common picks** are filtered against what the provider returned. A recommendation the account
  cannot run is not shown at all.

## What the extras step really changes

- **What travels with each message** is a setting of the product (`picode.context.mode`), not a
  switch of this page: `project` (folder + file + selection, the default), `file` (no folder),
  `selection` (only the text you selected — no paths at all). The context is assembled in
  `extensions/picode/src/context.ts` (`applyContextMode`), which is pure and covered by tests.
- **Long jobs** sets `picode.durable.autoStart`. The panel that shows a running job is the
  editor's own — the pill above the chat — so this window does not grow a second one.

## Why it is written this way

- **The chrome follows the theme, on hover and on click.** It was switched off for a while (fixed
  palette only) and that turned choosing a theme into choosing a thumbnail, so it is back: hovering
  a card paints the window with that theme's whole palette — background, surface, text, borders and
  accent together, which is what keeps it readable — and leaving the card returns to the theme in
  force. Measured: hovering *Quiet Light* turns the canvas `#F5F5F5`; leaving it returns to `Abyss`.
  The fixed palette is what the window wears before a theme is chosen, and every pair in it was
  measured: primary text 14.8:1 on a card, 17.4:1 on the canvas; white on the blue button 5.2:1.
  on the canvas; secondary 6.4:1 and 7.5:1; white on the blue button 5.2:1 (6.7:1 on hover).
- **No dependencies.** Vanilla HTML, CSS and one script: a page that runs before the editor
  cannot lean on the editor's build, and a bundle here would be a second toolchain to keep alive.
- **It writes nothing itself.** Every write goes through `host.cjs` →
  `extensions/picode/src/onboarding-host.ts`, which reuses the connector's own profile logic
  (`profile-import`, `declarations`, `endpoint`). There is no second copy of the import rules.
- **Credentials are never a default.** The box starts unticked, the request only carries
  `credentials: true` when it was ticked, and nothing fills it in on the way. The note beside it
  says what is **true**: they are kept in the pi profile on this machine and pi uses them only
  against the provider the owner configured. It does **not** claim encryption, because
  `auth.json` is plain JSON on disk — a comfortable lie in a window whose whole job is trust.
- **The editor always opens.** The main process treats a closed window, a dead renderer and a
  page that failed to load as "skip", records it, and carries on to the editor.
- **The window never leaves the editor at zero windows.** VS Code quits when its last window
  closes, and while the editor has not been opened yet this window *is* the last one: closing it
  disposed the application and the editor that started next died with *"Trying to add a disposable
  to a DisposableStore that has already been disposed of"*. So both the last step and the X
  **hide** it, the editor opens with it still alive, and it is destroyed as soon as another window
  exists (`browser-window-created`, with a 10 s fallback). Measured on the packed build, both
  ways: skip and X now open the editor.

## Where the rest of it lives

- The gate, the window, the IPC and the flag: `src/vs/code/electron-main/picodeOnboarding.ts`.
- The backend: `extensions/picode/src/onboarding-host.ts`.
- The command that reopens this window: `src/vs/workbench/contrib/picode/browser/picodeSetupCommands.ts`.
- The folder is copied into the pack by `build/stage-distribution.sh` (step 3b).

## How to verify it without a mouse

The window's own buttons can be pressed over the Chrome DevTools Protocol, which is how the
"skip crashes the editor" bug was found and proven fixed. Start the editor with a debugging port,
then evaluate the click inside the page:

```js
// node --input-type=module <<'JS'
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json')).json();
    target = list.find(t => (t.url ?? '').includes('onboarding/index.html'));
  } catch { /* not up yet */ }
  if (!target) await sleep(500);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.getElementById('skip').click()" } }));
await sleep(1500);
// JS
```

Start the editor with `--remote-debugging-port=9222`, delete `<data>/onboarding.json` first so the
window appears, and check afterwards that **the editor window opened** and the process is still
alive — that is the assertion the crash failed.

The three checks that matter:

1. **Skip** and **X** both end with an editor window, and `onboarding.json` recorded.
2. Deleting the flag and starting again shows the window again; with the flag present, nothing is
   created at all (no window, no child process).
3. `PICODE_ONBOARDING_CONNECTOR=<connector>/out … host.cjs state` answers JSON with the pi version
   — that is the backend working without any editor.
