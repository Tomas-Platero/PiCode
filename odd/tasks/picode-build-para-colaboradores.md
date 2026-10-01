# Feature: la build, fácil para cualquiera (y visible)

## Goal

Que construir PiCode **no exija una terminal ni saberse los pasos**, y que se pueda **ver cómo va**:

> «Creame un pequeño programita básico, que en una ventanita puedo lanzar la build y ver el progreso
> también si hay lanzada una build. No quiero verlo en otro lado que no sea ese pequeño programa.
> Así damos a los demás colaboradores la opción de buildear fácil, también que te diga si faltan
> dependencias y tal.»
>
> «Quiero que te diga las dependencias necesarias y si falta alguna te de opción a descargarlas…
> quiero una interfaz fácil para el usuario y funcional que vaya ayudando con la build del programa.»

## Por qué existe

Dos cosas que costaron horas de esta sesión, y que un colaborador habría sufrido igual:

1. **La build se quedó colgada siete horas sin decir nada.** Sus fases largas —dependencias, empaquetado—
   no imprimen durante minutos, así que un registro callado y una build muerta se ven igual.
2. **Una dependencia que falta revienta dentro de un registro ilegible**, varios minutos después de
   empezar (pasó: el compilador del árbol faltaba a mitad de una instalación). Y quien llega nuevo no
   sabe siquiera qué hace falta.

## La ventana

`dev/build-window.cmd` (doble clic) abre `dev/build-window.ps1`: PowerShell y WPF a propósito, porque
está en cualquier Windows y no hay que instalarle nada — un repositorio no es sitio para meterle una
cadena de herramientas de GUI.

- **Los requisitos, uno por fila**: node (comparado con la versión que fija `.nvmrc`, no solo
  mencionada), git, bash, jq, python3, winget, el árbol de fuentes, las dependencias, el editor y el
  disco libre. Cada fila dice si está y, si falta, **trae su botón**: `Install` (con `winget`, en su
  propia terminal para que se vean sus preguntas y su progreso) y `Page` (la web del fabricante,
  cuando no hay gestor de paquetes). Las filas de árbol/dependencias/editor traen el **paso** que lo
  arregla.
- **La build en tres pasos**: *Source tree* (fases 1-5), *Dependencies* (`npm ci`, la fase más
  larga, sola) y *Build*. Así un fallo en el medio no obliga a repetirlo todo.
- **La barra, con la fase y el porcentaje**, el final del registro dentro de la ventana, y un
  **Stop** para cuando se cuelga (que pasó).
- **Si ya hay una build en marcha**: lo dice el cerrojo de `dev/build-run.sh`, y los botones se
  bloquean, porque dos builds en un mismo árbol se pelean por `node_modules` y por la carpeta donde
  empaquetan.
- Los requisitos se **vuelven a leer** cada pocos segundos: instalar algo en la terminal hace que su
  fila se ponga verde sola.

## Las piezas, y por qué están separadas

| Pieza | Qué hace |
| --- | --- |
| `dev/build-run.sh` | Lanza la build y deja **cerrojo, registro y código de salida**. Rechaza una segunda build si el cerrojo está vivo (y limpia el cerrojo de una build muerta). Guarda el perfil del dueño antes y lo devuelve después, porque el empaquetado borra la carpeta donde vive |
| `dev/build-progress.mjs` | Lee lo que la build **ha impreso y ha escrito** y dice la fase, el porcentaje y lo que queda. En texto para una terminal, `--json` para la ventana |
| `dev/restore-profile.mjs` | Devuelve el perfil fichero a fichero (el editor suele estar abierto y sujeta sus cachés) y quita los ajustes del pi de dos instancias, que ya no existen |
| `dev/build-live.sh` | La build con la barra, para una terminal |
| `dev/build-window.ps1` + `.cmd` | La ventana |

El porcentaje es **honesto sobre ser una estimación**: las fases con marca propia saltan, y los
minutos dentro de una fase larga son una rampa sobre lo que esa fase tarda aquí. Dos fases se leen de
verdad: las dependencias (por lo que llena el árbol) y el empaquetado (por lo que escribe en la
carpeta del editor).

## Verificación

Ejecutada, sin abrir la ventana:

