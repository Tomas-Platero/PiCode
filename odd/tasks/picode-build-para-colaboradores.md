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
