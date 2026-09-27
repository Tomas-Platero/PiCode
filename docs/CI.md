# La vigilancia del pin en CI

El código fuente de Microsoft **no se sube al repositorio**. Lo que vigilan los
workflows es el *pin*: `upstream/stable.json` (el commit de VS Code) y, como
recordatorio, `upstream/vscodium.json`. La fuente se descarga en el runner a
`picode-source/`, que está en `.gitignore`, y se cachea entre ejecuciones.

Hay tres guardias, una por workflow.

## 1. Check rápido — `.github/workflows/pin-check.yml`

**Cuándo:** en cada `push` y en cada `pull_request`; también a petición del
vigilante semanal.

**Qué hace:** `./dev/build.sh -o`, es decir las fases 1-5 (descargar, marcar,
patches heredados, patches propios, delta del producto) **sin compilar**.
Corre en Linux y en Windows (`patches/vscodium/**` tiene un juego por sistema,
así que un solo runner dejaría la mitad sin comprobar).

**Qué significa un rojo:** un patch de `patches/**` dejó de aplicar contra el
commit pineado. El log dice exactamente cuál (`failed to apply patch <ruta>`),
y el workflow lo resume como un error con el nombre del patch. No hay
`--reject`: un juego a medias es peor que una build parada.

**Reproducirlo en local:**

```bash
./dev/get_repo.sh --fetch     # deja el commit pineado en ./picode-source
bash dev/ci/pin-check.sh      # fases 1-5 y, si algo falla, el patch culpable
```

## 2. Vigilancia semanal del pin — `.github/workflows/pin-watch.yml`

**Cuándo:** lunes a las 06:17 UTC, y a mano desde *Actions*.

**Qué hace:**

1. Pregunta a la API de Microsoft por la última versión *stable*.
2. Pregunta a GitHub por los avisos de seguridad de `microsoft/vscode`
   publicados **después de la versión pineada** (`published_at` posterior a la
   fecha de publicación del pin; si el tag no tiene release, se usa la fecha
   del commit).
3. Si el pin se quedó atrás, abre (o refresca) una PR con el pin nuevo, lanza
   el check rápido contra esa rama y deja un *commit status* en el commit de la
   PR para que se vea en rojo o verde y nombre el patch que se rompió.

**Distinción de seguridad:** si hay algún aviso, la PR se titula
`fix(security): …`, se etiqueta `security` y el cuerpo lista los avisos con su
severidad, CVE y enlace. Una actualización normal se titula `chore(pin): …` y
solo lleva `pin-update`. La severidad (de `low` a `critical`) se ve en el
cuerpo, para decidir la prisa.

Si hay aviso **y no hay versión nueva** a la que moverse, no hay PR: se abre (o
se refresca) un *issue* con etiqueta `security`, para que quede rastreado hasta
que Microsoft publique la corrección.

### Por qué la PR no mueve `upstream/vscodium.json`

Ese pin es un commit de **VSCodium**, no de VS Code, y `patches/vscodium/**` es
*verbatim* de esa revisión. Moverlo sin volver a vendorizar los patches y
`dev/vscodium-product.json` sería mentir sobre su procedencia, y moverlo a un
commit de VS Code —que es lo que suena fácil— apuntaría a un commit que no
existe en ese repositorio. Así que el vigilante mueve solo `stable.json` y el
cuerpo de la PR recuerda revisar la pareja (ver *Los dos pins* en
[`howto-build.md`](howto-build.md)).

### Por qué la PR recibe un *commit status* y no un check normal

GitHub no dispara los workflows de `pull_request` cuando el PR lo abre el
`GITHUB_TOKEN` (es la protección contra recursión). Por eso el vigilante lanza
`pin-check.yml` con `workflow_dispatch` sobre la rama nueva: es la excepción
documentada que el `GITHUB_TOKEN` sí puede disparar. Ese run escribe el estado
`pin-check (phases 1-5)` sobre el commit de la PR.

## 3. Build completo y releases — `.github/workflows/full-build.yml`

**Cuándo:** ÚNICAMENTE al empujar un tag `v*` (que además publica la release) o a
mano desde *Actions*. **No hay nightly ni builds automáticos**: compilar un árbol
sin cambios o sin decisión de release quema minutos para nada. El vigilante del
pin abre la PR de actualización; construir y publicar esa PR es decisión del dueño.

**Qué hace:** `./dev/build.sh` completo (compilación y empaquetado reales) en
**Linux y en Windows** — es el que pilla errores de compilación que las fases 1-5 no
ven, y el que produce los binarios. Cada ejecución sube los dos árboles empaquetados
como artefactos (14 días de retención, con `SHA256SUMS.txt`).

**Releases:** al empujar un tag `v*` (por ejemplo `git tag v0.1.2 && git push origin
v0.1.2`), se publican como release **portables e instaladores** de ambos sistemas:

