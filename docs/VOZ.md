# 🎙️ Dictado por voz en el chat del editor

> **Estado: fases 1, 2 y 3 hechas.** Se descarga (tarjeta *Dictation* en Status) y el conector sabe escuchar y devolver el texto. Falta conectar el micrófono del chat y el ajuste (fase 4).

## 🎯 Qué se quiere

Hablar al chat del editor y que lo dicho aparezca en el borrador, sin enviarse. Todo en el equipo del usuario: sin nube, sin claves.

Lo hace hoy el terminal de Gentle (`/gentle:voice`, dentro de gentle-pi). PiCode deja fuera esa parte del terminal (`product-packages.ts` excluye `gentle-voice.ts`), así que en el editor no existe.

## 🧭 Decisión: tres caminos y cuál se elige

| Camino | Qué es | Veredicto |
|---|---|---|
| **A** | La voz que ya trae el editor (micrófono del chat y servicio de voz), con un motor propio. | Es la mitad del camino C. |
| **B** | Activar el dictado de Gentle tal cual dentro del chat. | Descartado: depende del terminal de pi (Espacio pulsado, ventanas del terminal). |
| **C** ✅ | **El mismo motor y modelo que usa Gentle, con el micrófono y la pantalla del editor.** | Elegido. |

**Por qué C:** el modelo, el motor y sus firmas ya los fijó y revisó Gentle; el editor ya tiene botón de micrófono y servicio de voz; y no se arrastra el terminal.

## 📦 Qué se usa y cuánto pesa

Todo sale de `lib/voice-artifacts.ts` de gentle-pi 4.5.1, con versión, tamaño y firma fijados.

| Pieza | Qué es | Descarga | En disco |
|---|---|---|---|
| 🧠 Modelo | NVIDIA Parakeet TDT 0.6B v3, versión comprimida (int8) | ≈ 670 MB | ≈ 670 MB |
| ⚙️ Motor | sherpa-onnx 1.13.8, versión Windows | ≈ 11–23 MB | ≈ 23 MB |
| 🎤 Micrófono | node-cpal 1.0.0 | ≈ 8 MB | ≈ 20 MB |
| **Total** | | **≈ 700 MB** | **≈ 720 MB** |

- La instalación de PiCode **no engorda**: se baja una vez, a petición, al perfil.
- Memoria al dictar: ≈ 1 GB (**estimación**, se mide en la fase 1).
- Procesador, sin tarjeta gráfica: pausa breve al terminar de hablar.
- El modelo es multilingüe (v3). Si cubre español hay que **comprobarlo** en la fase 1; no se promete antes.

## 🏗️ Cómo encaja en el editor

1. **Proveedor de voz del núcleo.** El editor tiene un servicio de voz (`ISpeechService`) al que se le registra un proveedor (`registerSpeechProvider`). Hoy solo lo rellenan extensiones de Microsoft, que PiCode no instala; PiCode registra el suyo. Su identificador de "extensión" es un nombre propio de PiCode, sin extensión real.
2. **Dónde vive el código.** En el núcleo (`src/vs/workbench/contrib/picode/`), sin extensión propia, como pide `AGENTS.md`.
3. **Motor aparte del editor.** El modelo carga en un proceso hijo, no en la ventana, para que una transcripción larga no la congele y un fallo nativo no la tumbe.
4. **Descarga.** Solo a petición, mostrando antes qué se baja y cuánto pesa. Se verifica cada fichero con su firma, se puede cancelar y lo ya bajado se conserva. Carpeta dentro del perfil de PiCode; **nunca** `~/.pi`.
5. **Pantalla.** Se reutiliza el micrófono del chat que ya existe. Pulsar para hablar y pulsar para parar; el texto se pega en el borrador y no se envía. Un ajuste con estado *Está / No está* y botón *Descargar*, en una superficie de Ajustes que ya existe. Texto en inglés, con iconos, sin rutas ni nombres internos.
6. **También en el asistente de primer arranque.** Un paso opcional, junto a los demás (pi, proveedores, tema):
   - Pregunta *¿Quieres dictar por voz?* con *Ahora no* como opción por defecto.
   - Si dice que sí: elegir idioma, ver cuánto se baja y confirmar. La descarga sigue en segundo plano mientras termina el asistente.
   - Si dice que no, o cierra el asistente, no pasa nada: el mismo botón *Descargar* queda en Ajustes y puede hacerlo cuando quiera.
   - Nada se baja sin que lo confirme (regla de descargas de `AGENTS.md`).
7. **Se queda fuera.** Pulsar Espacio para hablar (depende del terminal), la música y el lienzo de diseño de Gentle.

## 🎨 Diseño aprobado (2026-10-29)

Tres superficies, un solo estado compartido (*Not installed*, *Downloading*, *Ready*):

