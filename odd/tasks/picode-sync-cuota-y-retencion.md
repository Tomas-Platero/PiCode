# Feature: la sync no puede costar más de lo que vale (cuota, retención y latido)

## Goal

Frase del dueño: *«si vamos a tener 10 o 30 o 100 personas no sería un problema?»* y
*«el sync no es solo 1 vez, son varias veces, el sync va a estar mirando cada 2 x 3»*.

Las dos son ciertas. Lo medido contra `picode-7f24f` el 2026-10-02:

| Lo que ocurre | Veces/día | Lecturas cada una | Total/día |
|---|---|---|---|
| 💧 «¿hay algo nuevo?» (temporizador de 5 min + cambios locales) | ~390 | **1** | ~390 |
| 🔥 **Subir un recurso** | ~90 | **211** | **~19.000** |

- El goteo sale barato porque el cliente manda `If-None-Match` y el servidor contesta **304 sin
  cuerpo**: una lectura. Es el **2%** del gasto.
- La subida es el **98%**, y su coste es el **número de revisiones del usuario**, que crece solo:
  `piProfile` tenía **180 revisiones y 29,7 MB** tras dos días de uso (~90/día).
- Cuota gratuita de Firestore (50.000 lecturas/día): hoy alcanza para **2,6 personas**; con el
  contador, para **~83**.

## Decisión de almacenamiento (2026-10-02)

**Se queda en Firestore.** No se mueve a Vercel Blob ni a R2, por tres razones, en orden:

1. **No arregla el problema**: el gasto es el escaneo, no el sitio donde viven los datos.
2. **Introduce un fallo que hoy no existe**: objeto y manifiesto en dos sistemas sin transacción
   común → o quedan objetos huérfanos, o un manifiesto que apunta a algo inexistente (**sync roto**).
3. **Solo arregla el techo de 1 MiB por documento**, y el perfil va por **170 KB**.

`Vercel Blob` además cobra un CDN inservible aquí (datos privados que cambian en cada sync → todo
fallo de caché, cuatro contadores por descarga) y su línea que crece es la transferencia.
**Si algún día se mueve, será a R2** (salida 0 €). La costura es `src/lib/store.ts`.

## Tareas

| # | Tarea | Estado |
|---|---|---|
| Q1 | **Contador de bytes** en el manifiesto, actualizado en la misma transacción que la escritura | ✅ |
| Q2 | **Retención**: las 20 últimas revisiones por recurso, borradas por referencia dentro de la transacción | ✅ |
| Q3 | **Migración perezosa** del contador y la lista (sin script ni credenciales: se cura solo por usuario) | ✅ |
| Q4 | **Quitar la comprobación de revocación** de cada petición (`verifyIdToken(token, true)`) | ✅ |
| Q5 | **Caché del plan** (hoy se lee en cada petición, goteo incluido) | ✅ |
| Q6 | **Aritmética pura con tests** (`lib/retention.ts` + `test/`) antes de tocar el almacén | ✅ |
| Q7 | **El latido**: documentar la decisión de los 5 minutos y su coste en invocaciones | ✅ |

## Decisiones

- **Retención de 20 por recurso.** `piProfile` genera ~90 revisiones al día: 20 son medio día de
  historial útil para deshacer un error reciente, y el almacén deja de crecer. Por antigüedad no
  vale: 30 días = 2.700 revisiones = ~450 MB por persona.
- **La lista de revisiones vive en el manifiesto** (`revisions: {recurso: [{ref, bytes}]}`), con el
  tamaño de cada una. Así la poda es **aritmética**: se decide con lo que ya se ha leído en la
  transacción y se borra **por referencia**, sin consultar la colección (que es justo el escaneo que
  se quiere eliminar). El manifiesto crece ~1,2 KB por recurso.
- **La cuota se comprueba dentro de la transacción** y lanza `413` con el mismo cuerpo que antes: si
  no cabe, la transacción no escribe nada. El plan ya viaja en el contexto de la petición
  (`authenticateRequest`), así que no añade ninguna lectura.
- **El latido se queda en 5 minutos.** Después de Q4 y Q5 cada comprobación es *una invocación y una
  lectura*, y un cambio remoto aparece en 5 minutos como mucho. Subirlo ahorraría invocaciones a
  costa de que sincronizar entre máquinas se note más lento; se deja como está y anotado.
- **Revocación: fuera de la ruta caliente.** `checkRevoked: false` deja el token válido hasta 1 hora
  tras una revocación. Es el precio aceptado a cambio de quitar una ida y vuelta a Google en **cada**
  petición, goteo incluido. La autoridad no cambia: el token sigue verificándose (firma y caducidad)
  y el plan se sigue leyendo.

## Evidencia

- `node --experimental-strip-types --test test/*.test.ts` — aritmética de retención y contador.
- `npm run typecheck` y `npm run build` limpios.
- Despliegue verificado en producción (`/api/health`, `/api/v1/manifest` → 401 del contrato).

## Pendiente

- Ejercitar una subida real desde el editor y comprobar en Firestore que el contador avanza y que
  las revisiones viejas desaparecen (no se puede hacer sin el token del dueño).
