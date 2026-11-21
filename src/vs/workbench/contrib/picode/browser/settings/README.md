# Settings

Las páginas propias de la ventana **Settings** de PiCode: las de *Preferences* y la de *Tools*. La ventana es la de `chat/browser/aiCustomization/` (menú agrupado en `picodeSettingsNav.ts`); cada página se registra en su registro de páginas.

- `picodeSettingsRows.ts`: el constructor de páginas por filas (interruptor, desplegable, segmentado, número, texto, botón). Cada fila lee y guarda su ajuste del usuario y se repinta si cambia en otro sitio.
- `picodePreferencesPages.ts`: General, Editor, Chat and agent, Terminal, Memory, Updates, Accessibility y Keyboard.
- `picodeToolsPage.ts`: las herramientas de pi, con un interruptor cada una (`picode.pi.disabledTools`).
- `picodeSettingsData.ts`: las reglas sin pantalla (búsqueda, herramientas, enlaces antiguos de la cuenta), con sus pruebas en `../test/`.