| Qué | Cómo | Resultado |
| --- | --- | --- |
| El estado de la máquina | `powershell -File dev/build-window.ps1 -Check` | Las seis comprobaciones, con la razón de cada una que falle |
| La ventana se construye | `-SelfTest` | Construye la ventana y comprueba sus catorce controles, además de lo que se enseña |
| Ofrece instalar lo que falta | `-SelfTest` con `jq` **quitado del PATH** | Una linea de veredicto y otra con el `jq` que falta, con su botón, y **el botón de construir apagado** |
| Y no ofrece nada cuando no falta nada | `-SelfTest` normal | Una sola línea, cero botones de instalación, cero problemas |
| Lo que se enseña es lo que toca | `-SelfTest`, que **simula cuatro tics** antes de mirar | Cierra los detalles cuando no ha fallado nada y los abre cuando sí, porque una sola mirada al primer fotograma no ve lo que estropea el reloj |
| Las dos paletas se leen | `-SelfTest` | Calcula el contraste de la paleta clara y de la oscura, y dice cuál ha elegido |
| La barra avanza de verdad | `node dev/build-progress.mjs --once` contra una build en marcha | Fase y porcentaje correctos (corregidos dos fallos: la marca de fin de compilación y los **códigos de color**, que escondían las palabras que busca) |

Un aviso: el analizador de PowerShell de la herramienta de revisión marca tres llaves sin cerrar en
la zona del XAML. Es un falso positivo — las llaves están dentro de un *here-string* y el parser
oficial de PowerShell dice `PARSE OK` sobre el fichero, que además se ejecuta entero.

## Registro

- 2026-09-25 · pedido y hecho en la misma sesión, después de que una build se colgara siete horas sin
  decirlo.
- 2026-09-25 · **la ventana se rehace porque era técnica de más** («la veo muy técnica, quiero algo más
  funcional»). Lo que estaba mal y lo que se hizo:
  - **Los tres pasos salían tres veces** (la fila «Steps», un botón en cada fila de requisitos y los de
    la derecha): se quedan **en un solo botón**, porque la build, sin banderas, ya descarga lo que
    falta, prepara, instala, compila y empaqueta, y salta lo que ya está hecho. Un botón que hace lo
    correcto vale más que tres que obligan a elegir.
  - **Se enseñaban versiones y nombres internos** (`git version 2.55.0.windows.3`, «not installed (or
    half done)», `winget install …`). Ahora **solo aparece lo que se desvía**, en una frase que se
    puede accionar ("Python 3 is missing") con el botón que lo resuelve; los que están bien no ocupan una
    línea. Las versiones y el porqué de cada comprobación viven en **Details**.
  - **El registro vacío ocupaba media ventana** para decir que todo iba bien: ahora está detrás de un
    botón que dice qué hace ("Details" / "Hide details") y **se abre solo cuando una build ha
    fallado**, que es cuando su contenido vale algo.
  - **El botón de construir estaba siempre disponible**, aunque faltara Python o hubiera un editor
    abierto: ahora **se apaga cuando algo falta** y la razón está en la línea de encima. El aviso de
    "Close PiCode" dejó de ser una ventana emergente: es una fila más, con su motivo.
  - **La ventana se ciñe al contenido** (560 × 276 con los detalles cerrados) y **sigue el tema de
    Windows**: oscura en un escritorio oscuro, clara en uno claro, con `PICODE_BUILD_WINDOW_THEME`
    para forzarla. Los botones se quedan con el dibujo propio del sistema, que es el que se ve bien en
    los dos temas.
  - Verificado **mirando la ventana de verdad**, no solo construyéndola: se abrió y se fotografiaron
    los cuatro estados (normal, fallo, tema claro, tema oscuro).

## Defecto grave: la build sin banderas borra el árbol preparado (2026-09-25)

**Lo que pasó**: el dueño lanzó `dev/build.sh` sin banderas y la salida dijo `removing ./picode-source`:
se le borró el árbol preparado —con las dependencias ya instaladas— y tuvo que volver a descargarlo,
parchearlo e instalarlo todo.

**Por qué**: es la lógica heredada de VSCodium, que sigue en `dev/build.sh`:

```bash
for stale in ./picode-source ./PiCode-* ./VSCode-* ./vscode-*; do
  if [[ -e "${stale}" ]]; then echo "removing ${stale}"; rm -rf -- "${stale}"; fi
done
```

Sin `-s`, el árbol viejo se considera material de descarte: la build se hace **limpia**. La línea
original (con `./vscode`) hacía lo mismo, así que el comportamiento **no es nuevo**.

**La culpa del estropicio es de la documentación, y es mía.** Dos cosas juntas:

1. Quité `-s` del botón de la ventana porque **`-s` fallaba** cuando no había árbol que reutilizar
   (`error: ./vscode does not exist, so it cannot be reused`). El botón pasó a lanzar la build **sin
   banderas**.
2. Y luego **describí la build sin banderas como la que reutiliza** lo que ya está: así está en el
   `README.md` («reuses a prepared tree on its own»), en el texto de la ventana («keeps whatever was
   already done») y en el mensaje del commit `d2fc374`.

