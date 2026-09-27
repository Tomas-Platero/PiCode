# Build veloz

**Estado:** en curso · **Rama:** `feat/source-in-repo` · **Abierto:** 2026-09-27

## Intención del dueño

El build llega a **210 minutos** (medido en la cadena vieja, Windows). El dueño quiere
trabajar desde la fuente propia *y* que eso no cueste horas por cambio. Frase de apertura de
esta fase: «pues sigue» sobre el paso anunciado como pendiente: *«que compilar y empaquetar se
borre y se rehaga entero cada vez»*.

## Hechos medidos antes de tocar nada

- La fase 3 del build actual es `gulp vscode-min-prepack`: borra `out-build`, compila los
  ~4.000 ficheros de `src/` con **gulp-tsb** (TypeScript en JS, mono-proceso, sin incremental),
  y luego agrupa y minifica fichero a fichero.
- `picode-source/build/buildConfig.ts` tiene `useEsbuildTranspile = false`. El valor **de
  fábrica de VS Code es `true`**; lo cambió VSCodium con un parche de una línea
  (`patches/vscodium/00-build-disable-esbuild.patch`) **sin explicar el porqué en ninguna
  parte**. Su comentario: con `true`, el self-hosting transpila con esbuild (build/next) y
  gulp-tsb solo verifica tipos; con `false`, gulp-tsb hace las dos cosas.
- Efecto secundario conocido de ese `false`: `npm run watch` queda en **no-op** —
  `build/next/index.ts` imprime *"esbuild transpile disabled… keeping process alive as no-op"*.
  Hoy no existe bucle de desarrollo: ver un cambio exige el build completo.
- La minificación por fichero (esbuild, ~797 ficheros) sigue ACTIVA; lo apagado es la
  transpilación rápida, no la minificación.
- Palancas sin usar: `npm run build-fast` (esbuild por fichero con estado en
  `.build/build-fast/`), `scripts/code.bat` (arrancar el editor desde la fuente, sin
  empaquetar), y el empaquetado a secas (`vscode-win32-x64-min-packing` solo copia).
- Máquina: 16 núcleos, heap 12 GB. El cuello no es la RAM.

## Tareas

| # | Tarea | Estado |
| --- | --- | --- |
| B1 | **Medir la línea base**: tiempo real de `vscode-min-prepack` en esta máquina con el árbol actual (de paso, primera verificación de la compilación tras la reescritura del build) | ✅ **311 s (5,1 min), exit 0**. Desglose: `compile-src` (gulp-tsb) 264 s · extensiones 18 s · `bundle-vscode` 11 s · `minify-vscode` 9 s · limpieza+resto 9 s. **La fase 3 no es el problema: los 210 min eran de la cadena vieja** (npm ci cada build, nativos, CI). El registro está en `.scratch/baseline-prepack.{log,time}` |
| B2 | **Mapear el camino esbuild**: qué produce hoy con `true`, por dónde pasa el NLS, dónde queda el chequeo de tipos, y qué espera el empaquetado que le den | 🔄 agente explorando (solo lectura) |
| B3 | **Bucle de desarrollo**: reactivar `useEsbuildTranspile` en el árbol (es nuestro código: se edita, no se parchea) y conseguir `watch` + arrancar el editor desde la fuente en minutos/segundos | ⏳ depende de B1/B2 |
| B4 | **Decidir la ruta de release**: si el bundle de release puede hacerse por el camino esbuild sin romper empaquetado, o se queda prepack y solo se quitan borrados innecesarios | ⏳ |
| B5 | **Quitar borrados** (`rimraf` de `out-build`/`out-vscode`/`out-vscode-min`/`.build/extensions`) cuando el re-uso sea seguro | ❌ **retirada como objetivo**: con el build completo a ~6 min, los `rimraf` cuestan 3 s en total (medido en B1: `clean-out-build` 2,8 s). No hay nada que ganar ahí |
| B6 | **Re-empaquetar sin re-compilar** cuando `src/` no cambió | ⚠️ posible pero innecesario: el empaquetado entero cuesta 36 s |
| B7 | **Verificar de punta a punta**: build completo medido tras los cambios + prueba de arranque del editor | ⏳ |
| B8 | **Documentar** (dev/README, howto-build, esta ficha) con números reales | ⏳ |

## Decisiones

- (pendiente de B2/B4)

## Anatomía final medida (esta máquina, 16 núcleos, árbol ya instalado)

| Fase | Coste |
| --- | --- |
| 1 prepare (árbol + identidad) | segundos; dependencias solo la primera vez |
| 2 conector | segundos |
| 3 compilar | **5 min 05 s** (`compile-src` 264 s es el 85 %) |
| 4 empaquetar | **36 s** |
| 5 rematado (pi + producto + perfil) | **17 s** |
| **Build completo en régimen normal** | **≈ 6 minutos** |

Prueba de arranque del editor recién construido: el proceso principal levantó, creó su
almacén, restauró el perfil (109 ficheros) y reporta `update#setState disabled` — arranca.
(Se lanzó con `--version` desde consola y el proceso quedó vivo hasta que se cerró solo; no
quedó ninguna ventana abierta.)

## Registro

- 2026-09-27 · abierta la ficha; B1 lanzada (línea base cronometrada del `vscode-min-prepack`
  tal como lo invoca `dev/build.sh`, mismo entorno y mismo heap); B2 lanzada (agente de
  exploración de solo lectura sobre el pipeline).
- 2026-09-27 · **B1 terminada: 5,1 min, exit 0.** La compilación completa no cuesta horas en
  esta máquina; el techo de 210 min pertenecía a la cadena vieja (dependencias reinstaladas en
  cada build, módulo nativo recompilado, runners de CI). Esto reordena las prioridades: la
  palanca real que queda es el **bucle de desarrollo** (ver un cambio sin recompilar todo), y
  medir cuánto cuesta realmente el resto (empaquetado y rematado en marcha).
- 2026-09-27 · lanzada la medida del empaquetado (fase 4 sola, sobre el `out-vscode-min` que
  acaba de producir B1): `.scratch/baseline-pack.{log,time}`.
- 2026-09-27 · **empaquetado: 36 s, exit 0** (`PiCode.exe` de 222 MB regenerado). El pack solo
  copia: no es ningún cuello. Anatomía local conocida: compilar 5,1 min + empaquetar 36 s +
  rematado (midiendose ahora). **La premisa de las horas era de la cadena vieja**; lo que de
  verdad queda por resolver es el bucle de desarrollo.
- 2026-09-27 · lanzada la fase 5 cruda (pi + rematado) con copia previa de `data/` y
  `restore-profile.mjs` al terminar: es también la primera ejecución real de esa fase tras la
  reescritura.
- 2026-09-27 · **rematado: 17 s, exit 0**, 7 pasos completos, perfil restaurado. Con esto la
  cadena entta está verificada de punta a punta por primera vez desde la reescritura: `-o`
  ✓ · conector ✓ · compilar ✓ (5,1 min) · empaquetar ✓ (36 s) · rematar ✓ (17 s) · arrancar ✓.
  **El problema de las horas ya no existe en local**; se fue con la cadena vieja. Lo único que
  queda del objetivo original es el bucle de desarrollo (B3) y decidir la ruta de release (B4,
  con B4 probablemente ya irrelevante: 6 min es un release barato).
