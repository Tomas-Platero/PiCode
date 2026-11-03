# resources/onboarding/l10n/ — 🗣️ Las palabras de la ventana de primer arranque

**Un fichero por idioma, trece en total.** Cada uno llena `window.PICODE_L10N[<código>]` con los
textos de la ventana; `en.js` es el original y el que se usa cuando a un idioma le falta una clave,
así que una ventana con solo algunos idiomas sigue siendo utilizable.

La ventana se abre en el primer idioma del sistema que tenga fichero (con `pt-BR` → `pt-br` y
`zh-Hant-TW` → `zh-tw`) y el pie tiene la lista para cambiarlo a mano.

## 📜 Cómo se mantiene

El inglés manda: se edita `en.js` y después los demás.

```bash
node build/l10n.mjs split de --surface window     # saca por trozos lo que a 'de' le falta
node build/l10n.mjs merge de --surface window     # escribe de.js desde los trozos traducidos
node build/l10n.mjs check                         # los 13 idiomas, claves y {0}
```

`merge` es quien escribe el `.js`, no una mano: mantiene el orden del original, deja `steps` y las
listas como listas y comprueba que ninguna traducción se coma un `{0}`. Los trozos viven en
`.work/<código>/`, que no se versiona.

Un idioma nuevo necesita además su `<script src="l10n/<código>.js">` en `index.html`: `check`
falla si la lista del HTML y los ficheros no coinciden.