Las dos frases son falsas: reutilizar es lo que hace `-s`, y sin banderas borra. El dueño hizo
exactamente lo que la documentación le decía que hiciera.

**Arreglo decidido** (pendiente de aplicar):

- Sin banderas, si hay árbol, **se reutiliza** (se prepara si está limpio, se salta si ya está
  preparado). Es lo que hoy hace `-s`, y `-s` queda como alias para no romper lo ya escrito.
- **Borrar el árbol pasa a ser explícito**: una bandera nueva (`--fresh`) hace la descarga limpia, y
  cuando borra **lo dice y avisa** de lo que se pierde (el árbol y sus dependencias).
- `-o` y `-DepsOnly` no cambian.

**No se aplica mientras la build del dueño está corriendo**: bash lee el script según avanza, y editar
un guion que se está ejecutando puede corromper la ejecución. Hay que esperar a que termine.

**Lección**: una bandera que significa «reutiliza el árbol» **no puede ser lo único que decide si el
árbol se borra o no**. Quitar una bandera que fallaba movió el fallo de sitio en vez de arreglarlo: el
botón pasó de no funcionar en un árbol recién bajado a destruir el árbol ya preparado.

## Registro

- 2026-09-25 · pedido y hecho en la misma sesión, después de que una build se colgara siete horas sin
  decirlo.
- 2026-09-25 · la interfaz se rehace porque era técnica de más.
- 2026-09-25 · **defecto grave**: la build sin banderas borra el árbol preparado, y la documentación
  decía lo contrario. Arreglo decidido, pendiente de aplicar.

## Defecto: el empaquetado escribía en una carpeta y todo lo demás en otra (2026-09-25)

**Lo que pasó**: la build del dueño compiló, empaquetó (55 s) e instaló el motor de pi, y se paró al
final: `error: a required file is missing: /d/repositorios/PiCode/PiCode-Win32-x64/resources/app/product.json`.
El paquete estaba entero, pero en **`VSCode-win32-x64/`**, con `PiCode.exe` dentro.

**La raíz**: el nombre de la carpeta de salida lo pone el gulpfile **genérico**,
`build/gulpfile.vscode.ts:647`:

```js
const destinationFolderName = `VSCode${dashed(platform)}${dashed(arch)}`;
```

Los parches 16 y 17 renombraron la salida en los gulpfiles **de Windows y de Linux**, que tienen su
propio `buildPath`, pero no este, que es el compartido. De ahí que el ejecutable se llamara PiCode (eso
sale de `product.json`) y la carpeta no.

**Consecuencia, y llevaba ahí desde el principio**: ninguna build había llegado a sellar un editor.
El aviso de la ventana —«editor built: not built yet»— era **cierto** y señalaba esto mismo sin que
nadie leyera por qué.

**Arreglo**: `patches/picode/18-pack-output-name.patch`, con una línea, verificado **aplicándolo sobre
el fichero limpio del repositorio de VS Code** (y comprobando además que no pisa a los parches 16 y 17,
que tocan otros ficheros). En el árbol que ya estaba preparado se aplicó a mano, que es lo que permite
que su siguiente build —con reutilización— empaquete en el sitio correcto sin volver a descargar nada.

**Rescate**: como el paquete estaba entero y solo estaba mal de sitio, se fundió `VSCode-win32-x64/`
dentro de `PiCode-Win32-x64/`, conservando lo que la fase 8 ya había puesto (el motor de pi y su perfil
de 442 ficheros) y se volvió a lanzar **solo el sellado**. Terminó en **0**: quita 306 MB de mapas,
deja los idiomas en 2 MB y deja `PiCode.exe` de 221 MB con el producto diciendo PiCode. Veinte minutos
de compilación no se repitieron.

## Defecto: la ventana no veía las builds (2026-09-25)

El cerrojo guarda el número de proceso de **bash**, y bash reporta dos números distintos: 2473 para sí
mismo y 14172 para Windows. La ventana preguntaba a **Windows** si ese proceso vivía, le decían que no,
y concluía «no pasa nada» **con el registro de la build creciendo debajo**. Ahora la comprobación se la
hace a **bash** (`kill -0`, la misma que usa el lanzador), y parar la build es `kill` desde bash, con lo
que el propio lanzador recoge el cerrojo. Se probó también el truco de `/proc/<pid>/winpid`: **aquí no
sirve**, Windows tampoco reconoce ese número.

## La bandera que borraba el árbol

`dev/build.sh` gana `-f`: sin banderas, si hay árbol, **se reutiliza** y lo dice; borrarlo y descargarlo
otra vez hay que pedirlo. Verificado: sin banderas ahora imprime
`note: ./picode-source is already here and is being reused (-f fetches it again)` donde antes imprimía
`removing ./picode-source`.
