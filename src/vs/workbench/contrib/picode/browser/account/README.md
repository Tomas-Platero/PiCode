# Account

La ventana **Account**: correo y plan, la sync en la nube y la lista de funciones Pro. Es un editor modal aparte de Chat Settings.

- `picodeProEntitlement.ts`: el servicio `IPicodeProEntitlement` (¿sesión iniciada? ¿Pro?) y el registro de funciones Pro. Es un reflejo para la pantalla: quien manda es el servidor (`402`).
- `picodeAccountSections.ts`: el registro de páginas. Una función Pro nueva añade su página con `registerAccountSection`.
- `picodeAccountEditor*.ts`: la ventana (lista lateral y página).
- `picodeAccount*Section.ts`, `picodeProFeaturesSection.ts`: las páginas.
- `issues/`: los conectores de GitHub y Jira: el servicio, los paneles de *Status* y *Fix with pi*. El login está en las tarjetas de `picodeConnectionsSection.ts`.
- `picodeAccount.contribution.ts`: registro del editor y comando `picode.account.open`.
