# Feature: el menú Help y los diálogos de actualización, sin VS Code

## Goal

> «vale volvamos al trabajo, quiero que revises la pestaña de "help" […] hay cosas de vscode, quita
> lo que no sea necesario»
>
> «Cuando falla una actualización tambien salen cosas de vscode puedes cambiarlo?»

Dos encargos en la misma sesión, los dos sobre superficies que el usuario **ve**:

1. **El menú Help** tenía nueve entradas heredadas del editor en el que se basa PiCode. El encargo
   es dejar solo lo que habla del producto.
2. **El aviso de actualización fallida** —la caja que el instalador enseña cuando no pudo aplicar una
   actualización— seguía titulándose «Visual Studio Code» y nombrando el registro como
   `vscode-inno-updater-<pid>.log`.

## Regla de la casa

El menú enseña **el producto**, no la maquinaria heredada. Un comando que sirve para depurar el
editor no tiene por qué desaparecer: se le quita del menú y se queda en la paleta. Un comando que
habla de algo que este producto **no tiene** (un `@vscode` en el chat) se retira entero. Y un dato
que no se puede ofrecer dos veces (dos entradas al mismo formulario de issues) se deja una.

## El menú Help

| Se queda | Por qué |
| --- | --- |
| **Welcome** | La página de bienvenida de PiCode, con su asistente |
| **Show All Commands** | La paleta; es una acción de todos los días |
| **Documentation** | `documentationUrl` → el README de PiCode |
| **Show Release Notes** | `releaseNotesUrl` → las releases de PiCode |
| **Report Issue** | `reportIssueUrl` → los issues de PiCode |
| **View License** | `licenseUrl` → la licencia de PiCode |
| **Check for Updates…** | El updater propio (la fila la construye el menú, no un `product.*Url`) |
| **About** | La ventana del producto |

| Sale del menú | Qué es | Dónde vivía |
| --- | --- | --- |
| **Editor Playground** | El tutorial interactivo del editor, de VS Code | `MenubarHelpMenu` en `welcomeWalkthrough/browser/walkThrough.contribution.ts` |
| **Open Walkthrough…** | El selector de walkthroughs; la página de bienvenida ya lleva ahí | `welcome.showAllWalkthroughs`, en `welcomeGettingStarted/browser/gettingStarted.contribution.ts` |
| **Get Started with Accessibility Features** | Onboarding heredado | `GetStartedWithAccessibilityFeatures`, en `browser/actions/helpActions.ts` |
| **Ask @vscode** | Abría el chat con `@vscode`, un participante que este producto no tiene | `AskVSCodeCopilot`, en `browser/actions/helpActions.ts` — **se retira la clase entera** |
| **Search Feature Requests** | Apuntaba al mismo `issues/new` que **Report Issue** | `OpenRequestFeatureUrlAction`, encendida por `requestFeatureUrl` |
| **Toggle Developer Tools** | Herramienta interna del editor | `ToggleDevToolsAction`, en `electron-browser/actions/developerActions.ts` |
| **Open Process Explorer** | Herramienta interna del editor | `OpenProcessExplorer`, en `processExplorer/browser/processExplorer.contribution.ts` |

Los cinco que salen del menú conservando su comando siguen en la paleta (`f1: true`): nada se
pierde, solo deja de ofrecerse. **Search Feature Requests** no es un cambio de fuente sino de
configuración: `requestFeatureUrl` pasa de `set` a `unset` en `distribution/product-delta.json` (y se
quita de `product.json`), con lo que la acción ni se registra. La fase 1 del build sigue cuadrando
(`apply-product-delta.mjs --check`, todo `already current` / `already absent`).

## El aviso de actualización

`inno_updater.exe` (binario de Microsoft, versionado en `picode-source/build/win32/`) lleva sus
cadenas compiladas, y estaban **sin marcar** en dos formas distintas:

- el **recurso de diálogo** de la ventana de progreso, en UTF-16 (ya se marcó el 2026-10-04);
- las **cadenas propias del programa**, en ANSI (aquí está el fallo que se veía). Es un binario
  Rust de 32 bits con direccionamiento absoluto: la caja de error
  (`Failed to install Visual Studio Code update. …`), el título con el que se muestra
  (`Visual Studio Code`, 18 bytes), `Visual Studio Code - Updater`, `Visual Studio Code is
  updating…`, `\n\nPlease verify there are no Visual Studio Code processes still executing.` y el
  prefijo `vscode-inno-updater-` del nombre del registro.

`dev/patch-inno-updater.mjs` marca ahora las dos, y **el literal entero**, no solo la marca: en la
caja de error y en la línea de `processes still executing` el nombre va en medio de la frase, y
recortar solo esas 12 letras dejaría el hueco en medio. La longitud no cambia (una plantilla de
diálogo se lee por offsets y un `&str` de Rust lleva su longitud en el código), así que la marca va
delante y los 12 bytes que sobran se rellenan con espacios al final del literal, donde no se ven: al
final de una línea de progreso o tras un título. En la caja de error el relleno va **al final de la
última frase y no del literal**, porque lo que sigue lo pone el propio updater en marcha: le pega la
ruta del registro, y unos espacios sueltos ahí sangrarían esa línea. Comprobado: 6 sustituciones la
primera pasada, `already branded` la segunda, el mensaje sigue midiendo 235 bytes y termina en
`information:` + 12 espacios + salto doble, y `Visual Studio Code` da 0 aciertos en UTF-16 y en ANSI.

