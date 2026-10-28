# 🩹 Actualizaciones pequeñas: hotfix, minor update y release

Cómo llega a la gente un arreglo sin que tenga que bajar la app entera, y qué protege que
nunca se quede peor de lo que estaba. La decisión está en [ADR-034](DECISIONS.md); la frase
del dueño y su traducción, en [`AGENTS.md`](../AGENTS.md).

> *"Hay que pensar un sistema de hotfixes rápidos para esto que no sea rebuildeando todo."*
> *"No quiero subir una 0.3.2 a 0.3.3 y encontrarme problemas y errores."*

## 🧭 La idea

Cada release es una versión de verdad (`0.5.0` → `0.5.1` → `0.6.0`). Lo único que cambia es
**cómo le llega a cada persona**:

| Quien está en… | Recibe |
| --- | --- |
| la versión anterior exacta, con la app portable | un **zip pequeño** con solo los ficheros que cambiaron |
| cualquier otra versión, o con instalador | la release completa de siempre |
| cualquier caso en que el zip pequeño falle | la release completa, sola y sin avisar de nada raro |

El resultado es **idéntico** en los tres casos: los mismos ficheros, la misma versión. No hay
contador de «fixes» ni numeración aparte.

## 🏷️ Las etiquetas

La etiqueta la pone el pipeline mirando los cambios (`node build/release.mjs kind`); el dueño
puede cambiarla con la variable `UPDATE_KIND_OVERRIDE` del repositorio.

| Etiqueta | Cuándo | Número |
| --- | --- | --- |
| **Hotfix** | solo arreglos, rendimiento y mantenimiento | sube el último dígito |
| **Minor update** | hay alguna novedad (`feat`) | sube el del medio |
| **Release** | no cabe en un zip pequeño: toca el motor, dependencias, pi o la identidad | el que decida el dueño |

La etiqueta no decide la descarga: una Minor update puede llegar como zip pequeño, y un Hotfix
puede llegar entero si hace falta. En el editor se lee «Latest Version: Minor update 0.5.0».

Un **Hotfix** no espera las 120 h de `update.minReleaseAge`: se ofrece a las 6 h. La fecha del
feed no se toca; lo que cambia es la espera. Las demás etiquetas esperan lo de siempre.

## ✅ Qué puede viajar en un zip pequeño

Es una **lista de lo permitido**, no de prohibiciones: lo que no está en la lista obliga a
release completa, sin que nadie tenga que acordarse.

| Entra | No entra (→ release completa) |
| --- | --- |
| `resources/app/out/` (el editor, el chat, las pantallas, los estilos) | Electron: el `.exe`, las `.dll`, `.pak`, `locales`, snapshots |
| `resources/app/extensions/` (incluido el conector `extensions/picode`) | dependencias (`node_modules.asar`, módulos nativos `.node`) |
| `resources/app/resources/` (iconos y medios) | pi y sus paquetes fijados (`resources/pi-runtime`) |
| `resources/onboarding/` (el asistente de primer arranque) | engram (`resources/memory`) |
| `product.json` y `package.json`, **solo** los campos `version`, `picodeVersion`, `commit`, `date` y `checksums` | la identidad del producto (nombre, AppId, mutex, `updateUrl`…) |

Además, ningún fichero `.exe .dll .node .asar .pak .dat .bin .so .dylib .sys .msi` viaja
nunca, aunque esté en una carpeta permitida. Un cambio que migre datos del usuario (chats,
ajustes, `~/.engram`) tampoco entra: **deshacer** devuelve los ficheros, no los datos que ya se
transformaron. Esa regla no la puede comprobar una herramienta; la aplica quien revisa el
cambio.

Para añadir una carpeta a la lista hay que cambiar `DELTA_ALLOWED_PREFIXES` en
[`deltaPackage.ts`](../src/vs/platform/update/node/deltaPackage.ts) y apuntarlo en el ADR.

## 🛡️ Qué protege a la persona

