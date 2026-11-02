# extensions/picode/l10n/ — 🌍 Las palabras del conector

**Todo lo que el conector dice al usuario, en los 13 idiomas de PiCode.** El código pide la frase
con `vscode.l10n.t('<frase en inglés>')`; el editor busca esa frase en el fichero de su idioma y,
si no la encuentra, deja la inglesa. Nunca se queda en blanco y nunca hay una frase sin traducir
de la que nadie se entere, porque `check` las cuenta.

## 🗂️ Dentro

| Fichero | Qué es |
| --- | --- |
| `bundle.l10n.json` | Las frases del código en inglés (`"<frase>": "<frase>"`, el formato que lee el editor). **Se genera**, no se escribe a mano. |
| `bundle.l10n.<idioma>.json` | Las mismas frases traducidas. |

Los títulos del `package.json` (comandos, vistas, descripciones de los ajustes del proveedor) no
viajan aquí: van en `package.nls.json` y `package.nls.<idioma>.json`, en la carpeta del conector,
porque el editor los resuelve antes de cargar el código.

## 📜 Cómo se mantiene

```bash
node build/l10n.mjs extract --surface extension     # reescribe bundle.l10n.json desde el código
node build/l10n.mjs split de --surface extension    # saca por trozos lo que a un idioma le falta
node build/l10n.mjs merge de --surface extension    # mete los trozos ya traducidos
node build/l10n.mjs check                           # los 13 idiomas y las cuatro superficies
```

`check` se queja de tres cosas: el bundle tiene una frase que ya nadie pide, falta una que el
código sí pide, o a un idioma le falta una traducción o le ha cambiado un `{0}` de sitio.

## ✍️ Al escribir una frase nueva

- Se escribe en inglés y para el usuario: qué hay, qué puede hacer, qué cambió. Sin nombres de
  código, rutas ni banderas.
- Los datos variables van como `{0}`, `{1}`… nunca dentro de la frase.
- Los nombres de producto y lo que parece un identificador (`PiCode`, `pi`, `MCP`, `bash`, `$NAME`,
  un modelo, una ruta) no se traducen nunca.