Además, **nueve lenguas** del instalador (`build/win32/i18n/messages.{de,fr,hu,ja,ko,ru,tr,zh-cn,zh-tw}.isl`)
traducían `UpdatingVisualStudioCode` con el nombre viejo; en, es, it y pt-br ya estaban. Todas dicen
PiCode.

La guarda de la fase 1 (`dev/build.sh`) ya no mira solo el UTF-16: rechaza el binario si aparece
`Visual Studio Code` **o** `vscode-inno-updater-` en cualquiera de las dos formas.

### Los datos del fichero, que no estaban puestos (encontrado al construir)

La primera build de esta sesión enseñó que el recurso de **versión** del updater seguía siendo el de
Microsoft. Botón derecho → Propiedades: `FileDescription` «VSCode Inno Updater», `CompanyName`
«Microsoft Corporation» y `ProductVersion` `acda8ead` — el hash de commit de VS Code. (`ProductName`
sí decía «PiCode», y no por el sellado: la sustitución genérica de `Visual Studio Code` del script
había caído también ahí, que es de 18 letras igual que la marca.)

**Por qué**: el sellado del pack sí lo pedía (`patchWin32DependenciesTask` hace glob de
`**/tools/inno_updater.exe`, añadido el 2026-10-04), pero el fichero **no está en el pack cuando ese
sellado corre**. Lo copia `copyInnoUpdater`, una tarea de la **fase del instalador**, y lo hace
después: medido en esta build, el empaquetado terminó a las 17:45:41 y la copia corrió a las
17:46:32. El glob no encontraba nada y nadie decía nada.

**El arreglo** (`build/gulpfile.vscode.win32.ts`): `updateIcon`, la función que ya corría sobre ese
fichero justo después de copiarlo, pasa a ser `brandInnoUpdater` y marca **icono y recurso de
versión** con los mismos campos y los mismos dos ficheros de origen que usa el sellado del pack. El
glob de `patchWin32DependenciesTask` se queda, con su comentario corregido: es red de seguridad para
una build que ponga el updater antes de empaquetar, no el sello que hace el trabajo.

## Lo que se construyó (2026-10-09)

`PICODE_PACK_SUFFIX="-experimental" bash dev/build-run.sh` — **9 minutos, código 0**, en paralelo al
árbol (no toca la instalación del dueño): pack en `PiCode-Win32-x64-experimental` e instalador
`PiCode-win32-x64-0.2.1-experimental-setup.exe`. Lo que la build demostró:

- **La fase 3 (`picode-typecheck-min`) pasó en 28 s sin un solo `error TS`** sobre los cinco ficheros
tocados — con `noUnusedLocals` activo eso es la confirmación que el análisis estático no da.
- En el bundle compilado, las claves de localización de las dos entradas retiradas
  (`miPlayground`, `miOpenProcessExplorerer`) **no aparecen**, y `askVScode` tampoco: el menú
  quitado no está en el producto.
- `resources/app/product.json` del pack no tiene `requestFeatureUrl`, así que la acción de
  «Search Feature Requests» no puede registrarse.
- El `tools/inno_updater.exe` **del pack** no tiene ninguna cadena «Visual Studio Code» y sí las de
  PiCode — es decir, el parche sobrevive al paso de `rcedit` que le cambia el icono.

## Lo que no está medido

- **El menú Help no se ha visto con los ojos.** Está comprobado en el bundle (las claves y las
  cadenas, más el typecheck), pero que la pantalla se vea como se espera —sin grupo vacío ni
  separador suelto— lo tiene que decir una persona abriendo `PiCode-Win32-x64-experimental/PiCode.exe`.
- **El aviso de actualización fallida no se ha reproducido en vivo**: haría falta una actualización
  que falle. Lo comprobado es el binario (las cadenas que quedan y las que ya no), que es de donde
  salían.
- **La corrección del recurso de versión se estrenó en la segunda build** y se comprobó en el
  artefacto: `PICODE_PACK_SUFFIX="-experimental" PICODE_INSTALLER_SUFFIX="-experimental" bash
  dev/build-installer.sh ./PiCode-Win32-x64-experimental` (3m39s, código 0, solo la fase del
  instalador). El `tools/inno_updater.exe` **del pack** ya declara ProductName y FileDescription
  «PiCode - Agentic Code Editor», compañía «TomasPlatero», versión 1.141.1 y el copyright de PiCode,
  y en él no queda ninguna cadena de Microsoft. Las cadenas del parche **sobreviven** al paso de
  `rcedit` que reescribe el recurso (comprobado en el mismo fichero, no en el del árbol).
- **Los textos del instalador no se pueden verificar leyendo el `.exe`**: Inno Setup los comprime, y
  ni «Actualizando PiCode» aparece en crudo. Lo que sí está comprobado es que ISCC corrió **después**
  de editar los `.isl` y que los leyó (las advertencias de esta build son sobre mensajes que faltan
  en húngaro, no sobre el nuestro).
