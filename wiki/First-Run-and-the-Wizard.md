# First Run and the Wizard

First launch of PiCode shows a welcome page with the PiCode mark and a
**three-step setup wizard**, all inside the editor — no terminal step is
required to reach a working agent.

## The steps

1. **Choose the Pi runtime.**
   - **Internal Pi** (the default and the normal choice): a Pi installed by
     PiCode, with its profile inside PiCode's own `data/`. Installed and
     updated from the editor; nobody installs or configures anything by hand.
   - **External Pi**: connect to a Pi that already lives on your machine, to
     use its data where it is. Nothing is ever written to it by PiCode.
2. **Connect a provider and pick a model.** The list shows the subscriptions
   Pi knows how to connect with OAuth (ChatGPT, Claude Pro/Max, Copilot, Grok,
   Kimi, Meta, OpenRouter, Radius…), ordered by the most used, plus a form for
   declaring a compatible endpoint with an API key. OAuth flows are Pi's own —
   browser return, device code for Meta, GitHub Enterprise domains — shown as
   editor dialogs.
3. **Turn Gentle AI on** (optional but intended) and **choose a theme** from
   the gallery with live previews.

Importing an existing external profile is offered as a step with counts (what
will come in: packages, skills, MCPs, sessions). **Credential import is
unchecked by default** and asks for its own confirmation.

## What the welcome page removes

The stock VSCodium first-run noise — Start page, Recent announcements, the
Copilot-era banners — is patched out. If you skip the wizard it can be re-run;
the choices are ordinary settings afterwards.

## After the wizard

- The editor's Chat is the surface. Type `@pi` and ask.
- Pi's settings live under the editor's settings tree, in the product's own
  nodes (`PiCode`, `Settings`, `Providers`) — there is no separate PiCode
  settings page, by design.
- Everything the wizard wrote lives in `data/`. That folder is the unit that
  will sync to the cloud when sync ships.

## Honest status note

The wizard is shipped and works through its rounds; the pieces that read state
*back* from the core (skill/agent discovery wiring, the status view) are still
closing. See [Roadmap and Known State](Roadmap-and-Known-State.md).

---
Next: [Pi Inside](Pi-Inside.md) · [Gentle AI and ODD](Gentle-AI-and-ODD.md)
