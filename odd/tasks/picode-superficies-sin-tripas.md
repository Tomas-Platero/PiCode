# Feature: las superficies que aún no había leído, y los papeles que se venden

## Goal

> «Pues ponte con todo»
>
> «recuerda que todo texto dentro de la app tiene que ser funcional y explicativa al nivel de usuario
> nunca técnica como developer»
>
> «Mucho texto redundante y versiones redundantes. Quiero algo funcional, no técnico.»

Cuatro trabajos, en el orden en que se notan:

1. **Sin tripas a la vista** en las superficies propias de PiCode que esta sesión no había leído
   entera: la barra inferior, el menú de la cuenta, el panel de uso y la página de proveedores.
2. **Instrucción escrita → botón** en esas mismas superficies: lo que hoy se lee, que se pueda
   pulsar. (En el conector ya se arreglaron tres: «Use /login», «Start pi» y una ruta usada como
   pregunta.)
3. **Un dato, una vez**: repaso de redundancia en esas pantallas.
4. **El `README` y los papeles públicos** contra lo que el producto hace hoy (pi interno en el
   núcleo, actualización desde el editor, nube como lo único que se vende).

## Regla de la casa

Lo que **ve** el usuario va en **inglés** y habla de lo que hace, no de cómo está hecho; el detalle
técnico vive aquí. Lo que ya estaba bien no se toca: el trabajo es encontrar lo que no cumple, no
reescribir por gusto.

## Tareas

- [ ] **1. Mapear las superficies y sus textos** (barra inferior, menú de la cuenta, panel de uso,
      página de proveedores): qué se pinta, de qué fichero sale, y qué enseña exactamente. Con la
      lista de hallazgos: rutas absolutas, nombres de claves internas, instrucciones sin botón,
      datos repetidos. *(Delegado: exploración de solo lectura.)*
- [ ] **2. Arreglar los hallazgos** de la tarea 1, con la evidencia de cada uno (antes → después).
      *(Delegado: un solo escritor, superficies acotadas.)*
- [ ] **3. El `README` y los papeles públicos** contra el producto de hoy.
- [ ] **4. Verificar y cerrar**: tipos, tests, y una build para que el pack lleve los textos nuevos;
      commit por unidad de trabajo con su evidencia.

## Fuera de alcance

- Los temas y el asistente de primer arranque: **en curso del dueño**, no se tocan.
- La nube: tiene su propia ficha (`picode-cloud-sync.md`).
- Los textos que no son nuestros: los de VS Code ya son de usuario; lo que se cambia es lo que
  PiCode añade o renombra.

## Lo que estaba bien, comprobado (no se toca)

- **La ventana de gestión del chat**: solo Agents, Skills, MCP Servers, Packages, Tools y Settings
  (`aiCustomizationWorkspaceService.ts:55`, con el comentario que cita `AGENTS.md`). Instructions,
  Prompts y Hooks están fuera por decisión, y lo están de verdad.
- **El icono de la barra de actividad**: la marca de PiCode, no la rosa (y el registro ya lo dice).
- **El conector** (extension.ts / agent.ts / login.ts) y el fichero de textos de ajustes: barridos
  en esta misma sesión.
