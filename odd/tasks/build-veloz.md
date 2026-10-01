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
| B2 | **Mapear el camino esbuild**: qué produce hoy con `true`, por dónde pasa el NLS, dónde queda el chequeo de tipos, y qué espera el empaquetado que le den | ✅ agente de lectura completado. Claves: el interruptor solo lo leen 3 sitios (`buildConfig.ts:12`, `gulpfile.vscode.ts:664`, `build/next/index.ts:1036` — este último es el `watch` que se quedaba en nada); con `true` el NLS va dentro del bundle (`--nls`, autocomprobado) y **no hay ningún chequeo de tipos en la ruta** — vivo; el empaquetador exige exactamente 10 ficheros con checksum + `date` + `nls.messages/keys` + `main/cli/bootstrap-fork`, y el bundle de esbuild los produce todos (verificado); `npm run build-fast` está muerto de nacimiento (tres referencias a `extensions/copilot`, borrado por VSCodium); el `disableMangle` de `lib/compilation.ts:123` es un booleano ignorado |
| B3 | **Bucle de desarrollo**: reactivar `useEsbuildTranspile` en el árbol (es nuestro código: se edita, no se parchea) y conseguir `watch` + arrancar el editor desde la fuente en minutos/segundos | ✅ interruptor devuelto a `true` (valor de fábrica de Microsoft: fue VSCodium quien lo apagó sin explicar por qué) **y control de tipos cosido a la ruta nueva** (`picode-typecheck`: `tsgo --noEmit` en la serie de prepack, como ya hacía `core-ci`). Medido: transpilación completa de `src/` → `out/` en **6,8 s** (7.559 ficheros); `npm run watch` ya no es un bucle vacío — existe de verdad; el editor arranca desde `out/` con `scripts/code.bat` (UI en inglés en modo desarrollo, sin pasar por NLS: es el diseño de Microsoft para el bucle, no un defecto) |
| B4 | **Decidir la ruta de release**: si el bundle de release puede hacerse por el camino esbuild sin romper empaquetado, o se queda prepack y solo se quitan borrados innecesarios | ✅ **decidida al revés que el primer borrador**: release TAMBIÉN por esbuild. El argumento de "riesgo sin recompensa" (medido antes) se cayó solo al medir: la ruta esbuild compila el producto en 41 s frente a 5 min 05 s, y el hueco del control de tipos se cerró cosiendo `tsgo` al prepack. Riesgo que queda y está anotado: los mapas de origen cambian de nombre (inofensivo — se expulsan del paquete) y ningún idioma empaquetado ha probado aún el índice NLS de esbuild | 
| B5 | **Quitar borrados** (`rimraf` de `out-build`/`out-vscode`/`out-vscode-min`/`.build/extensions`) cuando el re-uso sea seguro | ❌ **retirada como objetivo**: con el build completo a ~6 min, los `rimraf` cuestan 3 s en total (medido en B1: `clean-out-build` 2,8 s). No hay nada que ganar ahí |
| B6 | **Re-empaquetar sin re-compilar** cuando `src/` no cambió | ⚠️ posible pero innecesario: el empaquetado entero cuesta 36 s |
| B7 | **Verificar de punta a punta**: build completo medido tras los cambios + prueba de arranque del editor | ✅ `dev/build-run.sh` completo, estado **0**: preparar + conector + compilar (41 s) + empaquetar (2 min 23 s, bundle incluido) + rematado + perfil restaurado (138 ficheros). **Total real: 3 min 34 s.** `PiCode.exe` arrancado después: 8 procesos, ventana arriba | 
| B8 | **Documentar** (dev/README, howto-build, esta ficha) con números reales | ✅ README, dev/README (fases 3 y 4 reescritas), howto-build (medición nueva junto a la vieja, ambas fechadas) y esta ficha |

## Decisiones

- **El release va por esbuild** (invierte el primer borrador de B4, decidido con números):
  `useEsbuildTranspile = true` es el valor de fábrica de Microsoft; el `false` era una
  herencia de VSCodium sin justificación escrita en ninguna parte. El único hueco real de la
  ruta (ningún control de tipos) se cierra con `picode-typecheck` en el prepack. Rollback
  quirúrgico si algo falla mañana: cambiar una palabra a `false` (el paso de tipos queda
  inerte en la ruta clásica, que ya controla por su cuenta).
- **No se toca el código muerto de más arriba** para contentar linters: los avisos de estilo
  sobre líneas que no tocamos (doble negación, aserciones `!`) se anotan y se dejan —
  reescribir `build/` de Microsoft solo encarece el próximo merge. Lo que sí se corrigió, al
  pasar el fichero por el cedazo: una función sin uso con su lectura de `package-lock` y dos
  lecturas de metadatos del paquete que petaban crudo → ahora fallan con mensaje claro.
- **`build-fast` queda muerto por ahora**: tres referencias a `extensions/copilot` (borrado
  por VSCodium) lo revientan. Se arregla el día que haga falta; `transpile-client` cumple.

## Anatomía final medida (esta máquina, 16 núcleos, árbol ya instalado)

### Con la ruta clásica (gulp-tsb), antes de reactivar esbuild — 2026-09-27 por la mañana

| Fase | Coste |
| --- | --- |
| 1 prepare (árbol + identidad) | segundos; dependencias solo la primera vez |
| 2 conector | segundos |
| 3 compilar | **5 min 05 s** (`compile-src` 264 s es el 85 %) |
| 4 empaquetar | **36 s** |
| 5 rematado (pi + producto + perfil) | **17 s** |
| **Build completo en régimen normal** | **≈ 6 minutos** |

### Con esbuild reactivado (la ruta de fábrica), mismo día — números vigentes

| Fase | Coste |
| --- | --- |
| 3 compilar (prepack: tipos 14 s + extensiones) | **41 s** |
| 4 empaquetar (bundle de 24 salidas ~100 s + nativas + armado) | **2 min 23 s** |
| 5 rematado | **17 s** |
| **Build completo de punta a punta (runner, con copias de seguridad)** | **3 min 34 s** |

Prueba de arranque: `PiCode.exe` construido con la ruta nueva levanta (8 procesos, ventana
visible). El editor de desarrollo (`out/` + `scripts/code.bat`) también quedó verificado en
la primera ejecución, con la UI en inglés que corresponde al modo desarrollo.

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
- 2026-09-27 · **B2 terminada** (informe completo del agente de lectura, 191 consultas): los
  3 lectores del interruptor, el NLS dentro del bundle, el hueco de tipos, el contrato exacto
  del empaquetador (10 ficheros de checksum — todos los produce esbuild) y tres bombas
  halladas: `build-fast` muerto por `extensions/copilot`, `watch` en no-op con `false`, y el
  `disableMangle` ignorado.
- 2026-09-27 · **B3/B4 ejecutadas juntas**: interruptor a `true`, `picode-typecheck` cosido al
  prepack, y limpieza de las tres líneas muertas del fichero tocado (función sin uso + dos
  lecturas de metadatos con fallo claro). Transpilación de medida: 6,8 s / 7.559 ficheros.
  Build completo con la mecanica nueva en marcha (registro en `.scratch/build-live.log`).
