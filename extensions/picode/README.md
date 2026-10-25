# extensions/picode/ — 🔌 El conector de PiCode

**La pieza que hace que el chat exista.** Es el puente entre el editor y pi: registra al agente en el chat, descubre proveedores y modelos, entrega MCP, gestiona paquetes, lista y continúa las conversaciones de pi y pinta el panel de estado.

> Regla de producto: PiCode **no tiene extensión propia instalable**. Este conector es código del núcleo: viaja dentro del árbol (`the tree`), se empaqueta con el editor y no se instala de ningún sitio. La capa de superficie vive en el chat y en la barra de actividad, no en una ventana aparte.

## 🗂️ Dentro

| Ruta | Qué es |
| --- | --- |
| `src/` | El código del conector — **fichero a fichero más abajo**. |
| `test/` | Los tests (`node --experimental-strip-types --test test/*.test.ts`; también corren en CI). |
| `media/` | La marca de PiCode para la barra de actividad, con su pareja claro/oscuro. |
| `out/` | El JavaScript compilado (generado por `build/build-connector.sh`, fase 2 de la build). |
| `package.json` | Contribuciones al editor: 20 comandos, la vista `picode-status`, participantes de chat, proveedores de modelos y de MCP. |
| `tsconfig.json` / `tsconfig.test.json` | Compilación del código y de los tests (los tests se tipan en CI). |

## 🚀 Cómo se compila y se prueba

```bash
build/build-connector.sh                      # tsc del conector (fase 2 de build/build.sh)
cd extensions/picode
for f in test/*.test.ts; do node --experimental-strip-types --test "$f"; done
```

## 📄 src/ — qué hace cada fichero

### 🚪 Arranque, sesión y contexto

| Fichero | Qué hace |
| --- | --- |
| `extension.ts` | El conector: punto de entrada. Registra el agente, las sesiones, los comandos, el panel y el resto de módulos. |
| `runtime.ts` | Qué pi corre como agente del editor y con qué configuración (el interno es el de PiCode, el externo es el del PATH). |
| `piSdk.ts` | Encontrar pi y cargarlo: un único sitio para los tres consumidores (agente, suscripción, listado de modelos). |
| `piLocate.ts` | Localizar un pi que no es el nuestro (el del PATH) sin escribir nunca en él. |
| `piConfig.ts` | Lo que el dueño puede decidir sobre pi mismo, leído donde se responden esas preguntas (Ajustes > Chat > Pi). |
| `context.ts` | Los límites de lo que viaja con el prompt: caracteres de texto y líneas de selección. |
| `editor-context.ts` | La carpeta, el fichero, la selección, los problemas y lo adjunto, como bloque de contexto. |
| `workspace-area.ts` | El área de trabajo como la ve una sesión: su identidad y lo que se le cuenta. |
| `session-cwd.ts` | El directorio de trabajo de una sesión de chat, elegido para que exista. |
| `progress.ts` | Qué está haciendo pi, en una línea («read src/app.ts» en vez de «read»). |

### 💬 El chat y sus turnos

| Fichero | Qué hace |
| --- | --- |
| `agent.ts` | `@pi` dentro del chat propio del editor: lo que hace que el chat exista. |
| `agents.ts` | Los agentes que el editor lanzó, como una sola lista. |
| `chat-edits.ts` | Los ficheros que un turno cambió, contados y con diff. |
| `commands.ts` | Los comandos de pi en la caja de entrada del chat, como prompts de fichero. |
| `command-registry.ts` | El registro de comandos de una sesión, leído sin `vscode` (por eso los tests pueden ejecutarlo). |
| `customizations.ts` | Agentes y skills de pi, como los necesita la página de gestión del chat. |
| `permissions.ts` | El control «Permisos por defecto» del chat hacia las herramientas nativas de pi. |
| `progress.ts` | (arriba) el estado de «qué está haciendo ahora». |

### 🧠 Proveedores y modelos

| Fichero | Qué hace |
| --- | --- |
| `declarations.ts` | Los proveedores que el dueño declara **en los ajustes del editor**: una línea por proveedor. |
| `providers.ts` | El lado del editor de conectar un proveedor. |
| `providers-list.ts` | Los proveedores que conoce el perfil y **cómo** los sabe el editor (declarados / suscritos / detectados). |
| `providerIds.ts` | Los ids de modelo en las dos formas en que este producto los pasa. |
| `endpoint.ts` | Preguntar a un proveedor qué modelos tiene: su catálogo es el único que vale. |
| `provider-stream.ts` | Un evento en streaming de un endpoint, reducido a lo que el chat muestra. |
| `models-cache.ts` | Las reglas de vida de la caché de modelos: respuesta inmediata, refresco en segundo plano. |
| `subscriptions.ts` | Los proveedores que se conectan con la suscripción que ya se paga (ChatGPT, Claude, Copilot, Grok, Kimi). |
| `login.ts` | El flujo de «conectar una suscripción». |
| `usage-data.ts` | El cuota de la suscripción, leída en vivo del proveedor. |
| `wizard-models.ts` | Proveedor y modelo del asistente de bienvenida: las dos preguntas de la primera ejecución. |

