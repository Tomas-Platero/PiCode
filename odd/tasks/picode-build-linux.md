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

## Estado ahora mismo (2026-09-25, tarde)

En esta máquina: las dos piezas de Windows que WSL necesita (`Microsoft-Windows-Subsystem-Linux` y
`VirtualMachinePlatform`) están **activadas** y el **WSL de la tienda está instalado**. Falta
**reiniciar** (lo piden las piezas de Windows, no es opcional).

**Lo que sigue, después del reinicio** (todo desde una sesión con permisos de administrador, que es
como se activaron):

1. `wsl --install -d Ubuntu` (o `wsl --install` para la que venga por defecto) y crear el usuario.
2. Dentro de Linux: `sudo apt update && sudo apt install -y jq python3 git build-essential` + node 24
   (el `.nvmrc` dice la versión; en Ubuntu, con nvm o con el paquete de NodeSource).
3. **El repositorio, dentro del disco de Linux** (`~/PiCode`), no sobre `/mnt/d/…`: compilar sobre el
   disco de Windows con miles de ficheros pequeños es varias veces más lento. Y el `./vscode` (el
   clon de VS Code, 1 GB) también va ahí.
4. `bash dev/build.sh` (o `dev/build-live.sh` para ver la barra). Lo esperado: la carpeta
   `PiCode-linux-x64`, con el icono de PiCode, la copia reescrita y los binarios del pi podados a
   Linux.
5. Lo que falle, se arregla: es la primera vez que este camino se ejecuta de verdad.

**Y lo que sigue pendiente y no depende de nada de esto**: la build de **Windows**, que el dueño
quería lanzar él (`dev/build-window.cmd` o `bash dev/build-live.sh`), y que ahora sale como
`PiCode-Win32-x64`.
