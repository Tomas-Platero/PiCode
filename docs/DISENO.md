# Diseño de PiCode

> Cómo ha de ser el producto, hasta donde sabemos hoy. Las frases del dueño viven en
> `AGENTS.md`; su visión completa, en `docs/VISION.md`. Este documento dice **cómo se junta
> todo**. Los `patch` que aparecen en documentos históricos ya no existen: el árbol vive en
> `picode-source/`.

## 💡 Qué es PiCode, en una frase

Un **VS Code compilado desde su fuente** donde **pi es el agente nativo**, no una extensión
añadida. Sin Copilot en ningún sitio, y con todo integrado como si el editor siempre
hubiera sido así.

## 🧱 Las capas

```text
  Fuente de VS Code 1.135.0   (upstream/stable.json — el pin de procedencia)
        │
        │  el árbol propio: picode-source/  ← los cambios de VSCodium y los nuestros, ya dentro
        │
        │  + distribution/product-delta.json ← el producto (nombre, icono, galería, ajustes, versión)
        ▼
  PiCode  ────────────────────────────────────────────────┐
        │                                                  │
        │  EL NÚCLEO                                       │  LA CONFIGURACIÓN
        │  · Chat y Agente (las superficies)               │  · El perfil propio
        │  · Ajustes, bajo Chat                            │    (nada fuera)
        │  · El host de agentes (proceso con Node)         │  · Proveedores y claves
        │                                                  │  · Habilidades y paquetes
        │  EL CONECTOR  (picode-source/extensions/picode)  ┤  · Sesiones
        │  · Puente a pi: proveedores, SDK, modelos        │
        └──────────────────────────────────────────────────┘
```

### 1. La fuente propia y el delta de producto

El árbol de VS Code **ya no se clona ni se parchea en cada build**: desde el 2026-09-27
`picode-source/` **es la fuente de PiCode**, versionada en este repositorio, con los cambios
de VSCodium y los propios ya dentro. El build no descarga ni aplica parches; compila ese
árbol.

La capa `distribution/` pone el producto **antes** de compilar: nombre, icono, carpeta de
datos propia, galería, ajustes de primer arranque y el **número** que leen las extensiones.
El delta es data (`product-delta.json`) y se aplica a `picode-source/product.json` en la
fase 1.

**Procedencia y número no son lo mismo.** El pin `upstream/stable.json` registra de qué VS
Code desciende el árbol (1.135.0); el número declarado (`set.version`, hoy 1.141.1) se sube
para que las extensiones que piden `engines.vscode: ^1.141.0` sigan instalándose. Es una
decisión medida, no un rebase: ver `odd/tasks/picode-rebase-141.md` y ADR-016.

**Por qué así y no un binario ajeno:** cualquiera puede auditar y recompilar. El instalador
sigue siendo el camino para quien solo quiere *usarlo*.

### 2. El núcleo: las superficies son del editor

Lo que el usuario ve es **Chat y Agente**, y **sus ajustes**. No hay panel de PiCode, ni
pestaña, ni página de ajustes propia. Los ajustes de pi viven **dentro del nodo Chat**.

### 3. El Host: pi

pi es el agente que ejecuta. Tiene **su propio bucle** —sus herramientas de fichero, terminal,
búsqueda y memoria— y su catálogo de proveedores de modelos.

Vive **dentro del núcleo**, partido en dos por una razón técnica que conviene no olvidar:

| Dónde | Qué hace | Por qué ahí |
| --- | --- | --- |
| `src/vs/platform/agentHost/node/pi/` | El host de agentes: abrir una sesión de pi y traducir lo que dice y hace a lo que el editor entiende | Es el **proceso del núcleo que sí tiene Node**, y es el mismo sitio donde VS Code pone sus otros agentes |
| `picode-source/extensions/picode/` | El **conector**: catálogo de proveedores, modelos, claves, perfil | Es una **extensión del núcleo** — se compila con el editor y viaja en el binario. Aquí está Node, y aquí van los puentes |

