# Feature: tres canales de release — RC / Beta / Experimental

**Estado:** diseño medido, primeras piedras puestas · **Rama:** `experimental` · **Abierta:** 2026-10-08

## Intención del dueño

> «Me gustaría tener 3 ramas. RC / Beta / Experimental.
> RC -> Canal release candidate, las releases que serán vx.0.0 (1.0.0, 2.0.0). Actualmente no tenemos aún ninguna pero me gustaría prepararlo.
> Beta -> Canal de betas, las releases que serán vx.x.x-beta (0.2.3-beta por ejemplo, pero deben ir por delante de las RC.
> Experimental -> Canal de release experimentales vx.x.x-experimental. Este canal puede mergearse en beta o en rc directamente.
> Cada release saca un "producto" con un canal. Como Chrome normal, beta y canary.
> Un PiCode Beta no puede actualizarse por el canal de experimental, ni el de rc por el de beta.
> Deberíamos también poder tener instalado 3 picodes diferentes como 3 chromes diferentes se pueden instalar.»

Y la pregunta que lo abre: **¿pueden las builds experimentales actualizarse por el updater?**
Respuesta medida: **hoy no** — una experimental no publica feed, a propósito. **Con canales, sí**:
cada build lleva su canal sellado y lee su propio feed; una experimental se actualizaría desde el
canal experimental y jamás vería lo que publican beta o rc.

## Lo que se midió antes de diseñar

| Mecanismo | Cómo funciona hoy | Dónde |
| --- | --- | --- |
| URL del feed | `${updateUrl}/${quality}/${platform}/${arch}/${target}/latest.json` — el **segmento del canal es `product.json → quality`** | `src/vs/platform/update/electron-main/abstractUpdateService.ts:34-38` |
| Comparación de versiones | La app compara el `productVersion` del feed con el instalado; el `picodeVersion` es el nombre y lo que enseña la UI | `updateService.win32.ts`, `dev/update-feed.mjs` |
| Carretón temporal | El feed solo se ofrece con la versión estrictamente mayor **y** el timestamp más viejo que `update.minReleaseAge` (120 h por defecto) | skill de release |
| Generador de feeds | `--quality` existía pero solo aceptaba `stable\|insider` | `dev/update-feed.mjs:34` |
| Trampa de versión | En el empaquetado, un `quality ≠ stable` **añade el sufijo a la versión del editor** (`1.135.7-beta`) — y esa versión es la que casan las extensiones con `engines.vscode` | `build/gulpfile.vscode.ts:301-304` |
| Convivencia | El instalador side-by-side ya distingue dos instalaciones: carpeta, nombre largo y AppId propios por `PICODE_INSTALLER_SUFFIX`. **El mutex y el perfil se comparten a propósito**: solo una de las dos corre a la vez | `build/gulpfile.vscode.win32.ts:100-150` |
| Pipeline de publicación | `release.yml` publica el canal estable desde etiquetas `v*` y **rechaza** `v*-experimental`; las experimentales se cortan a mano (`dev/publish` vía API) | `.github/workflows/release.yml`, `.scratch/publish-experimental-*.sh` |

## El diseño, contra cada frase del dueño

### «Cada release saca un producto con un canal»

El canal vive en **`product.json → quality`** de la build, sellado en la fase de versión a partir
de un `PICODE_CHANNEL` (o del delta por canal). De ahí salen las dos cosas que definen un canal:

1. **Qué feed lee el updater**: `updates/<canal>/win32/x64/{archive,user}/latest.json`.
2. **Cómo se llama y dónde se instala**: carpeta, nombre largo, AppId — la maquinaria
   side-by-side ya existente, parametrizada por canal.

| Canal | Calidad | Versión PiCode | Feed | Publicación |
| --- | --- | --- | --- | --- |
| **RC** (el "Chrome estable") | `stable` (sin renombrar — es la ruta que ya funciona) | `x.0.0` sin sufijo (`1.0.0`) | `updates/stable/…` (hoy) | `release.yml`, etiquetas `v*` — ya existe |
| **Beta** | `beta` | `x.y.z-beta` | `updates/beta/…` | etiquetas `v*-beta` → pipeline propio (o manual como las experimentales hasta que exista) |
| **Experimental** | `experimental` | `x.y.z-experimental` | `updates/experimental/…` | a mano, el mismo script de hoy con `--channel` |

### «Un Beta no puede actualizarse por el canal de experimental, ni rc por beta»

Sale **gratis** del diseño: cada build pregunta a la ruta de SU canal. No hay cruce posible,
porque ningún build conoce la ruta de otro. La única condición es que el sellado del canal sea
inmutable en el binario (no un ajuste), que es como lo mide `getProductQuality`: lo trae el
`product.json`, no la configuración del usuario.

### «Las betas deben ir por delante de las RC»

El orden es de **proceso**, no de mecanismo: las betas se cortan de commits que están por
delante, y cada feed de canal exige que su `productVersion` crezca estrictamente
(`--installed` por canal). Un merge de experimental a beta seguido de corte beta lleva
siempre una versión de editor igual o mayor que la última rc publicada. La versión
PiCode (`0.2.3-beta` > `1.0.0` en nombre) es etiqueta para personas; la comparación del
updater es la del editor, y por canal no se cruza nunca.

### «Este canal puede mergearse en beta o en rc directamente»

Es el flujo git: `experimental` → `beta` → `rc`. El canal del **producto** se sella al cortar,
no al mergear: un merge no publica nada; publicar es cortar una build con `PICODE_CHANNEL`
correspondiente. Así un mismo commit puede acabar en beta y, corregido, en rc.

### «3 PiCodes instalados como 3 Chromes»

La maquinaria side-by-side ya distingue dos instalaciones; se extiende a tres identidades
fijas (una por canal), no por sufijo libre:

| | RC (estable) | Beta | Experimental |
| --- | --- | --- | --- |
| Carpeta | `PiCode` | `PiCode Beta` | `PiCode Experimental` |
| Menú inicio / Apps | PiCode | PiCode Beta | PiCode Experimental |
| AppId | el de release | uno por canal (como `SIDE_BY_SIDE_APP_IDS` hoy) | otro |
| **Mutex** | **uno por canal** — tres chromes corren a la vez | | |
| **Perfil** | **uno por canal** — la recomendación medida | | |

**La única decisión abierta** (no bloquea el resto): hoy la experimental **comparte perfil y
mutex** con la estable a propósito — el dueño lo quiere así para esa pareja. Con tres canales
"como Chrome", la recomendación es **perfil y mutex por canal**: un bug de beta no puede
corromper el perfil del editor diario, y los tres pueden correr a la vez. La alternativa
(fiel al comportamiento actual) es compartir perfil con un mutex compartido — tres instalados,
uno corriendo. El perfil por canal necesita migración la primera vez (o empezar vacío).

### La trampa que hay que desactivar

`build/gulpfile.vscode.ts:301-304` añade `-{quality}` a la versión del editor cuando el canal
no es `stable`. Con canales, eso produciría editores `1.135.7-beta`, cuya `engines.vscode`
dejaría de casar con las extensiones. **Tarea concreta**: en el empaquetado por canal, la
versión del editor no se toca — el canal viaja en `quality` (ruta del feed) y en
`picodeVersion` (nombre), no en la versión que casan las extensiones.

## Hecho ya

- [x] `dev/update-feed.mjs` acepta `beta`, `experimental` y `rc` como canales de feed
      (`--quality`), además de `stable`/`insider`. Ruta del feed por canal intacta.

## Tasks

- [x] **C1** · Sellado del canal en la build: hecho en `7ad0d89d`. `dev/build.sh` lee
      `PICODE_CHANNEL` (`rc|beta|experimental`) y escribe `quality` (`stable|beta|experimental`)
      en el `product.json` del árbol. **Ojo**: solo actúa si la variable está puesta; sin ella,
      `quality` se queda como esté en el árbol.
- [x] **C2** · Sufijo de versión por calidad desactivado: hecho en `7ad0d89d`.
      `picode-source/build/gulpfile.vscode.ts:301-310` — solo `insider` recibe sufijo, así que
      `beta`/`experimental`/`rc` conservan la versión limpia que casan las extensiones.
- [ ] **C3** · Identidad de instalador por canal: DirName/NameLong/AppId/**mutex** fijos por
      canal en `gulpfile.vscode.win32.ts`, reutilizando la maquinaria side-by-side.
- [ ] **C4** · Perfil por canal: `dataFolderName` por canal (o la decisión del dueño de
      compartir), con la nota de migración.
- [ ] **C5** · Pipeline beta: etiquetas `v*-beta` con su ruta de publicación (manual primero,
      workflow después), feeds `updates/beta/…` con `--installed` propio.
- [ ] **C6** · Feeds experimentales: extender el script `.scratch/publish-experimental-*.sh`
      con `--channel experimental` para que una experimental **sí** actualice vía updater.
- [ ] **C7** · Verificación end to end: tres builds instaladas en la misma máquina, cada una
      ofrecida solo por su canal, dos corriendo a la vez.

## Registro

- 2026-10-08 · **Medido el estado real de los feeds**: de los tres canales solo existe **uno**.
  `updates/stable/win32/x64/{user,archive}/latest.json` existe y apunta a **0.1.3-beta**
  (`productVersion 1.135.5`); **no hay `updates/beta/…` ni `updates/experimental/…`**. Las
  experimentales 0.1.4 y 0.1.5 se publicaron **al margen del canal**: su paquete se construyó con
  `quality: stable` (comprobado en `picode-source/.build/win32-x64/user-setup/product.json`), así
  que no tienen feed propio. La maquinaria está lista (C1 y C2 hechos); lo que falta son los
  feeds y la identidad por canal (C3–C7).
- 2026-10-08 · **Trampa viva**: `picode-source/product.json` tiene hoy `quality: beta` sin
  commitear (en HEAD es `stable`) y **el delta no fija `quality`**, así que una build hecha **sin
  `PICODE_CHANNEL`** saldría leyendo `updates/beta/…`, que no existe: esa instalación no se
  actualizaría nunca. Hay que decidir: commitear `beta` como parte de crear el canal, o volver a
  `stable`.
- 2026-10-08 · Abierta con las palabras del dueño. Todo el mecanismo medido antes de diseñar;
  el hallazgo que ordena el diseño es que `quality` ya ES el canal para el updater (ruta del
  feed) pero hoy arrastra una mutación de versión del editor que hay que desactivar.