1. **Paso del primer arranque (opcional).** Tarjeta con micrófono y una frase («Dictate instead of typing. It runs on your computer»). Cuatro opciones de idioma con su tamaño a la vista: Spanish, English, 4 languages, All languages. Tres etiquetas de confianza: se queda en el equipo, sin cuenta ni clave, se descarga una vez. Botones *Not now* y *Download <idioma>*. Al descargar: barra de progreso con *Cancel*, y sigue en segundo plano.
2. **Ajustes.** La misma tarjeta en pequeño: estado + un solo botón (*Download* o *Remove*).
3. **Chat.** El micrófono existente: pulsar para hablar (se pone rojo, «Listening…»), pulsar para parar, el texto queda en el borrador sin enviarse. Si no está instalado, avisa en vez de fallar.

Reglas: texto en inglés, icono en cada fila, sin rutas ni nombres internos, el tamaño siempre visible antes de descargar. Las opciones de idioma y sus tamaños son propuesta: se confirman en la fase 1.

## 🪜 Fases

| # | Fase | Hecho cuando |
|---|---|---|
| 1 ✅ | **Prueba de viabilidad** | Parakeet carga y transcribe desde un proceso hijo de PiCode en Windows; se mide memoria, tiempo y descarga real; se prueba el español. |
| 2 ✅ | Descarga y estado | Botón *Descargar* con progreso, firma verificada y cancelación; estado *Está / No está*. |
| 3 ✅ | Grabación y transcripción | Del micrófono al texto, con corte automático a los 2 minutos como en Gentle. |
| 4 | Pantalla | Micrófono del chat y ajuste conectados al proveedor propio. |
| 4b | Primer arranque | Paso opcional del asistente con idioma y descarga; el mismo estado que Ajustes. |
| 5 | Cierre | Pruebas, esta ficha puesta al día, `AGENTS.md` y `docs/MAPA.md` regenerado. |

**La fase 1 decide todo.** Si el motor no funciona dentro de PiCode, se vuelve al camino A con otro motor antes de construir nada más.

## ⚠️ Riesgos

- **Peso:** 700 MB es mucho; por eso es opcional y a petición. Si pesa demasiado, la alternativa son modelos de 50–150 MB que entienden peor.
- **Windows:** el motor necesita el runtime de Visual C++; se detecta y se avisa con un mensaje claro, sin instalarlo por el usuario.
- **Permiso de micrófono:** el sistema lo pide la primera vez.
- **Proceso nativo:** si cae, el chat sigue y se dice "no se pudo dictar", sin detalle técnico.
- **Actualizaciones:** PiCode **no** sigue solo los cambios del motor de Gentle, porque no depende de su terminal. Hay que decidir cuándo revisar las versiones.
- **Documento de licencias:** Parakeet, sherpa-onnx y node-cpal traen licencia propia; se muestran en la confirmación de descarga, como hace Gentle.

## ❓ Decisiones que tomar antes de la fase 2

1. ¿Se mantiene el historial *Voice Transcripts* del menú ⋯ del chat? Hoy se dejó tal cual.
2. ¿Idiomas a soportar desde el principio (inglés, español)?
3. ¿Qué modelo por idioma? Ver la tabla de abajo.

## 🌍 Modelos por idioma

El motor (sherpa-onnx) admite muchos modelos; Gentle solo trae Parakeet v3. Tamaños de descarga medidos en la lista pública de modelos de sherpa-onnx (`asr-models`), el 2026-10-29. **La calidad real en español no está probada**: se compara en la fase 1.

| Modelo | Idiomas | Descarga |
|---|---|---|
| Parakeet v3 (el de Gentle, ya fijado y revisado) | 25 idiomas europeos | ≈ 670 MB en disco, ≈ 464 MB comprimido |
| Fast Conformer solo español | español | ≈ 100 MB |
| Fast Conformer en/de/es/fr | inglés, alemán, español, francés | ≈ 100 MB |
| Canary 180M | inglés, español, alemán, francés | ≈ 146 MB |
| Moonshine base español | español | ≈ 48 MB |
| Whisper tiny / base | multilingüe | ≈ 110 / ≈ 197 MB |

**Propuesta:** el usuario elige idioma y se baja solo ese modelo (≈ 50–150 MB); Parakeet v3 queda como opción "todos los idiomas". Cuesta más: una lista de modelos propia que PiCode tiene que fijar con versión y firma, porque los de Gentle ya vienen fijados y estos no.

## ✅ Resultados de la fase 1 (2026-10-30, a medias)

Probado en **Node 24 normal**, en Windows, con el modelo y el motor fijados por Gentle (firma del modelo verificada). **Todavía no probado dentro de PiCode.**

| Medida | Resultado |
|---|---|
| Español (frase de 5,3 s) | Transcrita sin errores, con tildes y puntuación, en 0,37 s |
| Inglés (frase de 3,8 s) | Transcrita sin errores en 0,30 s |
| Carga del modelo | ≈ 2 s |
| Memoria | ≈ 750–800 MB |
| Descarga real | modelo 670 MB + motor y micrófono ≈ 30 MB |