### 🔌 MCP (herramientas externas)

| Fichero | Qué hace |
| --- | --- |
| `mcp.ts` | Los MCP del editor, entregados a pi como herramientas suyas. |
| `mcpServers.ts` | Los servidores que declara el dueño, tal como los **lee pi** (`mcp.json`). |
| `mcp-provider.ts` | Los MCP de pi, como los necesita la pantalla MCP del editor. |
| `mcp-add.ts` | Añadir un servidor MCP a `mcp.json`, ejecutado en su propio proceso. |
| `mcp-cwd.ts` | El directorio de trabajo del transporte stdio de MCP, vigilado por este editor. |
| `mcp-scopes.ts` | El alcance que decide si un inicio de sesión MCP sobrevive o no. |
| `mcpTools.ts` | Qué es una herramienta MCP y qué devuelve: filtrado, esquema y resultado, sin `vscode`. |

### 📦 Paquetes, plugins y actualizaciones

| Fichero | Qué hace |
| --- | --- |
| `packages-data.ts` | Los paquetes instalados de pi (los *Plugins* de la página de gestión). |
| `packages-install.ts` | El instalador propio: lo que el perfil declara y el disco no tiene, en una sola ejecución oculta. |
| `packages-manage.ts` | Habilitar, deshabilitar y quitar paquetes. |
| `packages-registry.ts` | El catálogo y el instalador detrás de la sección Paquetes. |
| `packages-updates.ts` | Si un paquet instalado va tarde y cómo llevarlo a la versión nueva. |
| `left-behind-packages.ts` | Los paquetes que una importación de un pi externo deja atrás (hoy ninguno). |
| `product-packages.ts` | gentle-pi y gentle-engram, fijados en el perfil por el producto, y qué se recorta de gentle-pi. |
| `gentle-agents-store.ts` | Los subagentes de gentle-pi, leídos de lo que publica, para el bloque Tasks. |
| `product-env.ts` | Las variables que el producto fija para pi y para npm: sin descargas de instalación ni telemetría. |
| `npm-run.ts` | Cómo ejecuta npm este editor, decidido en un sitio (el caso de `npm.cmd` en Windows). |
| `updates-check.ts` | Las reglas del chequeo de actualizaciones: qué se comprueba, qué se guarda y qué se avisa. |
| `onboarding.ts` | La configuración de primer arranque, como puente de la página de bienvenida. |
| `profile-import.ts` | La copia única de un perfil y el escaneo que la previsualiza. |
| `import-project.ts` | Lo que un perfil importado significa para los ajustes del editor. |

### 📚 Sesiones de pi

| Fichero | Qué hace |
| --- | --- |
| `sessions-provider.ts` | Las sesiones de pi: cómo se leen y se listan. |
| `sessions-register.ts` | Esas sesiones como la lista única del panel de Sesiones. |
| `sessions-resume.ts` | Continuar una conversación que el panel lista. |
| `sessions-backup.ts` | Respaldar las sesiones de pi en PiCode Cloud y restaurarlas desde allí. |

### 📊 Panel de estado y trabajo en segundo plano

| Fichero | Qué hace |
| --- | --- |
| `status-view.ts` | El panel de estado PiCode (barra de actividad) y de dónde viene cada proveedor. |
| `status-data.ts` | Los datos de ese panel, respondidos de una sola llamada. |
| `background-jobs.ts` | Los trabajos en segundo plano del agente que siguen corriendo. |
| `background-cards.ts` | Ese trabajo, como tarjeta de chat. |

### 🎨 Temas

| Fichero | Qué hace |
| --- | --- |
| `theme-catalog.ts` | El punto de acceso del catálogo de temas que trae PiCode (Open VSX). |
| `theme-gallery.ts` | La galería de temas servida desde Open VSX, con vista previa de colores. |
| `theme-types.ts` | Una regla `tokenColors` reducida a lo que necesita una vista previa. |

## 📖 Para saber más

- El mapa de todo el repositorio: [`docs/MAPA.md`](../../../docs/MAPA.md).
- La capa de agente y el SDK de pi: [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md).
