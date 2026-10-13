# El contexto del editor viaja con cada turno del chat (durable incluido)

> «vale hazlo» — dueño, 2026-10-11, tras preguntar si sería mejor que el chat lo gestionara pi
> y no durable.

## El problema, tal como se vio

Con ADR-018 el chat es **durable**, y durable corre en su propio proceso, en una carpeta. Su
turno solo llevaba `request.prompt` al daemon: ni el fichero abierto, ni la selección, ni los
problemas del panel, ni las referencias que el dueño adjunta al mensaje. El chat de antes (el
pi en proceso) **sí** enviaba ese bloque (`context.ts`), así que hacer durable el chat quitó en
silencio algo que el dueño ya tenía: preguntar «¿puedes ver el fichero que tengo abierto?» se
quedaba en un agente ciego a la pantalla, que trabaja en la misma carpeta pero no mira lo mismo.

La pregunta del dueño («¿no sería mejor que fuera pi el que gestione el chat?») no era sobre el
motor — pi responde en los dos casos: durable corre `@earendil-works/pi-durable`, la capa de
durabilidad del propio pi — sino sobre esa ceguera.

## Lo que se ha hecho

1. **El lector del editor se movió a un módulo propio** (`src/editor-context.ts`), el mismo para
   los dos harnesses: el turno durable (`durable-sessions-register.ts`) y el chat en proceso
   (`agent.ts`). Antes vivía privado dentro de `agent.ts`.
2. **El bloque creció** (`src/context.ts`): además de carpeta, fichero y selección, viajan los
   **problemas** del fichero abierto (solo error y warning, con su línea, tope de 10) y las
   **referencias del mensaje** (`request.references`). Un adjunto sin texto del editor viaja
   igualmente por su nombre: el agente sabe **qué** se adjuntó aunque no haya texto que leer.
3. **El turno durable envuelve el prompt** con el mismo `withContext` que ya usaba el chat en
   proceso: marco («eres pi, el agente del editor»), contexto, `---`, lo que escribió el dueño.
4. **El reproductor de la conversación devuelve sus palabras** (`durable-sessions.ts`): el daemon
   guarda el prompt enmarcado como entrada de usuario, así que la etiqueta de la sesión y el
   turno reproducido se recortan con `ownerTextOf`. Sin esto, cada fila y cada turno leería el
   marco; es la misma regla que `sessions-provider.ts` ya aplicaba a los transcritos de pi.
5. **El interruptor sigue siendo del dueño**: `picode.context.attach` (apagado = nada viaja).

## Por qué así

- **No se eligió entre pi y durable**: el motor es pi en ambos casos. Lo que faltaba era el
  puente, no un rediseño.
- **Un solo lector**: si el contexto se construye en un sitio, los dos harnesses no pueden
  divergir.
- **Se recorta en el escritor, no en el lector**: la selección (líneas y caracteres) y los
  problemas (cuántos y cuánto texto) se capan en `context.ts`, donde la decisión se puede
  ejecutar en un test. Un fichero entero en cada prompt es una factura, no contexto — pi puede
  leer el fichero por su cuenta cuando le haga falta.
- **`context.ts` no importa nada relativo** a propósito (los topes se mudaron desde
  `piConfig.ts`): así `node --test` lo ejecuta directamente y el bloque tiene pruebas.

## Ficheros

| Fichero | Qué |
| --- | --- |
| `src/context.ts` | Topes + tipos nuevos (`ContextDiagnostic`, `ContextAttachment`) + el bloque escribe problemas y adjuntos |
| `src/editor-context.ts` | Nuevo: lee el editor (fichero, selección, problemas) y serializa `request.references`; `contextBlockFor` movido aquí |
| `src/agent.ts` | Usa el módulo nuevo y pasa `request.references` |
| `src/durable-sessions-register.ts` | El turno durable construye contexto y envuelve el prompt |
| `src/durable-sessions.ts` | `ownerTextOf`: quita el marco de la etiqueta y del turno reproducido |
| `src/piConfig.ts` | Los topes se fueron a `context.ts` |
| `test/context.test.ts` | Nuevo: el bloque entero |
| `test/durable-sessions.test.ts` | El marco se recorta; un mensaje sin marco se deja entero |

## Verificado

- `tsc -p tsconfig.json --noEmit` → 0 errores; `tsc -p tsconfig.test.json` → 0.
- Suite del conector **completa** (`node --experimental-strip-types --test test/*.test.ts`) →
  todos los ficheros en verde.
- `test/context.test.ts` → 8/8; `test/durable-sessions.test.ts` → 13/13.
- Compilación del conector y build del pack (fase 2/5 en adelante).

## No medido (y por tanto no afirmado)

- **No se ha escrito «hola» en la interfaz** desde este cambio: lo verificado es el código, los
  tipos y las pruebas. La primera prueba real es abrir el chat, preguntar por el fichero abierto
  y ver que responde sobre él.
- El coste real del bloque (tokens por turno) no se ha medido; los topes están para acotarlo, no
  porque se haya medido el presupuesto.

## Fuera de alcance

- Reenviar por el protocolo del daemon los adjuntos **como adjuntos** (hoy viajan como texto
  dentro del prompt). El protocolo sigue siendo de prompt de texto.
- Que durable deje de ser un proceso aparte. Sigue siéndolo: lo que se arregla aquí es lo que el
  chat ve, no dónde vive.
