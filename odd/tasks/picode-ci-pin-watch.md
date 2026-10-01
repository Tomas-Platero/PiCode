# Feature: vigilancia automática del pin de VS Code en CI

## Goal

Que el pin de VS Code (`upstream/stable.json`) deje de ser algo que se comprueba "cuando
alguien compila" y pase a tener tres guardias automáticas en GitHub Actions, sin subir nunca
el código fuente de Microsoft al repositorio:

1. **Check rápido en cada push.** `./dev/build.sh -o` (fases 1-5, sin compilar). Si un patch
   de `patches/` deja de aplicar contra el commit pineado, el push se ve en rojo y dice qué
   patch se rompió.
2. **Vigilancia semanal del pin.** Mira la última versión estable de VS Code y los avisos de
   seguridad publicados desde el pin; abre una PR que mueve el pin, etiquetada `security`
   cuando hay aviso, y lanza el check rápido contra esa PR.
3. **Build completo periódico.** Compilación real (no solo preparación) cada noche y cuando se
   mueve el pin, para pillar errores de compilación que las fases 1-5 no ven.

## Decisions

1. **`upstream/vscodium.json` NO se mueve automáticamente.** Ese pin es un commit de
   **VSCodium** (otro repositorio), no de VS Code, y `patches/vscodium/**` es *verbatim* de esa
   revisión: moverlo sin re-vendorizar los patches y `dev/vscodium-product.json` sería mentir
   sobre su procedencia. La PR del vigilante mueve `upstream/stable.json` y lleva en el cuerpo
   el recordatorio de revisar la pareja de pines (enlace a `docs/howto-build.md` → «Los dos
   pins»). Automatizar el re-vendorizado es un trabajo aparte.
2. **El check rápido corre en Linux y en Windows (matriz).** Los patches de sistema son
   distintos (`patches/vscodium/linux/**` frente a `patches/vscodium/windows/**`), así que un
   solo runner dejaría la mitad del juego sin verificar. El job no compila, así que la matriz
   es barata.
3. **El build completo corre en Linux (`ubuntu-latest`).** Es el runner más rápido y barato, y
   los errores de compilación de TypeScript no dependen del sistema. El juego de patches de
   Windows ya queda cubierto por el check rápido en cada push. Añadir `windows-latest` a la
   matriz da paridad con el producto a ~2× de coste; queda a un cambio de una línea (registrado
   en `docs/CI.md`). Efecto secundario útil: es la primera build real de Linux que el proyecto
   tiene pendiente (`odd/tasks/picode-build-linux.md`).
4. **La PR del vigilante deja un *commit status* propio.** Un PR abierto con `GITHUB_TOKEN` no
   dispara `pull_request`, así que el vigilante lanza `pin-check.yml` por `workflow_dispatch`
   (la excepción documentada de GitHub) y ese run escribe el estado
   `pin-check (phases 1-5)` sobre el commit de la PR, nombrando el patch roto.
5. **La caché de `node_modules` se confía solo con prueba.** VS Code registra lo que instaló en
   `node_modules/.postinstall-state` y compara el hash de `package.json`/`package-lock.json`.
   `PICODE_FAST_INSTALL=yes` (solo CI) reutiliza la caché **si y solo si** ese estado está
   vigente; en cualquier otro caso se ejecuta `npm ci` como siempre. Una caché parcial o vieja
   no se puede colar.
6. **Sin compartir la carpeta `.pi/` externa ni árboles de fuente.** Las cachés son
   `picode-source/.git`, `picode-source/node_modules`, el caché de npm y el de `node-gyp`,
   todos dentro de la ejecución del runner.

## Tasks

- [x] T1 Job 1: `dev/ci/pin-check.sh` + `.github/workflows/pin-check.yml` (matriz linux+windows),
      caché de `picode-source/.git` por commit pineado.
- [x] T2 Job 2: `.github/workflows/pin-watch.yml` (lunes 06:17 UTC): API de actualización de VS
      Code, advisories de `microsoft/vscode`, PR con etiqueta `security`, dispatch del check.
- [x] T3 Job 3: `.github/workflows/full-build.yml` (diario 03:41 UTC + push que mueve el pin) con
      `PICODE_FAST_INSTALL=yes` en `dev/build.sh` y cachés de dependencias.
- [x] T4 `docs/CI.md`: política de cuándo mover el pin, mapa de cachés y la opción futura del
      `git archive` como adjunto de release.

## Evidence

- `bash -n dev/build.sh` y `bash -n dev/ci/pin-check.sh`: OK.
- El filtro de estado de instalación (`node build/npm/installStateHash.ts | jq -e …`)
  devuelve `0` contra el `node_modules` real de esta máquina (la caché se reutiliza cuando
  corresponde).
- Los tres workflows pasan el parseo de YAML.
- Consultas de la API probadas a mano: `update.code.visualstudio.com` devuelve
  `1.139.1`/`04c0d99f…` y `security-advisories` de `microsoft/vscode` devuelve 11 avisos
  publicados después del pin `1.135.0` (el 2026-09-08), así que la clasificación
  seguridad/no-seguridad tiene material real con el pin actual.
- Pendiente por no pedido: no se ha creado rama ni commit. Los cambios viven en el árbol de
  trabajo (`dev/ci/pin-check.sh`, los tres `.github/workflows/*.yml`, `docs/CI.md`, este
  fichero, `dev/build.sh`, `dev/README.md`, `docs/howto-build.md`).
