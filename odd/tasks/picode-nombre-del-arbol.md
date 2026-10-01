# Feature: que el árbol de trabajo deje de llamarse `vscode`

## Pedido

> "la carpeta vscode es obligatoria tenerla así nombrada? y dentro las cosas de vscode? me gustaría
> reconvertir todo a picode"

## Respuesta, con pruebas

**No es obligatoria.** Comprobado dentro del propio VS Code descargado:

- **La build encuentra su raíz por su propia ubicación**, no por el nombre:
  `build/gulpfile.vscode.win32.ts:21` → `const repoPath = path.dirname(import.meta.dirname)`.
- **La única herramienta que asume el nombre** es `build/npm/update-distro.ts:10`
  (`join(rootPath, 'vscode')`), que es un script de mantenimiento del *distro de Microsoft*. Este
  proyecto **no lo ejecuta nunca**.
- **Ningún parche depende del nombre.** Los tres sitios donde aparece `vscode/` en `patches/` son una
  URL de licencia (`github.com/microsoft/vscode/...`), un comentario, y la plantilla de la tienda de
  extensiones (`${serviceUrl}/vscode/{publisher}/{name}/latest`).
- Los nombres de los ficheros de salida **ya son nuestros**: los gulpfiles parcheados dicen
  `PiCode-Win32-${arch}` y `../PiCode-linux-` (parches 16 y 17).

## Decisión

La carpeta de fuentes pasa a llamarse **`picode-source/`**, no `picode/` a secas:

- Es de PiCode, que es lo pedido.
- Dice lo que contiene: la fuente de la que se construye.
- No se confunde con la carpeta del **producto ya construido** (`PiCode-Win32-x64/`), que es otra cosa
  y no debe parecer la misma.

**Los nombres de los scripts NO se tocan** (`dev/prepare_vscode.sh`, `dev/get_repo.sh`,
`patches/vscodium/`, `upstream/vscodium.json`). No son descuidos: son procedencia. Ese código viene de
VSCodium y de VS Code, está adaptado, y las cabeceras de cada script lo dicen. Renombrarlos borraría
de dónde viene cada pieza.

## Qué NO se puede renombrar, y por qué

Lo de dentro del árbol (`src/vs/**`, `resources/app/**`, las extensiones internas, `out/**`) **es**
VS Code: es su código, y ahí sus nombres son los correctos. Lo que se llama PiCode es lo que se ve
(la aplicación, su ejecutable, sus carpetas de datos, sus ajustes), y eso ya se llama así.

## Tareas

- [x] V1 **Renombrar el árbol** (`vscode/` → `picode-source/`), y actualizar todas las referencias.
      **Hicieron falta tres pasadas, no una**, y la tercera encontró el fallo que habría roto todo:
      1. Las referencias con `./` (`./vscode`) y las rutas (`vscode/product.json`).
      2. Los mensajes y comentarios, y una segunda pasada sobre los ficheros que se **cargan** desde
         otros (`dev/utils.sh`, `dev/update_patches.sh`), que no estaban en la primera lista.
      3. **`dev/get_repo.sh` escribía `mkdir -p vscode`** — el destino de la descarga, sin `./`, que
         ningún patrón con barra detecta. Ese solo bastaba para que la descarga fuera a un sitio y la
         build buscara en otro.

      **Lección**: una auditoría por patrones deja escapar las formas «desnudas» (sin `./`, sin
      barra). Lo que la cierra es recorrer **todo** lo que queda y juzgarlo uno a uno, no confiar en
      que el patrón era completo.
- [x] V2 **Comprobad**o: `bash -n` en los once scripts, rastreo final del repositorio entero, y
      `dev/build.sh -s -o` contra el árbol ya preparado (reutiliza y **para antes de `npm ci`**), que
      ejercita la resolución de la raíz y los nombres de salida sin pagar veinte minutos.
- [x] V3 **Auditado lo que se ve**. Resultado: **ya era todo PiCode**, 31 valores puestos y 11 cosas
      de Microsoft quitadas en `distribution/product-delta.json` — nombre corto y largo, ejecutable,
      carpeta de datos (`.picode`), protocolo de URL, nombre en el registro, en el menú de inicio y en
      la barra de tareas, carpeta del servidor y del túnel, icono de Linux, identificador de macOS,
      licencia y tienda de extensiones (Open VSX). La vía del ZIP renombra además `VSCodium.exe` →
      `PiCode.exe` y `bin\codium.cmd` → `bin\picode.cmd`.

## Lo que conserva su nombre, y por qué (no es un descuido)

| Nombre | Por qué sigue así |
| --- | --- |
| `dev/prepare_vscode.sh` | Prepara **el árbol de VS Code**: su nombre dice lo que hace. Viene de VSCodium y su cabecera lo declara. |
| `patches/vscodium/`, `upstream/vscodium.json` | Son **suyos**: los parches heredados y la revisión de la que se copiaron. Renombrarlos borraría de dónde viene cada pieza. |
| `.vscode/tasks.json` | Es la carpeta que **lee el editor** para sus tareas. Cambiarle el nombre las rompe. |
| Lo de dentro del árbol (`src/vs/**`, `resources/app/**`, `out/**`) | **Es** VS Code: su código, sus nombres. Lo que se llama PiCode es lo que se ve. |
| `vscode-<plataforma>-…-min-packing` | El **nombre de la tarea de compilación** de VS Code. Se invoca tal cual. |
| `engines.vscode` en los manifiestos | Una clave del **protocolo** de extensiones, no una marca. |

## Registro

- 2026-09-25 · pedido, comprobado con pruebas dentro del propio VS Code y hecho.