| Qué podría pasar | Qué lo cubre |
| --- | --- |
| el zip es para otra versión | el editor compara la versión y, fichero a fichero, que el original es el esperado; si no, descarga la completa |
| alguien manipula el zip o el servidor | el manifiesto va **firmado** (Ed25519); sin firma válida con la clave del producto, no se aplica |
| el zip trae una ruta que sale de la carpeta (`..`, absoluta, `C:`) | se rechaza todo el paquete antes de tocar nada |
| el zip se corta o se corrompe | comprobación SHA-256 del zip y de cada fichero, antes y después de copiarlo |
| se aplica a medias | se aplica sobre una **copia** de la instalación, no sobre la que está abierta; si algo falla, la copia se borra y no pasó nada |
| Windows no deja cambiar ficheros abiertos | el cambio se hace con la app cerrada, por un script que espera a que termine |
| la versión nueva no arranca | el script no borra la anterior hasta que la nueva **demuestra que arrancó**; si en unos 3 minutos no lo hace, la mata y **vuelve a poner la anterior con el perfil** |
| el perfil portable (`data/`) | nunca está en el zip y siempre se conserva |

La prueba de que la versión nueva arrancó es: el script deja un `update-verify`; el editor,
con la ventana abierta unos segundos, lo borra y escribe `data/.update-ok`. Es una prueba de
**arranque**, no de que cada pantalla funcione.

## 🏗️ Cómo se hace (CI)

El paso «Make the small update…» de [`release.yml`](../.github/workflows/release.yml), con cada release:

1. baja la release **anterior** del canal (todavía no se ha borrado) y comprueba su hash;
2. `node build/hotfix.mjs make` compara las dos builds reales y genera el paquete, firmado;
3. `node build/hotfix.mjs check` **prueba la equivalencia**: copia la build vieja, le aplica el
   paquete y compara el resultado con la build nueva, fichero a fichero. Si no son idénticas,
   no se publica el paquete (y se avisa en el run);
4. lo sube como un fichero más de la release y lo anuncia en el feed (`delta`, `kind`).

Cualquier fallo en esos pasos acaba igual: **sin paquete pequeño** y la release completa, que
siempre sirve. Nunca se publica un paquete sin comprobar.

El paquete sale de las dos builds completas, así que **no evita construir la release**; evita
que la gente la descargue entera. Para ver un cambio mientras se trabaja sigue valiendo
`build/build-fast.sh` (sin comprobación de tipos) o el bucle de `docs/howto-build.md`.

> 🩹 **Corregido el 2026-10-28:** desde 0.5.1 el paso decía siempre «la release anterior no coincide con su hash» y
> todas las releases salían enteras. Causa: la carpeta de trabajo estaba en `RUNNER_TEMP` (`D:\a\_temp`); con esas
> barras `sha256sum` antepone una `\` al hash y `require()` pierde la unidad. Ahora el trabajo va en una carpeta
> relativa del repositorio y el hash se lee por la entrada estándar. Comprobado en un runner de verdad, de punta a
> punta (zip pequeño firmado, ficheros idénticos). Un fallo así sale ahora como aviso (`::warning::`), no como nota.

## 🔑 La clave de firma

- La parte **pública** vive en `product.json` (`hotfixPublicKey`).
- La parte **privada** es el secreto del repositorio `HOTFIX_SIGNING_KEY` (el contenido del `.pem`).
  Sin él, el pipeline no hace paquetes pequeños y las releases salen enteras.
- Se crea con `node build/hotfix.mjs keygen --out <fichero.pem>`, que imprime la clave pública.
- Cambiar de clave exige una **release completa** con la nueva pública dentro: los paquetes
  firmados con la nueva no valen para quien lleve la vieja.

## 🧪 Cómo se prueba

```bash
node --test build/hotfix.test.mjs
```

Doce pruebas, sin simulaciones: rutas permitidas y prohibidas, paquete y equivalencia, cambios
del motor / dependencias / pi / identidad (rechazados), fichero manipulado, original distinto
del esperado, firma (falta, manipulada, de otra clave) y el script de cambio de carpeta en
Windows, tanto cuando la versión nueva arranca como cuando no.

## ⚠️ Límites conocidos

- **Solo la versión portable** recibe el zip pequeño. La instalada (Inno) se actualiza con su
  instalador; no tiene sentido darle una carpeta de cambios.
- **Solo desde la versión anterior.** La regla de «una sola release por canal» borra las
  anteriores; quien esté dos versiones atrás recibe la completa.
- **Pi, engram y las dependencias** nunca viajan en un zip pequeño (ver la tabla). Cuando se
  mire qué hay en `resources/pi-runtime`, puede abrirse esa puerta con su propia comprobación.
- **La prueba de arranque no es una prueba funcional:** una pantalla rota que no impida abrir
  la ventana no se deshace sola.
- **No hay aún canal para empujar un arreglo a quien ya tiene la última versión** sin subir el
  número: cada hotfix es una versión nueva.
