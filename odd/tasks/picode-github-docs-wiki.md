# PiCode · Docs de GitHub + Wiki

**Estado:** en curso
**Inicio:** 2026-09-27
**Alcance:** generar los ficheros MD que faltan para un repo GitHub completo, y una wiki
con todo lo conocido del proyecto (fuente: `README.md`, `docs/*.md`, `odd/tasks/*.md`,
memoria de sesiones).

## Decisiones de producto (registradas, no pedidas)

- **Idioma publicado: inglés.** El README público ya está en inglés; CONTRIBUTING, SECURITY,
  CHANGELOG, plantillas y wiki van en inglés. Lo interno (`odd/tasks/`, AGENTS.md) sigue en
  español.
- **Wiki como carpeta `wiki/` versionada en el repo.** La wiki de GitHub es un repo git aparte
  (`PiCode.wiki.git`) y no hay `gh` CLI en esta máquina. Se genera `wiki/Home.md` + páginas
  listas para importar (empujar el contenido a `wiki.git` con git normal).
- **No se duplica información con `docs/`:** `docs/` queda como documentación interna en
  español; la wiki es la capa pública que sintetiza `docs/` + `odd/tasks/`.

## Faltan (inventario verificado)

- [x] `CONTRIBUTING.md` — no existe
- [x] `SECURITY.md` — no existe
- [x] `CHANGELOG.md` — no existe
- [x] `CODE_OF_CONDUCT.md` — no existe
- [x] `.github/ISSUE_TEMPLATE/` (bug, feature, build-report) — no existe
- [x] `.github/PULL_REQUEST_TEMPLATE.md` — no existe
- [x] `docs/README.md` (índice de docs internas) — no existe
- [x] `wiki/` completa — no existe

## Páginas previstas de la wiki

1. `Home.md` — mapa + qué es PiCode
2. `Architecture.md` — 4 capas, parches, dual runtime
3. `Building-PiCode.md` — cómo compilar (Windows/Linux), preflight, pins
4. `The-Patch-System.md` — patches/vscodium + patches/picode, regeneración
5. `Pi-Inside.md` — pi interno vs externo, wizard, migración, proveedores/modelos
6. `Gentle-AI-and-ODD.md` — memoria, skills, ODD/SDD
7. `Distribution-and-Licensing.md` — MIT, upstreams, attribution
8. `CI-and-Release.md` — workflows full-build, pin-check, pin-watch
9. `Roadmap-and-Known-State.md` — qué existe hoy, qué falta (sintetizado de odd/tasks)
10. `Glossary.md` — términos (host, pinned, lineage…)

## Tareas y evidencia

- [x] Mapeo de conocimiento — dos agentes Explore leyeron los 34 ficheros de
  `odd/tasks/` (digest) y leímos los 9 de `docs/` + README + git log.
- [x] `CONTRIBUTING.md` — EN, rutas de colaboración, reglas que ya quemaron
  (claves iteradas, `defaultChatAgent`, namespaces intocables, pines juntos).
- [x] `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- [x] `SECURITY.md` — aviso privado, pin-watch como detector de advisories,
  sin firmar (SmartScreen), verificación de SHA256.
- [x] `CHANGELOG.md` — Keep a Changelog; v0.1.0/0.1.1/0.1.2 extraídos del
  histórico real de commits entre tags (verificado con `git log v0.1.1..v0.1.2`).
- [x] `.github/ISSUE_TEMPLATE/` — `bug_report.yml`, `feature_request.yml`,
  `build_failure.yml`, `config.yml` (YAML validado con PyYAML; líneas ≤80 por
  regla del linter).
- [x] `.github/PULL_REQUEST_TEMPLATE.md` — una unidad revisable por PR, casilla
  "cómo se observó funcionando", capa tocada, pines.
- [x] `docs/README.md` — índice interno en español con orden de precedencia de
  papeles.
- [x] `wiki/` — 13 páginas en inglés: Home, What-PiCode-Is, Getting-PiCode,
  First-Run-and-the-Wizard, Architecture, Building-PiCode, The-Patch-System,
  Pi-Inside, Gentle-AI-and-ODD, Distribution-and-Licensing, CI-and-Releases,
  Decisions-Log, Roadmap-and-Known-State, Glossary. Enlaces internos
  normalizados a `Pagina.md` (funcionan en la vista del repo y al importar a
  la wiki de GitHub) y verificados con script de integridad (`ALL LINKS OK`).
- [x] `README.md` — fila `wiki/` en la tabla de contenido + puntero al índice
  de `docs/`.

**Comités:** `0a2d9da` docs(github) y el HEAD de la rama, docs(wiki) (los hashes de la wiki cambian con cada amend del record; el record vive dentro de ese commit) en la rama `docs/github-docs-wiki` (master intacto; verificado con `git log`/`git diff --stat`: 26 ficheros, +1764).

## Cómo importar la wiki a GitHub

```bash
git clone https://github.com/Tomas-Platero/PiCode.wiki.git piwiki
 cp wiki/*.md piwiki/ && cd piwiki && git add -A && git commit -m "docs: seed the wiki from the repository"
 git push
```

(La primera vez, el repo `PiCode.wiki.git` aparece al pulsar *Wiki* en la
pestaña del repo y crear la primera página desde la web.)
