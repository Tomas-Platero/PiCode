# Mejoras de sincronización en la nube
Base: rama de trabajo actual con cambios locales existentes. Verificación: pruebas locales sin una cuenta real.

## Specs
- S1 — «Estado claro en Ajustes. Mostrar “Cambios pendientes”, “Sincronizando” o “En pausa” y, cuando se conozca, cuándo se reintentará. Mantener visible la hora de la última sincronización correcta.»
- S2 — «Desactivar en este equipo aunque no haya conexión.» Aplicar en local y dejar pendiente avisar a la nube. La desactivación global requiere confirmación del servidor.
- S3 — «Diagnóstico que explique cada ciclo.» Registrar origen, recursos modificados y número de peticiones.
- S4 — «Conflictos más fáciles de resolver.» Mostrar diferencias entre los dos lados y elegir por ajuste o archivo cuando el formato lo admita.

## Tasks
- T1 — S1/S3 — inline — verificado con pruebas del servicio y traducciones
- T2 — S2 — inline — verificado con pruebas de desconexión, cambio de cuenta y espera del ciclo activo
- T3 — S4 — delegado — verificado con pruebas de Settings y comprobación de una mezcla de valores de ambos lados

## Log
- L1 — «ahzlos todos»
- L2 — 137 pruebas de sincronización y ajustes pasaron, además de la comprobación de tipos, traducciones y documentación. La revisión independiente cerró los problemas de cuenta, orden de borrado y última sincronización correcta. Falta prueba visual y con una cuenta real.