**Esto no es una extensión al lado del editor.** Todo lo que hay bajo `picode-source/extensions/`
*es* el editor: son `git`, `github-authentication`, `markdown-language-features`… y el
conector es uno más. **No dibuja nada**: ni chat, ni modales, ni ajustes propios. Si algo
necesita superficie, la superficie va al núcleo.

### 4. El Harness: la capa de paquetes de pi

Nada se reimplementa: pi carga **paquetes** desde su perfil, y esos paquetes aportan
habilidades, subagentes, cadenas y temas.

PiCode lo que hace es **enseñarlo**: sus habilidades y sus agentes aparecen en el editor
porque el **propio host de agentes los descubre en disco**, no porque una extensión los lea.

### 5. La configuración: el perfil propio

**Todo** —ajustes de pi, credenciales, modelos, paquetes, habilidades, MCPs, sesiones y
memoria— vive en **el perfil de PiCode**. Nada se lee ni se escribe fuera.

Y esto no es solo aislamiento: es **la unidad que se sube y se baja** el día que se venda la
nube. Un perfil compartido con la máquina no se puede subir ni sobreescribir desde un
producto.

### 6. Los proveedores de modelos

**No hay modelo fijo y no hay que construir el sistema**: pi ya trae **41 proveedores**, ocho
con cuenta (Claude Pro/Max, ChatGPT, Copilot, xAI, Meta, Kimi, OpenRouter, Radius) y el resto
por clave.

El trabajo es **enseñarlo**: que los modelos salgan en la ventana de modelos del editor, y que
conectar uno se haga **desde el Chat** — con cuenta o con clave. Sin permisos especiales: la
puerta del editor para registrar modelos es **estable**.

### 7. El Host externo (opcional)

Por defecto se usa el pi de dentro. Si el usuario quiere, puede:

- **conectarse a un pi que vive fuera** para usar **sus datos y su configuración donde están**
  (por su protocolo: RPC, WebSocket o el que exponga), o
- **traerse su configuración** al perfil de PiCode, como **oportunidad que se ofrece**.

**Lo único absoluto es la dirección: nada se escribe en el pi externo.**

### 8. Lo que se vende

El programa es **gratis y completo**. Lo que se vende es **guardar toda la configuración en la
nube** —la de PiCode y la de pi— como **una sola cosa**, que es exactamente
el perfil propio.

## 📐 Las reglas de diseño

1. **No hay superficie propia de PiCode.** Chat, Agente y sus ajustes.
2. **Nada se escribe fuera del perfil de PiCode.**
3. **No se reimplementa lo que pi ya trae.** Se enseña.
4. **Un dato aparece una vez.** Si se puede leer en tres sitios, sobran dos.
5. **Lo que exige acción es un botón.** "Reinicia pi" no es información.
6. **El conector no dibuja.** Si necesita interfaz, la interfaz es del núcleo.
7. **Nada se marca como hecho sin verlo funcionar.** El registro de este repositorio tiene
   tres casos de lo contrario.

## 🚶 El recorrido del usuario

1. **Instala PiCode y abre.** No hay que configurar nada para empezar.
2. **El asistente de primer arranque** pregunta qué hacer: usar el pi de dentro (lo normal),
   conectarse a un pi externo, o traerse la configuración que ya tenía.
3. **Conecta un proveedor** desde el Chat: elige ChatGPT, Claude, DeepSeek… y lo conecta con
   su cuenta o con una clave.
4. **Habla con `@pi` en el Chat**, que es el del editor. Con sus herramientas, su memoria y
   sus habilidades.
5. **Todo queda en su perfil**, listo para subirse cuando exista la nube.

## 🚫 Qué NO es PiCode

- Un panel propio, una pestaña propia, unos ajustes propios.
- Una extensión al lado del editor.
- Escribir en el pi de la máquina.
- Reimplementar proveedores, OAuth, habilidades o el orquestador.
- Recortar funciones para vender la nube.
