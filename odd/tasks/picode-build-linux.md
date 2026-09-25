# Feature: la build también para Linux

## Goal

Que el mismo repositorio construya PiCode **para Windows y para Linux**, con el modelo que ya tenía
(parches por sistema, una tarea de empaquetado por sistema), y que la carpeta que sale lleve el
nombre del producto — `PiCode-Win32-x64` y `PiCode-linux-x64` — no el del editor del que viene.

## Lo que estaba y lo que faltaba

El pipeline **ya derivaba el sistema** (`OSTYPE` → `windows`/`osx`/`linux`) y ya elegía con él los
parches de cada sistema. Lo que estaba fijado a Windows era lo de después:

| Qué | Antes | Ahora |
| --- | --- | --- |
| La tarea que empaqueta | `vscode-win32-…` a pelo | `vscode-${PACK_PLATFORM}-…`, con la tabla por sistema |
| Las políticas del producto | el generador con `win32` a pelo, y el copiado de los DTO | el generador con el sistema que se empaqueta; los DTO sólo en Windows (son de sus herramientas) |
| La carpeta del paquete | `VSCode-win32-<arch>` | `PiCode-Win32-<arch>` (parche 16) y `PiCode-linux-<arch>` (parche 17) |
| El icono de la ventana | sólo el `.ico` de Windows | en Linux, el PNG que sale del **mismo `.ico`** (ya lleva PNGs dentro), sin necesitar ninguna librería de imagen |
| Los logos del branding | vivían en la carpeta del panel retirado, **borrada**: el sellado avisaba y los dejaba sin poner | `distribution/picode-icon.svg` y `distribution/picode.svg`, recuperados del historial y con casa propia |
| macOS | — | no está puesto: hace falta el mismo cambio de una línea y un caso más. Falla con un mensaje que lo dice |

Y lo que **no** hizo falta tocar, porque ya era igual en cualquier sistema: el conector, los
formularios, la copia reescrita a PiCode, el perfil, y el pi de dentro (npm; y su poda de binarios
ya respeta la plataforma que se construye).

## Verificación

Ejecutada en esta máquina (Windows), que es hasta donde se puede llegar aquí:

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El PNG sale del `.ico` | `node dev/ico-to-png.mjs distribution/picode.ico` | 256×256, de las 7 tramas PNG que lleva dentro, y con cabecera PNG válida |
| Los parches 16 y 17 **aplican sobre el fichero sin mi cambio** | una copia del fichero en un repositorio temporal, sin el cambio, y `git apply` | los dos OK, y las tres sustituciones de Linux donde tienen que estar |
| El pipeline sigue siendo válido | `bash -n` de los dos scripts | OK |

**Y lo que no se puede verificar aquí**: la build de Linux de verdad. Necesita un Linux (una máquina
o WSL) porque los módulos nativos se compilan para la máquina donde compilas. Esa es la primera
prueba que queda pendiente.

Un aviso que salió de esto y conviene no olvidar: el chequeo de «el parche se puede aplicar al
revés» **no** demuestra que el parche aplique sobre la base — un parche que mezcla cambios propios
con los de un parche heredado pasa ese chequeo y falla en una build desde cero. La prueba que sí lo
demuestra es aplicarlo sobre una copia del fichero *sin* el cambio.

## Registro

- 2026-09-25 · pedido por el dueño («¿se podría compilar para linux también?» y, después, «añade la
  build de linux también»).