| Fichero | Qué es |
| --- | --- |
| `PiCode-<versión>-win-x64-setup.exe` | Instalador de Windows (Inno Setup; tarea del propio árbol). Sin firmar: SmartScreen avisa en el primer arranque (Más información → Ejecutar igualmente). |
| `PiCode-<versión>-win-x64.zip` | Portable de Windows. |
| `PiCode-<versión>-linux-x64.deb` / `.rpm` | Instaladores de Linux (dpkg/rpm). Sin firma: no hace falta para descarga directa. |
| `PiCode-<versión>-linux-x64.tar.gz` | Portable de Linux. |
| `SHA256SUMS.txt` | Checksums de todos. |

El nombre sale del tag (sin la `v`); los builds que no son de tag usan la versión del
producto (`distribution/product-delta.json`). Cada ejecución sube los mismos paquetes
como artefactos (14 días de retención), release o no.

**Firma de código:** los binarios de Windows salen sin firmar mientras no exista
certificado. Para activarlo basta con añadir los secretos `PICODE_CODESIGN_PFX`
(certificado en base64) y `PICODE_CODESIGN_PASSWORD`; el workflow firma entonces
`PiCode.exe` y el instalador con `signtool`. En Linux, la descarga directa no exige
firma; firmar el repositorio APT/RPM sería el paso siguiente si algún día se hospeda uno.

**Corre en ambos sistemas.** Linux compila en el larger runner de la
organización (16 GB — el estándar de 7,9 GB fue la fuente de todos los OOM);
Windows es el sistema que se publica, así que compila en el runner estándar
(también 16 GB). El workflow verifica las librerías Spectre de Visual Studio
con `vswhere` y falla con un mensaje claro si no estuvieran.

**Nuevo build = cancela el anterior** (concurrency con `cancel-in-progress`):
un run dejado compilando mientras existe uno más nuevo quema minutos para nada.

## Caché

| Qué | Dónde | Clave | Para qué |
| --- | --- | --- | --- |
| Objetos de git de la fuente | `picode-source/.git` | `vscode-git-<os>-<commit>` | No volver a descargar el commit pineado (~320 MB). |
| Tarballs de npm + cabeceras de node-gyp | `npm config get cache` + `~/.cache/node-gyp` | `npm-cache-<os>-<commit>` | Si hay que instalar de verdad, no repetir la descarga de paquetes. |

**Deliberadamente NO se cachea `node_modules`**: el postinstall de VS Code instala
node modules en ~50 directorios de workspace (`build/`, `remote/`, cada extensión…)
y una caché que solo lleva el raíz hizo que el fast-install confiara en un árbol
a medias — el build del tag murió en fase 7 con `Cannot find package
gulp-merge-json`. El `npm ci` completo cuesta ~4-5 minutos con la caché de
tarballs caliente y siempre es completo: para builds que publican binarios, es
el precio correcto.

## Política de cuándo mover el pin

- **Aviso de seguridad** → tratarlo como urgente: revisar y fusionar **en pocos
  días**. La PR llega etiquetada `security` y con los avisos y sus severidades
  en el cuerpo.
- **Versión normal nueva** → **cuando convenga**, sin plazo fijo. La PR queda
  esperando; no hay que fusionarla cada semana.

En ambos casos, antes de fusionar:

1. El estado `pin-check (phases 1-5)` en la PR está en verde.
2. Se revisó si la pareja `upstream/vscodium.json` + `patches/vscodium/**`
   necesita volver a vendorizarse (si no, se anota por qué no).

## Reserva barata del commit pineado (opción futura, no implementada)

El histórico de VS Code **no** se guarda. Si algún día se quiere una copia del
commit exacto sin el árbol de git (que es de 6,6 GB), `git archive` produce un
archivo sin historial y se puede adjuntar a una release cuando se decida cerrar
ese pin:

```bash
commit="$( jq -r '.commit' upstream/stable.json )"
git -C picode-source archive --format=tar.gz \
  -o "vscode-source-${commit}.tar.gz" "${commit}"
gh release create "source-${commit}" "vscode-source-${commit}.tar.gz" \
  --title "VS Code source ${commit}" \
  --notes "Sin historial; solo el árbol del commit pineado."
```

Es la misma idea que VSCodium no hace y que aquí se deja documentada, sin
ejecutarla: el commit sigue siendo reproducible desde `upstream/stable.json`
mientras GitHub conserve el objeto.

## Límites conocidos

- Las `actions` están fijadas a su etiqueta mayor (`checkout@v7`, `setup-node@v7`, `cache@v6`, todas sobre Node 24). Si se quiere el
  pin más estricto, se fijan al SHA del commit; el coste es mantenerlas a mano.
- El check rápido en Windows instala `jq` con `choco`; es el único paso de
  preparación que no trae el runner.
- El build completo de Linux todavía no se había ejecutado nunca en el
  proyecto (`odd/tasks/picode-build-linux.md`); la primera noche puede destapar
  problemas de Linux sin relación con el pin.
