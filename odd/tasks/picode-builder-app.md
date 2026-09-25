# Feature: el builder como aplicación (C# + WinUI 3, en `builder/`)

## Pedido

> "podríamos unificar builders de windows y linux y en vez de ps1 y cmd usar c# con winui 3 y crear una
> app para buildear en un root a parte de dev que sea 'builder' o algo así?"

Elegido por el dueño: **C# con WinUI 3**, con la carga de trabajo instalada si hace falta.

## Lo que ya estaba unificado, y lo que no

Comprobado antes de proponer nada:

- **El motor de build ya es uno solo**: doce scripts en `dev/`, todos en bash, y todos entienden Windows y
  Linux desde el mismo sitio (`OS_NAME`, `uname`). `dev/build.sh`, `dev/prepare_vscode.sh`,
  `dev/stage-distribution.sh` y `dev/pi-runtime.sh` son los mismos en los dos sistemas.
- **Lo único de Windows es la ventana**: `dev/build-window.ps1` (35 KB) y `dev/build-window.cmd`. El visor
  de terminal (`dev/build-live.sh`) y las tareas del editor también valen en Linux.

Así que no hay dos builders que unificar: hay **un pipeline** y **una ventana de Windows**.

## Decisión

La aplicación vive en **`builder/`** y es un **front-end fino**:

- No reimplementa nada del pipeline: llama a los mismos scripts y lee el mismo progreso
  (`dev/build-progress.mjs --json`, que ya publica los pasos, el paso en curso y los tiempos).
- **Windows** se compila nativamente (como hasta ahora) y **Linux a través de WSL** (`wsl.exe -d Ubuntu
  -- bash dev/build.sh`), que es la forma honesta de "unificar": una app de WinUI **solo funciona en
  Windows**, lo que puede hacer es *manejar* los dos.
- `dev/` se queda como está: sigue siendo el motor, ejecutable sin la app, desde terminal y desde
  integración continua. La ventana de PowerShell **no se borra** hasta que la app haga todo lo que hace.

## Prioridad: no instalar lo que no hace falta

El `config.yaml` que trae la skill de WinUI propone instalar **Visual Studio Community 2026** entero, y el
dueño ya tiene **2022** con el SDK de Windows y .NET 10. Antes de meter eso se prueba la vía sin
administrador: **escribir el proyecto a mano** (una plantilla solo escribe un `.csproj` con dos paquetes)
y comprobar si `dotnet build` lo construye. El App SDK viene como paquete de NuGet, y el compilador de
XAML también.

Si esa vía funciona, no se instala nada. Si no funciona, se añaden los componentes de WinUI a su Visual
Studio 2022 con el instalador de VS (una sola confirmación de administrador), **no un Visual Studio nuevo**.

## Tareas

- [x] B1 **Comprobado: la vía sin administrador vale, y no se instaló nada.** `builder/` tiene el
      proyecto escrito a mano (`.csproj`, manifiesto, `Application` y `Window`), sin empaquetar y
      autocontenido, y **`dotnet build` lo compiló en 13 segundos** con cero errores y cero avisos.
      No hizo falta la carga de trabajo, ni Visual Studio 2026, ni permisos de administrador: el App
      SDK llega como paquete de NuGet y el compilador de XAML viene dentro.

      Lo único que estorbó fueron dos propiedades mías: `WindowsAppSDKSelfContained` exige la
      arquitectura **declarada**, no listada — `RuntimeIdentifier` en singular junto a `Platforms`, no
      `RuntimeIdentifiers`.

      Y **se ejecutó**, porque compilar no es lo mismo que funcionar: el proceso siguió vivo, tiene una
      ventana titulada «PiCode Builder», y se fotografió con `PrintWindow` (que sí funciona con WinUI,
      así que la app se puede revisar sin leer la pantalla de nadie).
- [ ] B2 **La ventana**: los mismos tres botones (Build, Open, Dependencies), el cuadro de pasos con su
      barra, y el registro que se puede ocultar. Mismo comportamiento, misma verdad por delante.
- [ ] B3 **El puente**: un solo sitio que sepa lanzar la build y leer su progreso, con el sistema como
      parámetro (Windows nativo; Linux por WSL). PowerShell desaparece de esta parte.
- [ ] B4 **Comprobar de verdad**: construirla y **ejecutarla** (no basta con que compile), y ver que la
      ventana es real y muestra el estado real de la máquina.
- [ ] B5 **Los documentos**: `dev/README.md`, el `README.md` y el papel de colaboradores dicen cómo se
      construye hoy; hay que añadir la app y decir cuándo usar cada camino.

## Registro

- 2026-09-25 · pedido, comprobado qué está unificado y elegido WinUI 3 por el dueño.
