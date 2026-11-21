# Account

Las páginas de la cuenta (*Account* en la ventana **Settings**): correo, plan y lo que trae Pro, la sync en la nube, las conexiones y la privacidad.

- `picodeProEntitlement.ts`: el servicio `IPicodeProEntitlement` (¿sesión iniciada? ¿Pro?) y el registro de funciones Pro. Es un reflejo para la pantalla: quien manda es el servidor (`402`).
- `picodeAccountSections.ts`: mete las páginas en el grupo *Account* de Settings y traduce los enlaces antiguos (`picode.account.open sync`). Una función Pro nueva añade su página con `registerAccountSection`.
- `picodeAccount*Section.ts`, `picodeConnectionsSection.ts`: las páginas.
- `issues/`: los conectores de GitHub y Jira: el servicio, los paneles de *Status* y *Fix with pi*. El login está en las tarjetas de `picodeConnectionsSection.ts`.
- `picodeAccount.contribution.ts`: el comando `picode.account.open`, que abre Settings en la página de la cuenta.
