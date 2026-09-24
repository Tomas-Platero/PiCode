# Feature: los proveedores se declaran en los ajustes, sin ventanas encadenadas

## Goal

Que conectar un proveedor de modelos **no sea una cadena de ventanas**. El dueño lo pidió así,
mirando la fila de Proveedores del Chat:

> «no quiero la ventanita de arriba, quiero añadir items abajo con sus campos necesarios y/o
> una lista de proveedores a los cuales conectarme por oauth»

## Por qué existe

Hasta ahora, «conectar uno» abría **cuatro cuadros seguidos**: un nombre corto, la dirección del
endpoint, el dialecto y la clave. Y la fila de ajustes que él estaba mirando —«PiCode:
Providers», con su campo «item…» y sus botones OK/Cancel— **no hacía nada**: nadie escribía
esa lista y nadie la leía.

## Lo que se midió antes de elegir la forma

- **Un ajuste del editor no puede ser un formulario con campos.** El editor solo deriva el tipo
  de los elementos de un array cuando son escalares (texto, enum, número): un array de objetos
  cae en «complejo» y no se pinta. Y un ajuste no admite campos secretos. Así que los campos no
  pueden ir cada uno en su casilla dentro de la fila.
- **La pantalla de proveedores del propio editor sí tiene formulario**: «Manage Models» →
  «Add Models» → pi, con los campos que declara el manifiesto del conector y la clave guardada
  como secreto. Ese camino se queda, y además los valores ya llegan al conector como
  `options.configuration`.

De esas dos cosas sale la forma elegida: **una línea por proveedor en la fila de ajustes**, con
sus campos separados por `|`, que es lo que un ajuste sí puede guardar y lo que él puede añadir
en su sitio.

```text
omni | https://endpoint.example/v1 | openai-completions | $OMNI_KEY
id   |  la dirección                |  el dialecto        |  la clave (opcional)
```

Solo el id y la dirección son obligatorios. El dialecto admite su nombre corto (`openai`,
`responses`, `anthropic`, `google`) y por defecto es el compatible con OpenAI. La clave admite
las tres formas de pi: literal, `$VARIABLE` o `!comando`.

## Decisions

- **La declaración es la superficie; el perfil es la proyección.** Lo que él escribe se copia a
  los dos ficheros que lee pi (`models.json` para qué es cada proveedor y qué modelos tiene,
  `auth.json` para la credencial). Un proveedor que el editor puede listar y pi no puede usar
  sería un modelo que falla justo cuando el agente lo elige — y el que ejecuta es pi.
- **La clave literal va a `auth.json`; `$VARIABLE` y `!comando` se quedan en `models.json`.**
  Son las interpolaciones de pi, y ese es el fichero que las lee. Se evita así que la misma
  credencial acabe en `settings.json`, que es el fichero que se comparte y se sincroniza.
- **El comando no desaparece, cambia de casa**: mantiene su id (la fila del núcleo enlaza a él)
  y ahora abre la pantalla de proveedores del editor, que es donde hay formulario con clave
  secreta.
- **Un endpoint que no contesta no borra nada.** Si la lista de modelos no llega, el proveedor
  se queda como estaba en el perfil: una caída de red no puede vaciar la lista del editor.

## Hecho

- `declarations.ts` (nuevo, sin `vscode`): lee la línea, la convierte en proveedor y proyecta el
  resultado en los ficheros de pi. Todo lo que decide es puro salvo escribir dos ficheros.
- `endpoint.ts` (nuevo, sin `vscode`): pregunta al endpoint sus modelos, con las dos formas que
  se encuentran en la vida real (`{data:[…]}` y `{models:[…]}`) y sin inventar una lista.
- `providers.ts`, reducido a lo que necesita el editor: la configuración declarada y el modelo
  que se enseña en la lista del editor.
- `extension.ts`: la lista de modelos se compone de las dos vías (el formulario del editor y las
  líneas de los ajustes) y **el enrutado de cada petición va al proveedor que le corresponde**,
  que antes se lo quedaba el último configurado.
- La cadena de cuatro ventanas **está borrada**: no queda ni un `showInputBox` en el conector.
- La descripción de la fila de ajustes explica el formato (parche 06, y de momento también en el
  editor construido: ver «Verificación»).

## Verificación

Ejecutada, no leída. Un endpoint local de prueba y los módulos compilados del conector, once
comprobaciones (`node .scratch/verificar-proyeccion.cjs`):

| Qué | Resultado |
| --- | --- |
| La línea se lee como un proveedor (id, dirección, dialecto, clave) | OK |
| Sin dialecto declarado, se usa el compatible con OpenAI | OK |
| El dialecto se acepta por nombre corto y por nombre completo | OK |
| Una línea que no es un proveedor **no** cuela como uno (siete casos, incluidos id con barra, dirección sin `http`, dialecto inventado) | OK |
| El endpoint se pregunta de verdad, y su lista sale ordenada y sin repetir | OK |
| Se presenta la clave al endpoint, y sin ella el endpoint la rechaza | OK |
| `models.json` queda con el proveedor y sus modelos | OK |
| Una clave `$VARIABLE` **no** se copia a `auth.json` | OK |
| Una clave literal sí va a `auth.json`, y el proveedor queda marcado para presentarla | OK |
| Proyectar otra vez lo mismo **no reescribe** los ficheros | OK |
| Un endpoint caído no inventa una lista y no toca el perfil | OK |
| El proveedor anterior sigue entero (proyectar no pisa a los demás) | OK |

Además: el conector compila con el compilador del árbol y los parches 03, 06, 10 y 12 siguen
aplicando (`git apply --reverse --check`).

## Lo que queda

- **La lista de proveedores por suscripción (OAuth)**: es la otra mitad, y todavía no existe.
  Se apoya en lo que ya hacía el panel retirado (`picode-providers.md`: catálogo de pi,
  `loginType`, el login por SDK con los diálogos del editor) y hay que migrarlo al conector:
  pedir a pi sus proveedores, enseñar los que se pueden conectar (suscripción y/o clave, con
  los que ya tienen credencial marcados) y ejecutar su login. **Decisión pendiente de su
  respuesta**: la lista, ¿desde una fila de ajustes, desde la paleta, o las dos?
- **Un build completo** para que la fila nueva y el resto de la copia en inglés lleguen al
  editor desde las fuentes (el editor construido ya los lleva, ver más abajo).
- **La copia del panel retirado** sigue en español; se traduce al migrar lo que sirve.

## Lo que se hizo en el editor construido, y por qué

El conector se recompiló con el árbol y se copió a `VSCode-win32-x64/resources/app/extensions/picode`,
que es lo que ese mismo build habría hecho: así él lo ve recargando la ventana, sin esperar a
una build completa. La descripción de la fila de ajustes se reescribió también en la tabla de
textos del editor construido (`out/nls.messages.json`, entrada 18545, comprobada contra su
clave en `nls.keys.json`), y **el próximo build la escribe igual desde el parche 06**. Copia de
seguridad de la tabla: `%TEMP%\nls.messages.json.bak`.

## Registro

- 2026-09-25 · el dueño pide quitar la ventanita y poder añadir items con sus campos, y/o una
  lista de proveedores por suscripción. Se entrega la primera mitad (la fila con sus campos, y
  la cadena de ventanas borrada) y queda anotada la segunda.
