# src/vs/workbench/contrib/picode/l10n/ — 🌍 Las palabras del editor

**Todo lo que PiCode añade o reescribe en el editor, en los 13 idiomas del producto.** Los paquetes
de idioma del mercado solo conocen los textos de VS Code de serie, así que lo nuestro viaja aparte
y `src/vs/base/node/nls.ts` lo mezcla encima del paquete instalado: manda el fichero del idioma,
después el paquete, y en último lugar el inglés.

| Fichero | Qué es |
| --- | --- |
| `source.json` | Todo lo nuestro en inglés. **Se genera** con `extract`, no se escribe a mano. |
| `<idioma>.json` | Las mismas claves traducidas (`es`, `de`, `pt-br`, `zh-tw`…), nombradas como el paquete de idioma. |

Las claves son el `localize('picode…', "…")` de nuestro código; las que reescriben un texto del
editor de serie van como `<módulo>#<clave>`, porque la misma clave puede significar cosas distintas
en módulos distintos.

## 📜 Cómo se mantiene

```bash
node build/l10n.mjs extract --upstream <checkout de VS Code>   # reescribe source.json
node build/l10n.mjs split de                                   # saca por trozos lo que falta
node build/l10n.mjs merge de                                   # escribe de.json
node build/l10n.mjs check                                      # los 13 idiomas completos
```

`check` compara `source.json` con el código (una frase cambiada sin volver a extraer es un error),
cuenta las claves de cada idioma y vigila que ninguna traducción se coma un `{0}`. Los trozos a
medio traducir viven en `.work/<código>/`, que no se versiona.
