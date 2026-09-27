# CI y releases

## Estado actual: sin CI (decisión del dueño, 2026-09-27)

Durante el desarrollo activo, GitHub Actions consumía minutos y dinero en cada
intento. Los workflows se **eliminaron** y las releases se generan **a mano**.

- Los workflows vivieron en `.github/workflows/` — recuperables del historial
  de git si algún día se quiere volver (buscar los commits `ci:` de
  septiembre de 2026; el último fue `c25f963`, anterior a su eliminación).
- Los scripts que usaban: `dev/build.sh` sigue en el repositorio y funciona en local;
  `dev/ci/pin-check.sh` fue **borrado el 2026-09-27** junto con el aparato de parches al que
  vigilaba (recuperable del historial si los controles automáticos vuelven algún día).

## Cómo generar una release a mano

1. **Compilar desde fuente** (ver [`howto-build.md`](howto-build.md)):
   - Windows: `dev/build.sh` → árbol empaquetado en `PiCode-Win32-x64/`.
   - Linux: lo mismo desde WSL o Linux → `PiCode-linux-x64/`.
   - Atajos: `-o` solo comprueba la fuente (segundos, sin instalar ni compilar); `-i` fuerza
     la instalación de las dependencias aunque el estado registrado siga cuadrando.
2. **Empaquetar** lo que en CI hacían las tareas de instalador:
   - Portable Windows: comprimir `PiCode-Win32-x64/` en zip.
   - Portable Linux: `tar -czf PiCode-<versión>-linux-x64.tar.gz PiCode-linux-x64/`.
   - Instalador Windows: dentro de `picode-source`,
     `npm run gulp vscode-win32-x64-inno-updater` y después
     `npm run gulp vscode-win32-x64-system-setup` → el `setup.exe` queda en
     `picode-source/.build/win32-x64/system-setup/`.
   - Instaladores Linux: `npm run gulp vscode-linux-x64-prepare-deb`,
     `npm run gulp vscode-linux-x64-build-deb` y el par equivalente de rpm
     (`prepare-rpm` / `build-rpm`) — **en secuencia, nunca en paralelo** (cada
     build lee el directorio que su prepare crea). El `.deb` queda en
     `.build/linux/deb/amd64/deb/` y el `.rpm` en `.build/linux/rpm/x86_64/`.
3. **Publicar**: crear la release en GitHub y subir los ficheros a mano
   (web, o `gh release create v<versión> <ficheros>`).
4. **Checksums** (recomendado): `sha256sum PiCode-*` y subir el resultado
   como `SHA256SUMS.txt`.

## Trampas conocidas del build (por si vuelven)

- **RAM del runner/máquina**: el empaquetado pide más de 6 GB de heap. En una
  máquina con 8 GB, `NODE_OPTIONS="--max-old-space-size=5632"`; con 16 GB,
  12288 va sobrado. Ubuntu 24.04 además trae `systemd-oomd`, que mata el
  cgroup entero por presión de memoria sin escribir "Killed" — desactivarlo
  antes de compilar (`sudo systemctl stop systemd-oomd`).
- **Descargas de assets de GitHub** durante el build (`js-debug` etc.):
  anónimas se agotan (403 rate limit); con `GITHUB_TOKEN` en el entorno,
  `fetch.ts` se autentica solo.
- **Debian renombra el arch**: los `.deb` se generan bajo `amd64`, no `x64`;
  los `.rpm` bajo `x86_64`.
- **Instaladores en secuencia**: `prepare` y `build` de cada formato son dos
  invocaciones — en paralelo, `build` corre antes de que `prepare` cree el
  directorio (`spawn /bin/sh ENOENT`).
- **npm 11 bloquea install scripts** sin aprobación explícita por
  nombre@versión completos: la etapa `metadata` de `prepare_vscode.sh` escribe
  las aprobaciones de los paquetes nativos de VSCodium.
- **Windows busca Visual Studio en rutas fijas**: si el árbol está en otra
  ruta, `vs2022_install=<ruta>` es el override que honra.

## El pin, sin vigilancia automática

El pin de VS Code (`upstream/stable.json`) ahora se mueve a mano (los pasos
en [`howto-build.md`](howto-build.md)). El workflow que lo vigilaba
(`pin-watch.yml`) está eliminado; su lógica era: consultar la última estable,
mirar los avisos de seguridad desde el pin actual, y abrir una PR con el
pin nuevo. Si se quiere recuperar, está en el historial de git.