**Conclusión:** Parakeet v3 entiende español bien y rápido en CPU. Con él **no hace falta** un modelo por idioma: un solo modelo cubre todos. Los modelos pequeños quedan solo como alternativa si 700 MB pesa demasiado.

### Dentro de PiCode (2026-10-30)

Probado con el Node que lleva el editor (Electron 42.8.1, build experimental), con el modelo y las dos librerías descargados de cero y sus firmas verificadas.

| Medida | Resultado |
|---|---|
| Español (5,3 s) | «No preguntes que puede hacer tu país por ti, pregunta qué puedes hacer tú por tu país.» en 0,42 s |
| Inglés (3,8 s) | Correcto en 0,34 s |
| Carga del modelo | ≈ 2,4 s |
| Memoria | ≈ 780 MB |
| Micrófono (node-cpal) | Graba 6 s a 48 kHz desde el micrófono por defecto y se transcribe: «Hola, hola. Esto es una prueba de dictada de vos…» (hablando de verdad, con el nivel correcto) |

**Hallazgo para el diseño:** la función `readWave` del motor falla dentro del editor («External buffers are not allowed»), porque Electron no admite esos buffers. Se evita leyendo el audio en JavaScript y pasándoselo al motor; con eso funciona igual que en Node normal. El audio del micrófono llegará ya como datos de JavaScript, así que no afecta, pero **nunca se debe usar `readWave`**.

**Fase 1 completa:** motor, modelo y micrófono funcionan dentro de PiCode. Dos detalles para la fase 3: el micrófono entrega estéreo a 48 kHz (se mezcla a mono y el motor lo reduce solo a 16 kHz), y la calidad con micrófono real es algo peor que con audio limpio («dictada de vos» por «dictado de voz»), así que conviene cortar el silencio y probar con varios micrófonos.

## ✅ Fase 2: descarga y estado (2026-10-30)

- **Dónde:** `extensions/picode/src/voice-install.ts` (descarga, firmas, reanudación) y `voice-controller.ts` (qué está pasando ahora); la tarjeta *Dictation* de Status la dibuja `picodeStatusSection.ts`. Carpeta de destino: `~/.picode/voice`.
- **Qué hace:** *Download* (se ve el tamaño antes, ≈ 700 MB) → progreso en la etiqueta de la tarjeta → *Ready*. *Cancel* conserva lo bajado y la siguiente vez continúa. *Remove* lo quita todo.
- **Seguridad:** cada fichero se comprueba contra su firma (sha256 del modelo, sha512 de las librerías de npm) antes de usarse; uno que no coincide se borra. Solo se siguen redirecciones a Hugging Face, su red de descargas y npm. El marcador de "instalado" se escribe el último, así que una descarga a medias nunca figura como lista.
- **Probado:** 16 pruebas del conector (firma, reanudación, servidor que ignora el rango, cancelar, hosts permitidos, estados) y una descarga real contra Hugging Face y npm en una carpeta limpia; lo instalado transcribe español e inglés dentro de PiCode.
- **Fallo encontrado en la prueba real:** el `tar` que trae Git para Windows lee `C:\…` como una máquina remota. Se descomprime con rutas relativas, que valen para cualquier `tar`.
- **Solo Windows x64 por ahora**, que es lo único probado. En otros sistemas la tarjeta no aparece.
- **No probado todavía:** cómo se ve la tarjeta en pantalla y pulsar los botones en la app.

## ✅ Fase 3: grabar y transcribir (2026-10-30)

- **Dónde:** `voice-engine.ts` (juntar audio, mezclar a mono, cortar a los 120 s, ignorar clics de menos de 0,3 s), `voice-worker.ts` (el proceso hijo que carga el modelo y usa el micrófono), `voice-session.ts` (el lado del editor: arrancar, parar, reutilizar el proceso, soltarlo a los 5 minutos de calma) y `voice-fork.ts` (lo lanza con el Node del propio editor).
- **Cómo se usa:** dos comandos del conector, `picode.voice.listen` (empieza a escuchar) y `picode.voice.finish` (para y devuelve el texto). Si la grabación llegó a los 2 minutos, se cortó sola y `finish` devuelve lo dicho hasta ahí con `cutOff: true`. Es lo que usará el micrófono del chat en la fase 4.
- **El audio no sale del proceso hijo:** el editor solo manda *empieza* y *para* y recibe el texto. Si el motor se cae, el chat sigue y la siguiente pulsación arranca uno nuevo.
- **Probado:** 16 pruebas nuevas (mezcla, corte a los 2 minutos, clic corto, parar dos veces, micrófono caído, proceso que muere, reutilización, soltar por inactividad) y una ejecución real del proceso con el Node del editor y el micrófono: carga 2,3 s, la segunda dictada es inmediata. En silencio devuelve texto vacío.
- **No probado todavía:** hablar de verdad a través de este camino (la voz se probó en la fase 1 con el mismo motor y micrófono) y el corte real a los 2 minutos (probado con un reloj simulado, no esperando 120 s).
