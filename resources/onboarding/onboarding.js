'use strict';

/*
 * The setup window's page.
 *
 * One page, three jobs: the first run, the run after a version upgrade, and "PiCode: Setup"
 * from inside the editor. The difference is `mode`, and what the page does with the state it is
 * given — the editor's current pi, model and theme arrive already filled in, so the page never
 * asks for something that is configured, and never writes over it without the owner clicking.
 *
 * The page decides nothing about disk. Every write is a named command the main process runs
 * through the connector's own backend (`host.cjs`), and every answer carries a fresh snapshot so
 * the page repaints from what is actually recorded rather than from what it hoped it wrote.
 */

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * Two languages, one table. The product's own text is English; the Spanish column is here
 * because this window is the first thing somebody sees and the brief asks for it. A page that
 * ships its own two columns is a page that needs no language pack to be usable.
 */
const STRINGS = {
	en: {
		language: 'English',
		railSubtitle: 'Setup',
		steps: {
			welcome: 'Welcome',
			pi: 'Agent',
			model: 'Model',
			theme: 'Theme',
			extras: 'Extras',
			done: 'Ready',
		},
		accountHow: 'A browser window will open to complete sign-in when the editor launches.',
		accountWhy: 'Sync your settings, extensions, and AI profiles seamlessly across all your devices.',
		accountButton: 'Sign in with PiCode',
		accountSignIn: 'Sign in with PiCode',
		accountWaiting: 'Waiting for browser authorization…',
		accountWaitingWhy: 'A browser window has opened. Complete the sign-in there to continue.',
		accountSignedIn: (email) => `✓ Signed in as ${email}`,
		accountSignedInShort: 'Signed in',
		accountFailed: (reason) => `Authentication failed: ${reason}. Click to retry.`,
		accountRetry: 'Try again',
		accountEditorSignedIn: (email) => `The editor is signed in as ${email}.`,
		accountNoHandover: 'Signed in, but the editor did not receive the hand-over. Sign in again from the editor with PiCode: Sign in to PiCode.',
		accountTitle: 'PiCode Account',
		accountSignOutQueued: 'Signed out. Your editor will finish it when it starts.',
		accountReopen: 'Open the page again',
		accountSignOut: 'Sign out',
		accountCancel: 'Cancel sign-in',
		accountQueued: 'Ready. Press Continue.',
		accountSkip: 'Stay signed out',
		welcomeTitle: 'Welcome to PiCode',
		welcomeFirst: 'Your editor and AI agent, perfectly integrated.',
		welcomeHow: 'Choose your agent, pick a model, and set your theme in three steps. Then you start coding.',
		welcomeUpdate: 'PiCode tiene versión nueva. Todo está ya configurado: revísalo, cambia lo que quieras y sigue.',
		welcomeSetup: 'Change anything about your setup. Nothing is touched unless you say so.',
		welcomeFactsPi: 'Agent',
		welcomeFactsModel: 'Model',
		welcomeFactsTheme: 'Theme',
		welcomeNotSet: 'not set yet',
		getStarted: 'Get started',
		piTitle: 'Choose your agent',
		piLead: 'Pi is the background agent powering your editor. Use the built-in version or connect an existing environment.',
		piInternal: 'Built-in Pi',
		piInternalRecommended: 'RECOMMENDED',
		piInternalWhy: 'Managed automatically by PiCode. Settings stay integrated within the editor.',
		piExternal: 'System Pi',
		piExternalWhy: "Uses your machine's global installation. PiCode won't modify its files.",
		piExternalFound: 'Found on machine',
		piExternalMissing: 'No Pi installation found on this machine',
		piInternalVersion: 'Version',
		piChosen: 'IN USE',
		importTitle: 'Import Configuration',
		importLead: 'Copy settings and assets from your local setup. Nothing is overwritten without confirmation.',
		importCredentialsToggle: 'Include my saved sign-ins',
		importCredentials: '🔒 Local Credentials & Sign-ins',
		importCredentialsWhy: 'Credentials stay strictly local on your machine and are used only to reach your configured providers.',
		importRun: 'Import Selected Data',
		importRunning: 'Copying…',
		importDone: 'Copied',
		importOverwritten: 'Replaced',
		importAbsent: 'Was not there',
		importDeclined: 'Not chosen',
		importFailed: 'Failed',
		models: 'AI connections',
		settings: 'Settings and packages',
		mcp: 'MCP servers',
		skills: 'Skills',
		memory: 'Memory',
		sessions: 'Conversations',
		modelTitle: 'Select an AI Model',
		modelConnectedVia: 'available via',
		piExternalReadOnly: 'READ-ONLY',
		modelLead: 'Choose how PiCode connects to your preferred provider. You can manage connections and switch models anytime in Settings.',
		modelSubscriptionNote: 'Signing in needs the editor running, because the account flow lives there. Start with a key now — the subscription is one click away inside.',
		modelSubscription: 'Subscription',
		modelSubscriptionWhy: 'ChatGPT, Claude, Copilot and others, with the account you already pay for.',
		subLoading: 'Fetching available providers… (First-time setup may take a moment while installing packages).',
		subTitle: 'Sign in with your Subscription',
		subLead: 'Authenticate via your browser to link your account. If prompted, simply paste the authorization code provided by Pi.',
		subSignIn: 'Sign in',
		subSignedIn: 'Signed in',
		subOpen: 'Open the page',
		subCode: 'Your code',
		subWaiting: 'Waiting for you to finish in the browser…',
		subCancel: 'Cancel',
		subChoose: 'Choose how to sign in…',
		subDone: 'Signed in',
		subCancelled: 'The sign-in was cancelled.',
		subFailed: 'The sign-in did not finish',
		subNone: 'This pi offers no subscription sign-in.',

		modelOrphan: 'Tienes una clave guardada como «nan», pero no hay ningún proveedor con ese nombre. Sus modelos están dentro de otro proveedor.',
		modelWord: 'model',
		modelCount: 'models',
		modelStale: (ref) => `El modelo que tenías (${ref}) ya no está en tu configuración. Elige uno abajo y guárdalo.`,
		modelPickProvider: 'Choose a provider',
		modelNewConversations: 'Model for new conversations',
		modelAgentsNote: 'Your agents use this model too. Give each one its own any time with /gentle:models in the chat.',
		modelNoKey: 'no key saved',

		modelLocal: 'Local / Self-Hosted',
		providerAdvancedShow: 'Advanced options (address, dialect, name)',
		providerAdvancedHide: 'Hide advanced options',
		modelApiKey: 'API Key',
		modelApiKeyWhy: 'OpenRouter, DeepSeek, Groq, or any address that speaks the OpenAI dialect.',
		modelImported: 'Use the models you brought across',
		modelImportedWhy: 'Your other pi already had these connected.',
		modelConnected: 'Connected',
		modelDefault: 'Model for new conversations',
		modelSaveDefault: 'Use this model',
		modelLater: "I'll do it later",
		modelNothingYet: 'Not connected yet',
		providerName: 'Name',
		providerEndpoint: 'Address',
		providerDialect: 'Dialect',
		providerKey: 'Key',
		providerKeyHint: 'Saved in your pi profile, never shown again.',
		providerConnect: 'Connect',
		providerConnecting: 'Asking the address…',
		providerBadAnswer: 'That address answered no models. Check it, and the key.',
		themeTitle: 'A colour scheme',
		themeTry: 'Move the pointer over a card to try it on the window',
		themeLead: 'Eight to start with. Move the pointer over a card to try it on the window, and click to keep it.',
		themeAll: 'See all themes',
		themeFewer: 'Show fewer',
		extrasTitle: 'A few extras',
		extrasLead: 'Switch on what sounds useful. Everything here can be changed later in Settings.',
		extraMcp: 'MCP servers',
		extraMcpWhy: 'Let the agent use servers you add (MCP).',
		extraContext: 'Your code in the chat',
		extraContextWhy: 'The chat sees the file and the folder you are working in.',
		search: 'Search',
		skipExtras: 'Skip extras',
		doneTitle: 'Ready',
		doneLead: 'This is what your editor will start with.',
		clone: 'Clone',
		startHint: 'Or start with nothing and open a folder from the editor.',
		proNote: 'PiCode Pro brings Sync — your whole setup, backed up and on every machine. Free to try from Settings > Accounts.',
		startCoding: 'Start coding',
		skip: 'Skip setup',
		back: 'Back',
		next: 'Continue',
		folderChosen: 'The editor will open this folder.',
		cloning: 'Cloning…',
		errorTitle: 'That did not work',
		loading: 'Reading your setup…',
		notSet: 'not set',
		providerTest: 'Test connection',
		providerTesting: 'Asking the address…',
		providerOk: 'Connected',
		providerFail: 'Not connected',
		providerGetKey: 'Get a key',
		providerPicks: 'Common picks from this provider',
		providerAllModels: 'All models',
		providerWait: 'Nothing saved until you press Connect.',
		modelsWord: 'models',
		mcpWhy: 'Servers the agent may call: your database, an API, your own tools.',
		skillsWhy: 'Instructions the agent follows when it works in this folder.',
		memoryWhy: 'Facts and preferences it keeps between sessions.',
		credentialsNote: 'Kept in your pi profile on this machine. PiCode never sends them anywhere; pi uses them only against the provider you configured.',
		contextTitle: 'AI Code Context & Privacy',
		contextOffNote: 'The context is currently off in Settings. Choosing any option turns it back on.',
		contextRecommended: 'Recommended',
		contextLead: 'Choose what of your workspace is attached to every message. It changes what the agent is told without asking, not what it is able to read.',
		contextProject: 'Full Workspace',
		contextProjectWhy: 'The agent knows which folder you are working in, sees the file you have open and your selection. The default, and what makes “fix this” work.',
		contextFile: 'Active File Only',
		contextFileWhy: 'The open file and your selection, without naming the folder. Fewer tokens, and the focus stays on the file on screen.',
		contextSelection: 'Selection Only',
		contextSelectionWhy: 'Only the lines you select. No folder names, no paths: the most private option, and the narrowest.',
		factHint: 'Click to change',
		startTitle: 'Where do you want to start?',
		startFolder: 'Open a local folder',
		startFolderWhy: 'The editor opens it and the agent works in it.',
		startClone: 'Clone from GitHub',
		startCloneWhy: 'Paste an address and choose where it lands.',
		startBlank: 'Blank project',
		startBlankWhy: 'Nothing yet; open something from the editor.',
		internalShort: 'Built in',
		externalShort: 'Yours',
	},
	es: {
		language: 'Español',
		railSubtitle: 'Configuración',
		steps: {
			welcome: 'Bienvenida',
			pi: 'Agente',
			model: 'Modelo',
			theme: 'Tema',
			extras: 'Extras',
			done: 'Listo',
		},
		accountHow: 'Se abrirá una ventana del navegador para completar el inicio de sesión cuando arranque el editor.',
		accountWhy: 'Sincroniza tus ajustes, extensiones y perfiles de IA en todos tus dispositivos.',
		accountButton: 'Entrar con PiCode',
		accountSignIn: 'Entrar con PiCode',
		accountWaiting: 'Esperando la autorización del navegador…',
		accountWaitingWhy: 'Se ha abierto una ventana del navegador. Completa allí el inicio de sesión.',
		accountSignedIn: (email) => `✓ Sesión iniciada como ${email}`,
		accountSignedInShort: 'Sesión iniciada',
		accountFailed: (reason) => `No se pudo iniciar sesión: ${reason}. Pulsa para reintentar.`,
		accountRetry: 'Reintentar',
		accountEditorSignedIn: (email) => `El editor ha iniciado sesión como ${email}.`,
		accountNoHandover: 'Sesión iniciada, pero el editor no recibió el traspaso. Vuelve a entrar desde el editor con PiCode: Sign in to PiCode.',
		accountTitle: 'Cuenta de PiCode',
		accountSignOutQueued: 'Sesión cerrada. Tu editor lo terminará al arrancar.',
		accountReopen: 'Abrir la página otra vez',
		accountSignOut: 'Cerrar sesión',
		accountCancel: 'Cancelar inicio de sesión',
		accountQueued: 'Listo. Pulsa Continuar.',
		accountSkip: 'Seguir sin cuenta',
		welcomeTitle: 'Bienvenido a PiCode',
		welcomeFirst: 'Tu editor y tu agente de IA, integrados de verdad.',
		welcomeHow: 'Elige tu agente, escoge un modelo y pon tu tema en tres pasos. Y a programar.',
		welcomeUpdate: 'PiCode ha subido de versión. Ya está todo configurado: revísalo, cambia lo que quieras y omite en un clic.',
		welcomeSetup: 'Cambia lo que quieras de tu configuración. No se toca nada que no pidas.',
		welcomeFactsPi: 'Agente',
		welcomeFactsModel: 'Modelo',
		factHint: 'Pulsa para cambiar',
		startTitle: '¿Dónde quieres empezar?',
		startFolder: 'Abrir una carpeta local',
		startFolderWhy: 'El editor la abre y el agente trabaja en ella.',
		startClone: 'Clonar desde GitHub',
		startCloneWhy: 'Pega una dirección y elige dónde queda.',
		startBlank: 'Proyecto en blanco',
		startBlankWhy: 'Nada por ahora; abre algo desde el editor.',
		welcomeFactsTheme: 'Tema',
		welcomeNotSet: 'sin definir',
		getStarted: 'Empezar',
		piTitle: 'Elige tu agente',
		piLead: 'Pi es el agente que da vida a tu editor por dentro. Usa el que viene incluido o conecta uno que ya tengas.',
		piInternal: 'Pi incluido',
		piInternalRecommended: 'RECOMENDADO',
		piInternalWhy: 'Lo mantiene PiCode por ti y sus ajustes viven dentro del editor.',
		piExternal: 'Pi del sistema',
		piExternalWhy: 'Usa el que ya está instalado en tu equipo. PiCode no toca sus archivos.',
		piExternalFound: 'Encontrado en el equipo',
		piExternalMissing: 'No hay ningún Pi instalado en este equipo',
		piInternalVersion: 'Versión',
		piChosen: 'EN USO',
		importTitle: 'Importar configuración',
		importLead: 'Copia ajustes y contenido de tu configuración local. Nada se sobrescribe sin confirmártelo.',
		importCredentials: '🔒 Credenciales locales y sesiones',
		importCredentialsToggle: 'Incluir mis sesiones guardadas',
		importCredentialsWhy: 'Las credenciales se quedan en tu equipo y solo se usan para llegar a los proveedores que configures.',
		importRun: 'Importar lo seleccionado',
		importRunning: 'Copiando…',
		importDone: 'Copiado',
		importOverwritten: 'Reemplazado',
		importAbsent: 'No estaba',
		importDeclined: 'No elegido',
		importFailed: 'Falló',
		models: 'Conexiones de IA',
		settings: 'Ajustes y paquetes',
		mcp: 'Servidores MCP',
		skills: 'Habilidades',
		memory: 'Memoria',
		sessions: 'Conversaciones',
		modelTitle: 'Elige un modelo de IA',
		modelConnectedVia: 'disponibles vía',
		piExternalReadOnly: 'SOLO LECTURA',
		modelLead: 'Decide cómo se conecta PiCode con tu proveedor. Puedes gestionar las conexiones y cambiar de modelo cuando quieras, en Ajustes.',
		modelSubscriptionNote: 'Iniciar sesión necesita el editor en marcha, porque el flujo de cuenta vive ahí. Empieza con una clave; dentro está a un clic.',
		modelSubscription: 'Suscripción',
		modelSubscriptionWhy: 'ChatGPT, Claude, Copilot y otros, con la cuenta que ya pagas.',
		subLoading: 'Buscando proveedores disponibles… (La primera vez puede tardar un poco: Pi instala sus paquetes).',
		subTitle: 'Entra con tu suscripción',
		subLead: 'Te autenticas en el navegador y quedas vinculado. Si te lo pide, pega el código de autorización que te dé Pi.',
		subSignIn: 'Entrar',
		subSignedIn: 'Sesión iniciada',
		subOpen: 'Abrir la página',
		subCode: 'Tu código',
		subWaiting: 'Esperando a que termines en el navegador…',
		subCancel: 'Cancelar',
		subChoose: 'Elige cómo iniciar sesión…',
		subDone: 'Sesión iniciada',
		subCancelled: 'Has cancelado el inicio de sesión.',
		subFailed: 'El inicio de sesión no terminó',
		subNone: 'Este pi no ofrece inicio de sesión por suscripción.',
		modelOrphan: 'Hay una clave guardada con este nombre, pero ningún proveedor declarado: los modelos que serviría están dentro de otro proveedor. Para usarlo como proveedor propio, añádelo en Ajustes → Chat → Proveedores.',
		modelStale: (ref) => `El modelo en uso es ${ref} y ningún proveedor de aquí lo declara. Elige uno abajo y guárdalo.`,
		modelPickProvider: 'Elige un proveedor',
		modelWord: 'modelo',
		modelCount: 'modelos',
		modelNewConversations: 'Modelo para conversaciones nuevas',
		modelAgentsNote: 'Tus agentes usan este modelo también. Dale uno distinto a cada uno cuando quieras con /gentle:models en el chat.',
		modelNoKey: 'sin clave guardada',
		modelLocal: 'Local / propio',
		providerAdvancedShow: 'Opciones avanzadas (dirección, dialecto, nombre)',
		providerAdvancedHide: 'Ocultar opciones avanzadas',
		modelApiKey: 'Clave API',
		modelApiKeyWhy: 'OpenRouter, DeepSeek, Groq, o cualquier dirección que hable el dialecto de OpenAI.',
		modelImported: 'Usar los modelos que trajiste',
		modelImportedWhy: 'Tu otro pi ya los tenía conectados.',
		modelConnected: 'Conectado',
		modelDefault: 'Modelo para conversaciones nuevas',
		modelSaveDefault: 'Usar este modelo',
		modelLater: 'Lo haré más tarde',
		modelNothingYet: 'Aún sin conectar',
		providerName: 'Nombre',
		providerEndpoint: 'Dirección',
		providerDialect: 'Dialecto',
		providerKey: 'Clave',
		providerKeyHint: 'Se guarda en tu perfil de pi y no se vuelve a mostrar.',
		providerConnect: 'Conectar',
		providerConnecting: 'Preguntando a la dirección…',
		providerBadAnswer: 'Esa dirección no ha devuelto modelos. Revísala, y la clave.',
		themeTitle: 'Una combinación de colores',
		themeTry: 'Pasa el puntero por una tarjeta para probarla en la ventana',
		themeLead: 'Ocho para empezar. Pasa el puntero por una tarjeta para probarla en la ventana y pulsa para quedártela.',
		themeAll: 'Ver todos los temas',
		themeFewer: 'Ver menos',
		extrasTitle: 'Algunos extras',
		extrasLead: 'Activa lo que te suene útil. Todo esto se cambia luego en Ajustes.',
		extraMcp: 'Servidores MCP',
		extraMcpWhy: 'Deja que el agente use los servidores que añadas (MCP).',
		extraContext: 'Tu código en el chat',
		extraContextWhy: 'El chat ve el archivo y la carpeta en la que trabajas.',
		search: 'Buscar',
		skipExtras: 'Omitir extras',
		doneTitle: 'Listo',
		doneLead: 'Con esto arrancará tu editor.',
		clone: 'Clonar',
		startHint: 'O empieza sin nada y abre una carpeta desde el editor.',
		proNote: ' PiCode Pro trae Sync: toda tu configuración, respaldada y en todas tus máquinas. Pruébalo en Ajustes > Cuentas.',
		startCoding: 'Empezar a programar',
		skip: 'Omitir configuración',
		back: 'Atrás',
		next: 'Continuar',
		folderChosen: 'El editor abrirá esta carpeta.',
		cloning: 'Clonando…',
		errorTitle: 'Eso no funcionó',
		loading: 'Leyendo tu configuración…',
		notSet: 'sin definir',
		providerTest: 'Probar conexión',
		providerTesting: 'Preguntando a la dirección…',
		providerOk: 'Conectado',
		providerFail: 'Sin conectar',
		providerGetKey: 'Obtener clave',
		providerPicks: 'Elecciones habituales de este proveedor',
		providerAllModels: 'Todos los modelos',
		providerWait: 'No se guarda nada hasta que pulses Conectar.',
		modelsWord: 'modelos',
		mcpWhy: 'Servidores que el agente puede usar: tu base de datos, una API, tus herramientas.',
		skillsWhy: 'Instrucciones que el agente sigue cuando trabaja en esta carpeta.',
		memoryWhy: 'Datos y preferencias que conserva entre sesiones.',
		credentialsNote: 'Se guardan en tu perfil de pi, en esta máquina. PiCode no los envía a ningún sitio; pi solo los usa contra el proveedor que hayas configurado.',
		contextTitle: 'Contexto de código para la IA',
		contextOffNote: 'El contexto está apagado ahora mismo en Ajustes. Al elegir cualquier opción se vuelve a activar.',
		contextRecommended: 'Recomendado',
		contextLead: 'Elige qué parte de tu espacio de trabajo se adjunta en cada mensaje. Cambia lo que se le dice al agente sin preguntar, no lo que puede leer.',
		contextProject: 'Proyecto completo',
		contextProjectWhy: 'El agente sabe en qué carpeta trabajas, ve el archivo abierto y tu selección. Es lo de por defecto, y lo que hace que «arréglalo» funcione.',
		contextFile: 'Solo el archivo activo',
		contextFileWhy: 'El archivo abierto y tu selección, sin nombrar la carpeta. Menos tokens y la atención en lo que tienes en pantalla.',
		contextSelection: 'Solo la selección',
		contextSelectionWhy: 'Solo las líneas que seleccionas. Sin nombres de carpetas ni rutas: la opción más privada y la más estrecha.',
		internalShort: 'Integrado',
		externalShort: 'El tuyo',
	},
};

let language = 'en';

/** One word, from the current language. */
function t(key) {
	const table = STRINGS[language] ?? STRINGS.en;
	return table[key] ?? STRINGS.en[key] ?? key;
}

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

/**
 * The themes the cards show, with a palette measured from each theme's own colours.
 *
 * These are previews, not the theme engine: the editor paints the real thing when it opens, and
 * the window tints itself with the same handful of colours so picking one is not a guess.
 */
const THEMES = [
	// PiCode's own family first: these are the product's colours, and the editor defaults to
	// PiCode Dark when nobody has chosen (ThemeSettingDefaults in workbenchThemeService.ts).
	{ id: 'PiCode Dark', label: 'PiCode Dark', featured: true, dark: true, palette: { bg: '#050811', panel: '#080C17', fg: '#F3F4F6', line: '#111827', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#3B82F6' } },
	{ id: 'PiCode Light', label: 'PiCode Light', featured: true, dark: false, palette: { bg: '#F8FAFC', panel: '#F1F5F9', fg: '#0F172A', line: '#E2E8F0', keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', accent: '#0284C7' } },
	{ id: 'PiCode Neon Minimal', label: 'PiCode Neon Minimal', featured: true, dark: true, palette: { bg: '#05070B', panel: '#090D14', fg: '#E2E8F0', line: '#121A29', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#00F0FF' } },
	{ id: 'PiCode Slate', label: 'PiCode Slate', featured: true, dark: true, palette: { bg: '#15181D', panel: '#1A1F26', fg: '#E5E7EB', line: '#2A313B', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', accent: '#38BDF8' } },
	{ id: 'PiCode Sepia', label: 'PiCode Sepia', featured: true, dark: false, palette: { bg: '#FBF7F0', panel: '#F5EFE4', fg: '#3B342B', line: '#E3D9C6', keyword: '#cf222e', string: '#0a3069', comment: '#6e7781', accent: '#B45309' } },
	{ id: 'PiCode Synthwave', label: 'PiCode Synthwave', featured: false, dark: true, palette: { bg: '#14111E', panel: '#1A1628', fg: '#F8F8F2', line: '#2C2240', keyword: '#FF7EDB', string: '#FFCC66', comment: '#7B7BA8', accent: '#FF79C6' } },
	{ id: 'Dark Modern', label: 'Dark Modern', featured: true, dark: true, palette: { bg: '#1f1f1f', panel: '#262626', fg: '#cccccc', line: '#3c3c3c', keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', accent: '#0078d4' } },
	{ id: 'Monokai', label: 'Monokai', featured: true, dark: true, palette: { bg: '#272822', panel: '#2f302a', fg: '#f8f8f2', line: '#464741', keyword: '#f92672', string: '#e6db74', comment: '#75715e', accent: '#a6e22e' } },
	{ id: 'Quiet Light', label: 'Quiet Light', featured: true, dark: false, palette: { bg: '#f5f5f5', panel: '#ffffff', fg: '#333333', line: '#dcdcdc', keyword: '#4b83cd', string: '#448c27', comment: '#aaaaaa', accent: '#9760c4' } },
	{ id: 'Abyss', label: 'Abyss', featured: false, dark: true, palette: { bg: '#000c18', panel: '#0b1a2a', fg: '#6688cc', line: '#1d3a57', keyword: '#225588', string: '#22aa44', comment: '#384887', accent: '#4f9bd9' } },
	{ id: 'Dark+', label: 'Dark+', featured: false, dark: true, palette: { bg: '#1e1e1e', panel: '#252526', fg: '#d4d4d4', line: '#3c3c3c', keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', accent: '#0e639c' } },
	{ id: 'Solarized Dark', label: 'Solarized Dark', featured: false, dark: true, palette: { bg: '#002b36', panel: '#073642', fg: '#839496', line: '#0f4a58', keyword: '#859900', string: '#2aa198', comment: '#586e75', accent: '#268bd2' } },
	{ id: 'Tomorrow Night Blue', label: 'Tomorrow Night Blue', featured: false, dark: true, palette: { bg: '#002451', panel: '#00346e', fg: '#ffffff', line: '#0d4a86', keyword: '#ffeead', string: '#d1f1a9', comment: '#7285b7', accent: '#bbdaff' } },
	{ id: 'Light Modern', label: 'Light Modern', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f8f8f8', fg: '#3b3b3b', line: '#e5e5e5', keyword: '#0000ff', string: '#a31515', comment: '#008000', accent: '#005fb8' } },
	{ id: 'Light+', label: 'Light+', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f3f3f3', fg: '#000000', line: '#e5e5e5', keyword: '#0000ff', string: '#a31515', comment: '#008000', accent: '#007acc' } },
	{ id: 'Solarized Light', label: 'Solarized Light', featured: false, dark: false, palette: { bg: '#fdf6e3', panel: '#f7efdb', fg: '#657b83', line: '#e6ddc6', keyword: '#859900', string: '#2aa198', comment: '#93a1a1', accent: '#268bd2' } },
	{ id: 'Kimbie Dark', label: 'Kimbie Dark', featured: false, dark: true, palette: { bg: '#221a0f', panel: '#2b2115', fg: '#d3af86', line: '#42362a', keyword: '#98676a', string: '#889b4a', comment: '#a57a4c', accent: '#f06431' } },
	{ id: 'Red', label: 'Red', featured: false, dark: true, palette: { bg: '#390000', panel: '#440000', fg: '#f8f8f8', line: '#5a1010', keyword: '#ff9d00', string: '#a8ff60', comment: '#827c77', accent: '#ff2b2b' } },
	{ id: 'Default High Contrast', label: 'High Contrast', featured: false, dark: true, palette: { bg: '#000000', panel: '#0c0c0c', fg: '#ffffff', line: '#6fc3df', keyword: '#569cd6', string: '#ce9178', comment: '#7ca668', accent: '#1aebff' } },
	{ id: 'Default High Contrast Light', label: 'High Contrast Light', featured: false, dark: false, palette: { bg: '#ffffff', panel: '#f2f2f2', fg: '#292929', line: '#0f4a85', keyword: '#0f4a85', string: '#811f3f', comment: '#515151', accent: '#0f4a85' } },
];

/** The provider presets: addresses that answer, and the dialect each one speaks. */
const PROVIDER_PRESETS = [
	{ id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', mark: 'OR', keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', api: 'openai-completions', mark: 'DS', keyUrl: 'https://platform.deepseek.com/api_keys' },
	{ id: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', api: 'openai-completions', mark: 'GQ', keyUrl: 'https://console.groq.com/keys' },
];

/**
 * Well-known model ids, offered **only when the provider actually returned them**.
 *
 * A recommendation that names a model the account cannot use is worse than no recommendation, so
 * this list is a filter over the answer, never a list of its own: whatever the endpoint did not
 * report simply is not shown.
 */
const RECOMMENDED_MODELS = [
	'anthropic/claude-sonnet-4',
	'anthropic/claude-3.5-sonnet',
	'openai/gpt-4o',
	'openai/gpt-4o-mini',
	'deepseek/deepseek-chat',
	'deepseek/deepseek-reasoner',
	'meta-llama/llama-3.3-70b-instruct',
	'qwen/qwen-2.5-72b-instruct',
	'llama-3.3-70b-versatile',
	'mistral-large-latest',
];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * The theme a new install starts in, and the one the editor falls back to when nothing is set
 * (`ThemeSettingDefaults` in workbenchThemeService.ts). The setup records it so the choice is
 * visible in the cards and in settings.json instead of being an implicit default.
 */
const DEFAULT_THEME = 'PiCode Dark';

const STEPS = ['welcome', 'pi', 'model', 'theme', 'extras', 'done'];

const state = {
	mode: 'first-run',
	version: '',
	snapshot: undefined,
	step: 0,
	/** Which pi the owner is pointing at, as the choice on screen (not yet written). */
	piChoice: 'internal',
	/** What the import would bring, once asked for. */
	preview: undefined,
	/** The scan in flight, and its failure if it had one. */
	scanRunning: false,
	scanError: undefined,
	/** The items the owner ticked in the import card; credentials are their own flag. */
	importItems: new Set(['settings', 'models', 'mcp', 'skills', 'memory', 'sessions']),
	importCredentials: false,
	importReport: undefined,
	/** The provider form's current values. */
	provider: { id: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions', key: '' },
	providerResult: undefined,
	providerError: undefined,
	/** Which provider the local-models tab is showing. */
	localProvider: undefined,
	/** What the local-models filter holds, so typing survives a repaint. */
	modelQuery: '',
	/** Which of the three ways in is on screen: `subscription`, `key` or `local`. */
	modelTab: 'subscription',
	/** Whether the API-key form shows the address/dialect fields as well. */
	advanced: false,
	subscriptions: undefined,
	subscriptionsLoading: false,
	subscriptionError: undefined,
	signIn: undefined,
	/** The last "Test connection" answer: what the address said, and how long it took. */
	probe: undefined,
	probeRunning: false,
	/** How much of the editor travels with a message (`picode.context.mode`). */
	contextMode: 'project',
	/** The model the owner picked, before it is written. */
	pickedModel: undefined,
	theme: undefined,
	showAllThemes: false,
	/** The three switches, as the editor has them in force; the backend says. */
	extras: { mcp: true, context: true },
	packageQuery: '',
	packageRows: undefined,
	packageError: undefined,
	folder: undefined,
	/** The account card's own state: nothing yet, or the request left for the editor. */
	/** The account card: nothing yet, waiting in the browser, signed in, or the error. */
	account: { state: 'idle', email: undefined, error: undefined },
	/** How the last step will start: a folder, a clone, or nothing. */
	startKind: undefined,
	busy: '',
	notice: undefined,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);

/** One element, with attributes and children, without a template engine. */
function el(tag, attributes, ...children) {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes ?? {})) {
		if (value === undefined || value === false || value === null) {
			continue;
		}
		if (name === 'class') {
			node.className = value;
		} else if (name === 'text') {
			node.textContent = String(value);
		} else if (name === 'html') {
			node.innerHTML = value;
		} else if (name.startsWith('on') && typeof value === 'function') {
			node.addEventListener(name.slice(2).toLowerCase(), value);
		} else if (name === 'checked' || name === 'disabled' || name === 'selected') {
			node[name] = Boolean(value);
		} else {
			node.setAttribute(name, String(value));
		}
	}
	for (const child of children.flat()) {
		if (child === undefined || child === null || child === false) {
			continue;
		}
		node.append(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

/** Replaces a container's contents. */
function fill(node, ...children) {
	if (!node) {
		return;
	}
	node.replaceChildren(...children.flat().filter(child => child !== undefined && child !== null && child !== false));
}

/** The snapshot, or an empty shape so the page can paint before the first answer. */
function snapshot() {
	return state.snapshot ?? { providers: [], packages: [], runtime: 'internal' };
}

/** Every model the profile declares, as `provider/model`. */
function modelRefs() {
	return providerList().flatMap(provider => provider.models.map(model => `${provider.id}/${model}`));
}

/** True when a usable model is recorded. */
function hasModel() {
	return typeof snapshot().defaultModel === 'string' && snapshot().defaultModel.length > 0;
}

/** Says something went wrong, in the header, without blocking the page. */
let noticeTimer;

/**
 * Says something that went wrong — once.
 *
 * An informational banner used to sit above the content for the rest of the session, following
 * the owner from step to step. It now has a close button, it leaves on its own, and moving to
 * another step takes it away: an alert is about the screen it appeared in.
 */
function setNotice(text, kind) {
	state.notice = text === undefined ? undefined : { text, kind: kind ?? 'info' };
	renderNotice();
	clearTimeout(noticeTimer);
	if (state.notice !== undefined && state.notice.kind !== 'error') {
		noticeTimer = setTimeout(() => setNotice(undefined), 9000);
	}
}

function renderNotice() {
	const node = $('notice');
	if (state.notice === undefined) {
		node.hidden = true;
		$('notice-text').textContent = '';
		return;
	}
	node.hidden = false;
	node.className = `notice ${state.notice.kind}`;
	$('notice-text').textContent = state.notice.text;
}

/** Runs an operation with the busy line on, and reports a failure instead of throwing. */
async function withBusy(label, operation) {
	state.busy = label;
	renderBusy();
	try {
		return await operation();
	} catch (error) {
		setNotice(`${t('errorTitle')}: ${error instanceof Error ? error.message : String(error)}`, 'error');
		return undefined;
	} finally {
		state.busy = '';
		renderBusy();
	}
}

function renderBusy() {
	const busy = $('busy');
	busy.hidden = state.busy.length === 0;
	$('busy-text').textContent = state.busy;
}

/** One backend command, with the answer's error turned into a sentence. */
async function command(name, payload) {
	const answer = await window.picode.command(name, payload);
	if (!answer || answer.ok !== true) {
		throw new Error(answer?.error ?? 'the setup could not complete that');
	}
	if (answer.snapshot) {
		adopt(answer.snapshot);
	}
	return answer;
}

/** Takes a fresh snapshot from disk as the truth. */
function adopt(next) {
	if (next === undefined || next === null) {
		return;
	}
	state.snapshot = next;
	state.theme = typeof next.theme === 'string' && next.theme.trim().length > 0 ? next.theme : DEFAULT_THEME;
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/**
 * Nothing repaints the window any more.
 *
 * It used to: picking a theme rewrote the whole palette, which was a nice trick and a bad idea
 * at the same time — the interface you are trying to read became the thing being previewed, and
 * a blue-on-blue theme made every label hard to find. The chrome now has one palette (the
 * product's), and a theme lives where a theme belongs: inside its card's code sample, in its own
 * colours, so the comparison is between the themes rather than between the window and itself.
 */

/**
 * Paints the window with a theme's own palette.
 *
 * It was removed for a while — "the chrome should not follow the theme, a blue-on-blue theme makes
 * labels hard to find" — and that was half right and half wrong: not following meant choosing a
 * theme was choosing a thumbnail, and the owner asked for the preview back. Following it is only
 * readable when the *whole* palette moves together, which is what this does: background, surface,
 * text, borders and accent, all from the theme's own colours.
 */
function paintTheme(palette) {
	const root = document.documentElement;
	root.style.setProperty('--bg', palette.bg);
	root.style.setProperty('--sidebar', palette.panel);
	root.style.setProperty('--panel', palette.panel);
	root.style.setProperty('--fg', palette.fg);
	root.style.setProperty('--line', palette.line);
	root.style.setProperty('--line-strong', palette.line);
	root.style.setProperty('--comment', palette.comment);
	root.style.setProperty('--fg-disabled', palette.comment);
	root.style.setProperty('--accent', palette.accent);
	root.style.setProperty('--accent-hover', palette.accent);
	root.style.setProperty('--accent-ink', palette.dark ? '#FFFFFF' : '#04121B');
	root.style.setProperty('--ok', palette.dark ? '#10B981' : '#0F7B4F');
	root.style.setProperty('--info', palette.accent);
	document.body.dataset.dark = palette.dark ? 'true' : 'false';
}

/** The palette to paint with: the theme in force, or the product's own before one is chosen. */
function paletteOf(id) {
	return THEMES.find(theme => theme.id === id)?.palette;
}

/** Puts the window back on the product palette (nothing chosen, or the pointer left the cards). */
function paintProductPalette() {
	const root = document.documentElement;
	for (const name of ['--bg', '--sidebar', '--panel', '--fg', '--line', '--line-strong', '--comment', '--fg-disabled', '--accent', '--accent-hover', '--accent-ink', '--ok', '--info']) {
		root.style.removeProperty(name);
	}
	document.body.dataset.dark = 'true';
}

/** The seven steps in the rail, with what is done and where we are. */
function renderRail() {
	const rail = $('steps');
	const items = STEPS.map((step, index) => {
		const done = index < state.step;
		const current = index === state.step;
		return el('button', {
			type: 'button',
			class: `step-link${current ? ' current' : ''}${done ? ' done' : ''}`,
			'aria-current': current ? 'step' : undefined,
			disabled: index > state.step,
			onclick: () => go(index),
		},
			el('span', { class: 'step-index', text: done ? '✓' : String(index + 1) }),
			el('span', { class: 'step-name', text: t('steps')[step] ?? step }),
		);
	});
	fill(rail, items);
	$('rail-subtitle').textContent = t('railSubtitle');
}

/** Which section is on screen, and what the footer says. */
function renderStep() {
	const name = STEPS[state.step];
	for (const section of document.querySelectorAll('.step')) {
		section.classList.toggle('active', section.dataset.step === name);
	}
	renderRail();
	renderFooter();
	document.querySelector('.content')?.scrollTo?.({ top: 0 });
}

function renderFooter() {
	const name = STEPS[state.step];
	const last = state.step === STEPS.length - 1;
	$('back').textContent = t('back');
	$('back').hidden = state.step === 0;
	$('next').textContent = last ? t('startCoding') : state.step === 0 ? t('getStarted') : t('next');
	// The model step is the one that can hold somebody up, and it says so with its own escape.
	let skipLabel = t('skip');
	if (name === 'model' && !hasModel()) {
		skipLabel = t('modelLater');
	} else if (name === 'extras') {
		skipLabel = t('skipExtras');
	} else if (name === 'done') {
		$('skip').hidden = true;
		$('next').disabled = false;
		return;
	}
	$('skip').hidden = false;
	$('skip').textContent = skipLabel;
	$('next').disabled = state.step === 2 && !hasModel();
}

/* -- step 1: welcome ------------------------------------------------ */

function renderWelcome() {
	const pi = snapshot().runtime === 'external' && snapshot().externalPi ? t('externalShort') : t('internalShort');
	// Each fact is the way to the question it answers: a summary you cannot act on is a list of
	// words. Pressing "Model" here is the same as reaching that step from the rail.
	const facts = [
		{ step: 1, mark: '🤖', label: t('welcomeFactsPi'), value: pi },
		{ step: 2, mark: '⚡', label: t('welcomeFactsModel'), value: hasModel() ? shortModel(snapshot().defaultModel) : t('welcomeNotSet') },
		{ step: 3, mark: '🎨', label: t('welcomeFactsTheme'), value: state.theme ?? t('welcomeNotSet') },
	];
	renderAccount();
	fill($('welcome-facts'), facts.map(fact => el('button', {
		type: 'button',
		class: 'fact',
		title: t('factHint'),
		onclick: () => go(fact.step),
	},
		el('span', { class: 'fact-head' },
			el('span', { class: 'fact-mark', text: fact.mark }),
			el('span', { class: 'fact-label', text: fact.label }),
		),
		el('span', { class: 'fact-value', text: fact.value }),
	)));
	$('welcome-title').textContent = t('welcomeTitle');
	$('welcome-line').textContent = state.mode === 'update' ? t('welcomeUpdate') : state.mode === 'setup' ? t('welcomeSetup') : t('welcomeFirst');
	// The second line only belongs to a first run: the other two modes already say what they are.
	$('welcome-how').textContent = state.mode === 'first-run' ? t('welcomeHow') : '';
}

/** `provider/model` → the model part, which is what a person recognises. */
function shortModel(ref) {
	return typeof ref === 'string' && ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : (ref ?? '');
}

/**
 * The account card: one line of status, one action, no repetition.
 *
 * It used to say "waiting for the browser" twice — once as the status and again inside a disabled
 * primary button — which reads as a stuck interface. The waiting state now has the sentence once,
 * with a spinner, the instruction underneath, and a quiet way out; the signed-in state swaps the
 * badge and offers to sign out.
 */
function renderAccount() {
	const node = $('welcome-account');
	if (snapshot().accountAvailable !== true) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	const account = state.account;
	const signedIn = account.state === 'signed-in';

	// Signed in: a profile, not a paragraph. The avatar is the account's own picture when the
	// identity carries one, and the initials when it does not.
	const profile = signedIn ? el('div', { class: 'account-profile' },
		account.picture === undefined
			? el('span', { class: 'account-avatar', text: initialsOf(account.email) })
			: el('img', {
				class: 'account-avatar account-picture',
				src: account.picture,
				alt: '',
				// A profile picture is a remote file: if it does not arrive, the initials are still
				// an identity — a broken image icon is not.
				onerror: event => {
					const fallback = event.target.parentElement?.querySelector('.account-picture');
					if (fallback !== null && fallback !== undefined) {
						fallback.replaceWith(el('span', { class: 'account-avatar', text: initialsOf(account.email) }));
					}
				},
			}),
		el('div', { class: 'account-identity' },
			el('span', { class: 'account-name', text: account.email ?? t('accountTitle') }),
			el('span', { class: 'account-sub', text: t('accountSignedInShort') }),
		),
	) : undefined;

	const status = account.state === 'signed-out'
		? el('p', { class: 'account-line', text: t('accountSignOutQueued') })
		: account.state === 'waiting'
			? el('p', { class: 'account-line waiting' }, el('span', { class: 'spinner' }), t('accountWaiting'))
			: account.state === 'failed'
				? el('p', { class: 'account-line error', text: t('accountFailed')(account.error ?? '?') })
				: signedIn ? undefined : el('p', { class: 'account-line', text: t('accountHow') });

	const action = signedIn
		? el('button', { type: 'button', class: 'link small', onclick: () => signOutOfAccount() }, t('accountSignOut'))
		: account.state === 'waiting'
			? el('button', { type: 'button', class: 'link small', onclick: () => cancelAccountSignIn() }, t('accountCancel'))
			: el('button', {
				type: 'button', class: 'primary account-button',
				onclick: () => startAccountSignIn(),
			},
				el('span', { class: 'account-mark', text: '👤' }),
				el('span', { text: account.state === 'failed' ? t('accountRetry') : t('accountSignIn') }),
			);

	fill(node,
		el('div', { class: 'panel-head account-head' },
			el('span', { class: 'panel-title', text: t('accountTitle') }),
		),
		el('p', { class: 'account-line account-subtitle', text: t('accountWhy') }),
		profile,
		status,
		account.state === 'waiting' ? el('p', { class: 'hint account-hint', text: t('accountWaitingWhy') }) : undefined,
		// Everything sits on the card's centre line: one action, or the waiting pair in a row.
		el('div', { class: 'account-actions' },
			// Waiting: the page first, the way out second, both on the centre line.
			account.state === 'waiting' && typeof account.url === 'string'
				? el('button', { type: 'button', class: 'link small', onclick: () => window.picode.openExternal(account.url) }, t('accountReopen'))
				: undefined,
			account.state === 'waiting' && typeof account.url === 'string'
				? el('span', { class: 'account-sep', text: '·' })
				: undefined,
			action,
		),
	);
}

/** Two letters for the avatar when the account carries no picture. */
function initialsOf(email) {
	const name = typeof email === 'string' && email.includes('@') ? email.slice(0, email.indexOf('@')) : (email ?? '');
	const parts = name.split(/[._-]/).filter(part => part.length > 0);
	const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
	return (letters || '?').toUpperCase();
}


/** Signs in for real: the browser opens now, and the card says what is happening. */
async function startAccountSignIn() {
	state.accountCancelled = false;
	state.account = { state: 'waiting', email: undefined, error: undefined, url: undefined };
	renderAccount();
	// The main process says which address it opened; the card offers it again, so a browser that
	// opened behind everything is one click away instead of a second attempt.
	const stopListening = window.picode.account.onEvent(message => {
		if (message?.type === 'opening' && typeof message.url === 'string') {
			state.account = { ...state.account, url: message.url };
			renderAccount();
		}
	});
	setTimeout(() => stopListening(), 60000);
	const result = await window.picode.account.signIn();
	// Cancelled while waiting: the answer that comes back is the cancellation itself, and it must
	// not turn into "authentication failed" on screen.
	if (state.accountCancelled === true) {
		return;
	}
	if (result?.ok === true) {
		state.account = { state: 'signed-in', email: result.email, picture: result.picture, error: undefined };
		// The session itself is stored by the main process (the code is spent by the exchange and
		// cannot be handed over); nothing to forward from here.
	} else {
		state.account = { state: 'failed', email: undefined, error: result?.error ?? t('errorTitle') };
	}
	renderAccount();
}

/** Stops waiting: the listener is closed and the card goes back to where it was. */
async function cancelAccountSignIn() {
	state.accountCancelled = true;
	state.account = { state: 'idle', email: undefined, error: undefined };
	renderAccount();
	try {
		await window.picode.account.cancel();
	} catch {
		// Nothing to cancel is not a failure worth a sentence.
	}
}

/**
 * Signs out for real: no code left here, and the editor drops its own session at start.
 *
 * The session lives in the editor's secret storage, which this window cannot reach — so it says
 * what it did ("your editor will finish it") instead of pretending the cookie is gone.
 */
async function signOutOfAccount() {
	state.account = { state: 'signed-out', email: undefined, error: undefined };
	renderAccount();
	try {
		await command('clearPendingCode', {});
		await command('setAccountSignOut', {});
	} catch {
		// Nothing to clear is the same outcome.
	}
}

/* -- step 2: pi ---------------------------------------------------- */

function renderPi() {
	$('pi-title').textContent = t('piTitle');
	$('pi-lead').textContent = t('piLead');

	const data = snapshot();
	const internalVersion = data.internalPiVersion;
	const external = data.externalPi;

	const cards = [
		card({
			key: 'internal',
			title: t('piInternal'),
			badges: [t('piInternalRecommended')],
			why: t('piInternalWhy'),
			detail: internalVersion ? `${t('piInternalVersion')} ${internalVersion}` : undefined,
			available: true,
		}),
		card({
			key: 'external',
			title: t('piExternal'),
			badges: [t('piExternalReadOnly')],
			why: t('piExternalWhy'),
			detail: external ? `${t('piExternalFound')}${external.version ? ` · v${external.version}` : ''}` : t('piExternalMissing'),
			available: external !== undefined && external.hasProfile,
		}),
	];
	fill($('pi-cards'), cards);
	renderImport();
	// The card is on screen, so the counts have to be asked for — not only when somebody clicks
	// the other card. Leaving it to that click is what left "Reading your setup…" on screen for
	// ever: with the built-in pi chosen (the default) nothing ever asked.
	if (importIsOpen()) {
		void ensurePreview();
	}
}

/** Whether the import card is showing at all. */
function importIsOpen() {
	const external = snapshot().externalPi;
	return state.piChoice === 'internal' && external !== undefined && external.hasProfile;
}

/**
 * Asks what an import would bring, once.
 *
 * The scan is a child process that reads the other profile's folders and answers counts — around
 * 150 ms on a profile with hundreds of sessions — so it runs when the card appears rather than
 * behind a click, and never twice.
 */
async function ensurePreview() {
	if (state.preview !== undefined || state.scanRunning) {
		return;
	}
	state.scanRunning = true;
	state.scanError = undefined;
	renderImport();
	try {
		const answer = await command('scan', {});
		state.preview = answer?.data;
	} catch (error) {
		state.scanError = error instanceof Error ? error.message : String(error);
	} finally {
		state.scanRunning = false;
		renderImport();
	}
}

function card(options) {
	const chosen = state.piChoice === options.key;
	const disabled = options.available !== true;
	return el('button', {
		type: 'button',
		class: `card${chosen ? ' chosen' : ''}${disabled ? ' muted' : ''}`,
		disabled,
		onclick: () => choosePi(options.key),
	},
		el('div', { class: 'card-head' },
			el('span', { class: 'card-title', text: options.title }),
			...(options.badges ?? []).map(text => el('span', { class: 'badge', text })),
			chosen ? el('span', { class: 'badge ok', text: t('piChosen') }) : undefined,
		),
		el('p', { class: 'card-why', text: options.why }),
		options.detail ? el('p', { class: 'card-detail', text: options.detail }) : undefined,
	);
}

async function choosePi(key) {
	state.piChoice = key;
	renderPi();
	await withBusy('', async () => {
		await command('setRuntime', { runtime: key });
		if (key === 'external' && state.preview === undefined) {
			// The scan answers counts; the payload is what the import card paints.
			state.preview = (await command('scan', {}))?.data;
		}
	});
	renderPi();
}

/**
 * The import card: only when there is another profile to bring something from, and only when
 * the pi in use is PiCode's own — importing into a profile that is not being read would leave
 * the panel showing one thing and pi running another.
 */
function renderImport() {
	const node = $('import-card');
	const external = snapshot().externalPi;
	const canImport = state.piChoice === 'internal' && external !== undefined && external.hasProfile;
	if (!canImport) {
		node.hidden = true;
		return;
	}
	node.hidden = false;
	const preview = state.preview;
	const categories = preview === undefined ? [] : [
		['settings', t('settings'), preview.packages],
		['models', t('models'), preview.providers],
		['mcp', t('mcp'), preview.mcpServers],
		['skills', t('skills'), preview.skills],
		['memory', t('memory'), preview.memory],
		['sessions', t('sessions'), preview.sessions],
	];
	const why = { mcp: t('mcpWhy'), skills: t('skillsWhy'), memory: t('memoryWhy') };
	const rows = categories.map(([key, label, count]) => el('label', { class: 'check' },
		el('input', {
			type: 'checkbox',
			checked: state.importItems.has(key),
			onchange: event => {
				if (event.target.checked) {
					state.importItems.add(key);
				} else {
					state.importItems.delete(key);
				}
				renderImport();
			},
		}),
		el('span', { class: 'check-label' },
			el('span', { text: label }),
			why[key] === undefined ? undefined : el('span', { class: 'check-why', text: why[key] }),
		),
		el('span', { class: 'check-count', text: String(count ?? 0) }),
	));

	// Credentials get their own block: a title, what they are, and the one switch that brings them.
	// They start off, and nothing turns them on but this box.
	const credentials = preview === undefined ? undefined : el('div', { class: 'credentials-block' },
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: t('importCredentials') }),
		),
		el('p', { class: 'hint', text: t('importCredentialsWhy') }),
		el('label', { class: 'check' },
			el('input', {
				type: 'checkbox',
				checked: state.importCredentials,
				disabled: preview.hasCredentials !== true,
				onchange: event => {
					state.importCredentials = event.target.checked;
					renderImport();
				},
			}),
			el('span', { class: 'check-label', text: t('importCredentialsToggle') }),
			el('span', { class: 'check-count', text: preview.hasCredentials ? '1' : '0' }),
		),
	);

	const report = state.importReport === undefined ? undefined : renderImportReport(state.importReport);

	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: t('importTitle') }),
		),
		el('p', { class: 'panel-hint', text: t('importLead') }),
		preview !== undefined ? el('div', { class: 'checks' }, rows)
			: state.scanError !== undefined ? el('div', { class: 'panel-actions' },
				el('span', { class: 'hint error', text: state.scanError }),
				el('button', { type: 'button', class: 'secondary', onclick: () => { state.preview = undefined; void ensurePreview(); } }, t('search')),
			)
				: el('p', { class: 'hint', text: t('loading') }),
		credentials,
		el('div', { class: 'panel-actions' },
			el('button', {
				class: 'secondary',
				type: 'button',
				disabled: preview === undefined || state.scanRunning || (state.importItems.size === 0 && !state.importCredentials),
				onclick: runImport,
			}, t('importRun')),
		),
		report,
	);
}

async function runImport() {
	await withBusy(t('importRunning'), async () => {
		// The ticks go over as they are: which items, and whether the sign-ins box was ticked.
		// Turning that into a selection — and keeping credentials off unless the box was
		// ticked — is the backend's rule, not this page's.
		const answer = await command('import', {
			profile: snapshot().externalPi?.profileDir,
			items: [...state.importItems],
			credentials: state.importCredentials === true,
		});
		state.importReport = answer?.data?.report ?? answer?.report;
	});
	renderImport();
}

const STATUS_WORDS = { copied: 'importDone', overwritten: 'importOverwritten', absent: 'importAbsent', failed: 'importFailed', declined: 'importDeclined' };

/** The report, item by item: what was copied, what was replaced, what was not there. */
function renderImportReport(report) {
	if (!report || !Array.isArray(report.items)) {
		return undefined;
	}
	return el('div', { class: 'report' },
		report.items.map(item => el('div', { class: `report-row ${item.status}` },
			el('span', { class: 'report-item', text: item.item }),
			el('span', { class: 'report-status', text: t(STATUS_WORDS[item.status] ?? 'importFailed') }),
			item.reason ? el('span', { class: 'report-why', text: item.reason }) : undefined,
		)),
	);
}

/* -- step 3: model ------------------------------------------------- */

/**
 * The model step, as three tabs and one panel.
 *
 * It used to be three cards that each opened a block underneath, and two of them could be open at
 * once: the page grew taller than the window and the last panel slid under the footer. A tab bar
 * makes "one thing at a time" structural instead of a promise — every panel is shown by exactly
 * one tab, and switching closes the other.
 */
/**
 * The providers that can run models, as pi itself reports them once it has loaded.
 *
 * Until that answer arrives the ones the profile declares are shown. pi's answer is the truth: it
 * includes the providers a package brings (NAN) and the ones signed in with a subscription
 * (Anthropic), which no file declares, and it keeps each provider apart instead of reading a
 * model id's prefix as if it were one.
 */
function providerList() {
	const declared = snapshot().providers.map(provider => ({ ...provider, name: provider.id, subscription: false }));
	if (state.liveProviders === undefined) {
		return declared;
	}
	const live = state.liveProviders.map(provider => ({
		id: provider.id,
		name: provider.name ?? provider.id,
		models: provider.models,
		hasKey: true,
		subscription: provider.subscription === true,
	}));
	// pi only lists a provider that can run right now. One the profile declares (omni, a local
	// router that needs no key) is still the owner's provider, with its own models, so it stays.
	const seen = new Set(live.map(provider => provider.id));
	return [...live, ...declared.filter(provider => !seen.has(provider.id))];
}

/** Asks pi which providers can run models right now, once per change. */
async function loadProviders() {
	if (state.liveProviders !== undefined || state.liveProvidersLoading === true) {
		return;
	}
	state.liveProvidersLoading = true;
	try {
		const answer = await window.picode.command('availableProviders', {});
		if (Array.isArray(answer?.data)) {
			state.liveProviders = answer.data;
		}
	} catch {
		// The declared providers stay on screen; nothing is lost by pi not answering.
	} finally {
		state.liveProvidersLoading = false;
		renderModel();
		renderFooter();
	}
}

function renderModel() {
	if (state.liveProviders === undefined && state.liveProvidersLoading !== true) {
		void loadProviders();
	}
	$('model-title').textContent = t('modelTitle');
	$('model-lead').textContent = t('modelLead');

	const refs = modelRefs();
	// Nothing to show in "local" means the tab does not exist: a tab that opens an empty shelf is
	// a dead end with a label.
	if (state.modelTab === 'local' && refs.length === 0) {
		state.modelTab = 'subscription';
	}

	renderTabs(refs.length);
	renderStatus(refs.length);
	renderSubscriptions();
	renderProviderForm();
	renderLocal(refs);
	// Only while there is nothing connected, and not while the sign-in tab is saying it already.
	$('model-note').textContent = refs.length > 0 || state.modelTab === 'subscription' ? '' : t('modelSubscriptionNote');
}

/** The three ways in, as tabs with their counts. */
function renderTabs(localCount) {
	const tabs = [
		{ key: 'subscription', label: t('modelSubscription'), mark: '💳' },
		{ key: 'key', label: t('modelApiKey'), mark: '🔑' },
		{ key: 'local', label: t('modelLocal'), mark: '📦', count: localCount },
	];
	fill($('model-tabs'), tabs
		.filter(tab => tab.key !== 'local' || localCount > 0)
		.map(tab => el('button', {
			type: 'button',
			class: `tab${state.modelTab === tab.key ? ' chosen' : ''}`,
			role: 'tab',
			'aria-selected': state.modelTab === tab.key ? 'true' : 'false',
			onclick: () => {
				state.modelTab = tab.key;
				renderModel();
			},
		},
			el('span', { class: 'tab-mark', text: tab.mark }),
			el('span', { text: tab.label }),
			tab.key === 'local' ? el('span', { class: 'tab-count', text: String(localCount) }) : undefined,
		)));
}

/** What is already connected, on whichever tab you are standing. */
function renderStatus(localCount) {
	const node = $('model-status');
	const providers = providerList().filter(provider => provider.models.length > 0);
	if (providers.length === 0) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	fill(node,
		el('span', { class: 'dot ok' }),
		el('span', {
			text: `${t('modelConnected')} · ${countOf(localCount)} ${t('modelConnectedVia')} ${providers.map(provider => provider.name).join(', ')}`,
		}),
	);
}

function renderProviderForm() {
	const node = $('model-form');
	if (state.modelTab !== 'key') {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	const presets = PROVIDER_PRESETS.map(preset => el('button', {
		type: 'button',
		class: `preset${state.provider.id === preset.id ? ' chosen' : ''}`,
		onclick: () => {
			// A known provider fills its own address and dialect: asking for them is asking the
			// owner to type what the preset already knows.
			state.provider = { id: preset.id, endpoint: preset.endpoint, api: preset.api, key: state.provider.key };
			state.probe = undefined;
			renderModel();
		},
	}, el('span', { class: 'preset-mark', text: preset.mark }), el('span', { text: preset.label })));

	const field = (label, input) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
	const preset = PROVIDER_PRESETS.find(candidate => candidate.id === state.provider.id);
	const knownPreset = preset !== undefined && state.provider.endpoint === preset.endpoint;

	// The key comes from somewhere the owner has to go, and sending them there is the point.
	const keyLink = preset === undefined ? undefined : el('button', {
		type: 'button',
		class: 'link small',
		title: preset.keyUrl,
		onclick: async () => {
			const answer = await window.picode.openExternal(preset.keyUrl);
			if (answer?.ok !== true) {
				setNotice(answer?.error ?? t('errorTitle'), 'error');
			}
		},
	}, `${t('providerGetKey')} · ${preset.label}`);

	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: knownPreset ? `${t('modelApiKey')} · ${preset.label}` : t('modelApiKey') }),
			keyLink,
		),
		el('div', { class: 'presets' }, presets),
		// One field by default. The address, the dialect and the name are what a preset is for;
		// they are here for a local server or an endpoint nobody has heard of.
		// A short placeholder and the sentence underneath: a paragraph inside a one-line field is
		// what made the key row look like two texts stacked on each other.
		field(t('providerKey'), el('input', {
			type: 'password', value: state.provider.key, spellcheck: 'false', autocomplete: 'off',
			placeholder: 'sk-…',
			oninput: event => { state.provider.key = event.target.value; },
		})),
		el('p', { class: 'hint', text: t('providerKeyHint') }),
		state.advanced ? el('div', { class: 'fields' },
			field(t('providerName'), el('input', {
				type: 'text', value: state.provider.id, spellcheck: 'false',
				oninput: event => { state.provider.id = event.target.value; },
			})),
			field(t('providerEndpoint'), el('input', {
				type: 'text', value: state.provider.endpoint, spellcheck: 'false',
				oninput: event => { state.provider.endpoint = event.target.value; },
			})),
			field(t('providerDialect'), el('select', {
				onchange: event => { state.provider.api = event.target.value; },
			}, ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].map(api =>
				el('option', { value: api, selected: state.provider.api === api, text: api })))),
		) : undefined,
		el('button', {
			type: 'button',
			class: 'link small advanced-toggle',
			onclick: () => { state.advanced = !state.advanced; renderModel(); },
		}, state.advanced ? t('providerAdvancedHide') : t('providerAdvancedShow')),
		probeStatus(),
		state.providerError ? el('p', { class: 'hint error', text: state.providerError }) : undefined,
		el('div', { class: 'panel-actions' },
			el('button', { type: 'button', class: 'secondary', disabled: state.probeRunning, onclick: testProvider },
				state.probeRunning ? t('providerTesting') : t('providerTest')),
			el('button', { type: 'button', class: 'primary', onclick: connectProvider }, t('providerConnect')),
		),
		el('p', { class: 'hint', text: t('providerWait') }),
	);
}

/**
 * The providers a subscription can be opened for — asked of pi, not of a list we keep.
 *
 * The panel is the accordion: it is the same slot the API key uses, so opening one closes the
 * other and nothing is left holding empty space.
 */
function openSubscriptions() {
	state.modelTab = 'subscription';
	state.subscriptionError = undefined;
	renderModel();
}

/**
 * Asks pi which providers can be signed in to, once.
 *
 * The list belongs to a tab that is on screen from the start now, so it is asked for when the tab
 * paints — the same mistake the import card made: a panel that shows a spinner nothing ever
 * resolves is worse than one that asks.
 */
async function loadSubscriptions() {
	if (state.subscriptions !== undefined || state.subscriptionsLoading === true) {
		return;
	}
	state.subscriptionsLoading = true;
	try {
		const answer = await window.picode.command('subscriptions', {});
		state.subscriptions = Array.isArray(answer?.data) ? answer.data : [];
	} catch (error) {
		state.subscriptionError = error instanceof Error ? error.message : String(error);
	} finally {
		state.subscriptionsLoading = false;
		renderSubscriptions();
	}
}

function renderSubscriptions() {
	const node = $('model-subscriptions');
	if (state.modelTab !== 'subscription') {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;
	if (state.subscriptions === undefined && state.subscriptionsLoading !== true) {
		void loadSubscriptions();
	}

	const running = state.signIn;
	const list = (state.subscriptions ?? []).map(provider => el('button', {
		type: 'button',
		class: 'provider-row',
		disabled: running !== undefined && running.running === true,
		onclick: () => startSignIn(provider.id),
	},
		el('span', { class: 'provider-text' },
			el('span', { class: 'provider-name', text: provider.name }),
			provider.note === undefined ? undefined : el('span', { class: 'provider-note', text: provider.note }),
		),
		el('span', { class: provider.signedIn === true ? 'provider-go ok' : 'provider-go', text: provider.signedIn === true ? `✓ ${t('subSignedIn')}` : t('subSignIn') }),
	));

	const live = running === undefined ? undefined : el('div', { class: 'signin' },
		el('p', { class: 'signin-state' },
			running.finished === true
				? el('span', { class: 'dot ok' })
				: el('span', { class: 'dot pending' }),
			running.message ?? t('subWaiting'),
		),
		running.url === undefined ? undefined : el('button', {
			type: 'button', class: 'link small', onclick: () => window.picode.openExternal(running.url),
		}, t('subOpen')),
		running.code === undefined ? undefined : el('p', { class: 'signin-code' },
			el('span', { class: 'field-label', text: t('subCode') }),
			el('code', { text: running.code }),
		),
		running.prompt === undefined ? undefined : renderPrompt(running.prompt),
		running.running === true ? el('div', { class: 'panel-actions' },
			el('button', { type: 'button', class: 'secondary', onclick: () => window.picode.signIn.cancel() }, t('subCancel')),
		) : undefined,
	);

	fill(node,
		el('div', { class: 'panel-head' },
			el('span', { class: 'panel-title', text: t('subTitle') }),
		),
		el('p', { class: 'panel-hint', text: t('subLead') }),
		state.subscriptionError === undefined ? undefined : el('p', { class: 'hint error', text: state.subscriptionError }),
		state.subscriptions === undefined ? el('p', { class: 'hint', text: t('subLoading') })
			: state.subscriptions.length === 0 ? el('p', { class: 'hint', text: t('subNone') })
				: el('div', { class: 'providers' }, list),
		live,
	);
}

/** One of pi's questions, as a field the page can answer. */
function renderPrompt(prompt) {
	const send = value => {
		void window.picode.signIn.answer(prompt.id, value);
		// Answered: the question leaves the panel, so only what pi says next is left to wait on.
		if (state.signIn?.prompt?.id === prompt.id) {
			state.signIn = { ...state.signIn, prompt: undefined };
			renderSubscriptions();
		}
	};
	if (prompt.type === 'select') {
		return el('label', { class: 'field' },
			el('span', { class: 'field-label', text: prompt.message }),
			// A select that already shows its first option never fires `change` when the owner picks
			// that same option, so pi would wait forever for an answer. A blank first entry keeps every
			// real option, the default included, one choice away from sending.
			el('select', { onchange: event => { if (event.target.value !== '') { send(event.target.value); } } },
				[el('option', { value: '', text: t('subChoose'), selected: true, disabled: true }),
					...(prompt.options ?? []).map(option => el('option', { value: option.id, text: option.label }))]),
		);
	}
	return el('div', { class: 'field' },
		el('span', { class: 'field-label', text: prompt.message }),
		el('div', { class: 'clone' },
			el('input', {
				type: prompt.type === 'secret' ? 'password' : 'text',
				placeholder: prompt.placeholder ?? '',
				onkeydown: event => {
					if (event.key === 'Enter') {
						send(event.target.value);
					}
				},
			}),
			el('button', {
				type: 'button', class: 'secondary',
				onclick: event => send(event.target.parentElement.querySelector('input').value),
			}, t('next')),
		),
	);
}

/** Starts pi's own sign-in and follows it, event by event. */
async function startSignIn(providerId) {
	state.signIn = { running: true, message: t('subWaiting') };
	state.subscriptionError = undefined;
	renderSubscriptions();
	let run;
	const subscription = window.picode.signIn.onEvent(message => {
		// Events from an attempt that is no longer the one on screen are not ours to act on.
		if (run !== undefined && message.run !== undefined && message.run !== run) {
			return;
		}
		const current = state.signIn ?? { running: true };
		if (message.type === 'event') {
			const event = message.event ?? {};
			if (event.type === 'auth_url') {
				state.signIn = { ...current, url: event.url, message: event.instructions ?? t('subWaiting') };
				void window.picode.openExternal(event.url);
			} else if (event.type === 'device_code') {
				state.signIn = { ...current, code: event.userCode, url: event.verificationUri, message: event.instructions ?? t('subWaiting') };
				void window.picode.openExternal(event.verificationUri);
			} else {
				state.signIn = { ...current, message: event.message ?? current.message };
			}
			renderSubscriptions();
			return;
		}
		if (message.type === 'prompt') {
			// "How do you want to sign in?" always has an answer already: the browser one, which pi
			// marks as its default. Nobody should have to pick it, so it is sent straight away and
			// the question never reaches the screen.
			const options = message.prompt?.options ?? [];
			const preferred = message.prompt?.type === 'select'
				? (options.find(option => /\(default\)/i.test(option.label ?? '')) ?? options.find(option => /browser/i.test(option.label ?? '')))
				: undefined;
			if (preferred !== undefined) {
				void window.picode.signIn.answer(message.id, preferred.id);
				return;
			}
			state.signIn = { ...current, prompt: { id: message.id, ...message.prompt } };
			renderSubscriptions();
			return;
		}
		if (message.type === 'done') {
			state.signIn = { ...current, running: false, finished: true, prompt: undefined, message: t('subDone') };
			subscription();
			void refreshAfterSignIn();
			return;
		}
		if (message.type === 'cancelled' || message.type === 'exit') {
			// `exit` is the safety net: whatever ended the child, the panel must stop saying it
			// is still waiting.
			state.signIn = { ...current, running: false, prompt: undefined, message: message.type === 'cancelled' ? t('subCancelled') : (current.message ?? t('subCancelled')) };
			subscription();
			renderSubscriptions();
			return;
		}
		if (message.type === 'error') {
			state.signIn = { ...current, running: false, message: undefined };
			state.subscriptionError = `${t('subFailed')}: ${message.message ?? ''}`;
			subscription();
			renderSubscriptions();
		}
	});
	const started = await window.picode.signIn.start(providerId);
	run = started?.run;
}

/** After a sign-in the profile has new models: ask again, and offer them. */
async function refreshAfterSignIn() {
	// A sign-in changes both lists: which providers can run models, and which rows say "Signed in".
	state.liveProviders = undefined;
	state.subscriptions = undefined;
	await withBusy('', async () => {
		const answer = await window.picode.command('state', {});
		if (answer?.data) {
			adopt(answer.data);
		}
	});
	renderModel();
	renderFooter();
}

/**
 * The models in the profile: **provider first, then its models**.
 *
 * A profile may declare one provider whose model ids carry their own namespaces — the one in front
 * of me has a single `omni` whose 165 models are `NAN-…`, `nan-providers/…`, `auto/…`, `nvidia/…`.
 * Showing that as one flat list mixes families that belong nowhere near each other, and showing
 * only `omni` hides the very families somebody is looking for. So the first dropdown lists the
 * provider **and each of its namespaces as its own entry** — `omni`, `omni › NAN`, `omni ›
 * nan-providers` — and the second holds only that entry's models.
 *
 * Nothing is renamed or moved on disk: this is a view over what pi reports. A namespace is a
 * group of model ids, and the label says whose they are.
 */
function renderLocal(refs) {
	const node = $('model-local');
	if (state.modelTab !== 'local' || refs.length === 0) {
		node.hidden = true;
		node.replaceChildren();
		return;
	}
	node.hidden = false;

	const entries = providerEntries();
	const current = snapshot().defaultModel;
	// A default model whose provider is not in the profile is a model the editor cannot run. It is
	// not this window's job to choose one, but it is its job to say so instead of showing a list
	// that never mentions it.
	const allRefs = entries.length > 0 ? entries[0] === undefined ? [] : providerList().flatMap(provider => provider.models.map(model => `${provider.id}/${model}`)) : [];
	state.staleModel = typeof current === 'string' && current.length > 0 && !allRefs.includes(current)
		? t('modelStale')(current)
		: undefined;
	if (state.localProvider === undefined || !entries.some(entry => entry.key === state.localProvider)) {
		// Start where the owner already is: the narrowest entry that holds the default model, so the
		// dropdown opens on the family in use instead of on a list of 165.
		const holders = entries.filter(entry => typeof current === 'string' && entry.models.some(model => `${entry.provider}/${model}` === current));
		state.localProvider = (holders.length === 0 ? entries[0] : holders.reduce((narrowest, entry) => (entry.models.length <= narrowest.models.length ? entry : narrowest)))?.key;
	}
	const entry = entries.find(candidate => candidate.key === state.localProvider);
	const entryRefs = entry === undefined ? [] : entry.models.map(model => `${entry.provider}/${model}`);
	const selected = entryRefs.includes(state.pickedModel) ? state.pickedModel : (entryRefs.includes(current) ? current : entryRefs[0]);
	if (selected !== undefined) {
		state.pickedModel = selected;
	}

	fill(node,
		el('label', { class: 'field' },
			el('span', { class: 'field-label', text: t('modelPickProvider') }),
			el('select', {
				onchange: event => {
					// A model belongs to its entry: switching clears the pick.
					state.localProvider = event.target.value;
					state.pickedModel = undefined;
					renderModel();
				},
			}, entries.map(candidate => el('option', {
				value: candidate.key,
				selected: candidate.key === state.localProvider,
				text: candidate.label,
			}))),
		),
		(snapshot().orphanCredentials ?? []).length === 0 ? undefined : el('p', { class: 'hint' },
			`${t('modelOrphan')} (${snapshot().orphanCredentials.join(', ')})`),
		state.staleModel === undefined ? undefined : el('p', { class: 'hint error', text: state.staleModel }),
		el('label', { class: 'field' },
			el('span', { class: 'field-label', text: t('modelNewConversations') }),
			el('select', {
				onchange: event => { state.pickedModel = event.target.value; },
			}, entryRefs.toSorted((left, right) => left.localeCompare(right)).map(ref =>
				el('option', { value: ref, selected: ref === selected, text: ref }))),
		),
		el('p', { class: 'hint', text: t('modelAgentsNote') }),
		el('div', { class: 'panel-actions' },
			el('button', {
				type: 'button', class: 'secondary',
				disabled: selected === undefined,
				onclick: async () => {
					const chosen = $('model-local').querySelectorAll('select')[1];
					if (chosen === undefined) {
						return;
					}
					await withBusy('', async () => { await command('setModel', { ref: chosen.value }); });
					renderModel();
					renderFooter();
				},
			}, t('modelSaveDefault')),
		),
	);
}

/** `1 model` / `2 models`, in the language on screen. */
function countOf(models) {
	return `${models} ${models === 1 ? t('modelWord') : t('modelCount')}`;
}

/**
 * The provider dropdown's entries: one per provider, with the models it really offers.
 *
 * A provider is what pi reports as one. A model id's prefix (`NAN-…`, `auto/…`) is not a provider,
 * so omni lists only omni's models, NAN appears when the NAN package brings it, and a subscription
 * (Anthropic) appears once it is signed in.
 */
function providerEntries() {
	return providerList()
		.filter(candidate => candidate.models.length > 0)
		.map(provider => {
			const models = provider.models.map(model => (typeof model === 'string' ? model : String(model)));
			const note = provider.subscription ? ` · ${t('subSignedIn')}` : provider.hasKey ? '' : ` · ${t('modelNoKey')}`;
			return {
				key: provider.id,
				provider: provider.id,
				label: `${provider.name} · ${countOf(models.length)}${note}`,
				models,
			};
		});
}

/* -- step 4: theme ------------------------------------------------- */

function renderTheme() {
	$('theme-title').textContent = t('themeTitle');
	$('theme-lead').textContent = t('themeLead');
	const shown = THEMES.filter(theme => state.showAllThemes || theme.featured);
	fill($('theme-grid'), shown.map(themeCard));
	$('theme-all').textContent = state.showAllThemes ? t('themeFewer') : t('themeAll');
}

function themeCard(theme) {
	const chosen = state.theme === theme.id;
	return el('button', {
		type: 'button',
		class: `theme-card${chosen ? ' chosen' : ''}`,
		title: t('themeTry'),
		onmouseenter: () => paintTheme(theme.palette),
		onmouseleave: () => { const inForce = paletteOf(state.theme); if (inForce) { paintTheme(inForce); } else { paintProductPalette(); } },
		onfocus: () => paintTheme(theme.palette),
		onblur: () => { const inForce = paletteOf(state.theme); if (inForce) { paintTheme(inForce); } else { paintProductPalette(); } },
		onclick: () => chooseTheme(theme),
	},
		el('div', {
			class: 'theme-preview',
			style: `background:${theme.palette.bg};border-color:${theme.palette.line}`,
			html: [
				`<span style="color:${theme.palette.comment}">// hello</span>`,
				`<span style="color:${theme.palette.keyword}">const</span> <span style="color:${theme.palette.fg}">pi</span> <span style="color:${theme.palette.keyword}">=</span> <span style="color:${theme.palette.string}">'picode'</span>`,
				`<span style="color:${theme.palette.keyword}">function</span> <span style="color:${theme.palette.fg}">chat</span><span style="color:${theme.palette.comment}">() {</span>`,
				`  <span style="color:${theme.palette.keyword}">return</span> <span style="color:${theme.palette.string}">"hola"</span>`,
				`<span style="color:${theme.palette.comment}">}</span>`,
			].join('<br>'),
		}),
		el('div', { class: 'theme-name' },
			el('span', { text: theme.label }),
			chosen ? el('span', { class: 'badge ok', text: '✓' }) : undefined,
		),
	);
}

async function chooseTheme(theme) {
	state.theme = theme.id;
	paintTheme(theme.palette);
	renderTheme();
	await withBusy('', async () => { await command('setTheme', { id: theme.id }); });
}

/* -- step 5: extras ----------------------------------------------- */

function renderExtras() {
	$('extras-title').textContent = t('extrasTitle');
	$('extras-lead').textContent = t('extrasLead');
	const toggle = (key, title, why) => el('label', { class: 'switch' },
		el('span', { class: 'switch-text' },
			el('strong', { text: title }),
			el('span', { class: 'switch-why', text: why }),
		),
		el('input', {
			type: 'checkbox',
			checked: state.extras[key] === true,
			onchange: async event => {
				state.extras[key] = event.target.checked;
				await withBusy('', async () => { await command('setExtras', { values: { [key]: event.target.checked } }); });
				renderExtras();
			},
		}),
	);

	// One control, not two. It used to be a switch *and* three cards: with the switch off the
	// cards were disabled and nobody could tell which of the two was in charge. The cards are the
	// control; choosing one is what turns the context on.
	const modes = [
		{ key: 'project', title: t('contextProject'), why: t('contextProjectWhy'), mark: '📂', badge: t('contextRecommended') },
		{ key: 'file', title: t('contextFile'), why: t('contextFileWhy'), mark: '📄' },
		{ key: 'selection', title: t('contextSelection'), why: t('contextSelectionWhy'), mark: '🔒' },
	];

	fill($('extras-list'),
		el('div', { class: 'panel' },
			toggle('mcp', t('extraMcp'), t('extraMcpWhy')),
		),
		el('div', { class: 'panel' },
			el('div', { class: 'panel-head' },
				el('span', { class: 'panel-title', text: t('contextTitle') }),
			),
			el('p', { class: 'panel-hint', text: t('contextLead') }),
			el('div', { class: 'modes', role: 'radiogroup', 'aria-label': t('contextTitle') },
				modes.map(mode => {
					const chosen = state.contextMode === mode.key;
					return el('button', {
						type: 'button',
						class: `mode${chosen ? ' chosen' : ''}`,
						role: 'radio',
						'aria-checked': chosen ? 'true' : 'false',
						onclick: () => chooseContextMode(mode.key),
					},
						el('span', { class: 'mode-head' },
							el('span', { class: 'mode-mark', text: mode.mark }),
							el('strong', { text: mode.title }),
							mode.badge === undefined ? undefined : el('span', { class: 'badge ok', text: mode.badge }),
							chosen ? el('span', { class: 'mode-check', text: '✓' }) : undefined,
						),
						el('span', { class: 'mode-why', text: mode.why }),
					);
				})),
			state.extras.context === false
				? el('p', { class: 'hint' }, t('contextOffNote'))
				: undefined,
		),
	);

	// `pi packages` is not here any more: it is a shelf you browse, not a question a first run has
	// to answer, and it lives where it belongs (Agent Customizations → Packages, in the editor).
}

/**
 * Picks one of the three, and makes sure the context is **on**.
 *
 * The product keeps two settings: whether any context travels (`picode.context.attach`) and how
 * much (`picode.context.mode`). This step shows the second one only — so choosing a card also
 * turns the first one on. Without that, a card could look selected while nothing was attached,
 * which is exactly the confusion the switch caused.
 */
async function chooseContextMode(mode) {
	const wasOff = state.extras.context !== true;
	state.contextMode = mode;
	state.extras.context = true;
	renderExtras();
	await withBusy('', async () => {
		await command('setContextMode', { mode });
		if (wasOff) {
			await command('setExtras', { values: { context: true } });
		}
	});
	renderExtras();
}

/* -- step 6: ready -------------------------------------------------- */

/**
 * Three ways to begin, and one question.
 *
 * The final screen used to compete with itself: suggested prompts, a folder button, a clone box
 * and the primary button all at once. It now asks the only question that matters here — where do
 * you want to start — and the primary button stays the one way out.
 *
 * The starter prompts are gone from this window on purpose: they belong in the chat, next to the
 * project they talk about, not in a setup screen that cannot see it yet.
 */
async function chooseStart(kind) {
	if (kind === 'folder') {
		const answer = await window.picode.chooseFolder();
		if (answer?.path) {
			state.folder = answer.path;
			state.startKind = 'folder';
		}
	} else if (kind === 'clone') {
		state.startKind = 'clone';
	} else {
		state.folder = undefined;
		state.startKind = 'blank';
	}
	renderDone();
}

function renderDone() {
	$('done-title').textContent = t('doneTitle');
	$('done-lead').textContent = t('doneLead');
	$('done-start-title').textContent = t('startTitle');
	$('clone').textContent = t('clone');
	$('pro-note').textContent = t('proNote');

	// One question, three answers — each a card, and the picked one says so.
	const starts = [
		{ kind: 'folder', title: t('startFolder'), why: t('startFolderWhy'), mark: '📂' },
		{ kind: 'clone', title: t('startClone'), why: t('startCloneWhy'), mark: '🐙' },
		{ kind: 'blank', title: t('startBlank'), why: t('startBlankWhy'), mark: '⚡' },
	];
	fill($('start-cards'), starts.map(start => el('button', {
		type: 'button',
		class: `card start-card${state.startKind === start.kind ? ' chosen' : ''}`,
		onclick: () => chooseStart(start.kind),
	},
		el('div', { class: 'card-head' },
			el('span', { class: 'start-mark', text: start.mark }),
			el('span', { class: 'card-title', text: start.title }),
		),
		el('p', { class: 'card-why', text: start.why }),
	)));

	// The clone address only exists when cloning is the answer: no box waiting to be filled in.
	const cloning = state.startKind === 'clone';
	$('clone-row').hidden = !cloning;
	$('start-hint').textContent = state.folder === undefined
		? (cloning ? '' : t('startHint'))
		: `${t('folderChosen')} ${state.folder}`;

	const data = snapshot();
	const piValue = data.runtime === 'external' ? (data.externalPi?.version ? `${t('externalShort')} · ${data.externalPi.version}` : t('externalShort')) : `${t('internalShort')}${data.internalPiVersion ? ` · ${data.internalPiVersion}` : ''}`;
	const rows = [
		[t('welcomeFactsPi'), piValue],
		[t('welcomeFactsModel'), hasModel() ? snapshot().defaultModel : t('modelNothingYet')],
		[t('welcomeFactsTheme'), state.theme ?? t('notSet')],
	];
	fill($('done-summary'), rows.map(([label, value]) => el('div', { class: 'summary-row' },
		el('span', { class: 'summary-label', text: label }),
		el('span', { class: 'summary-value', text: value }),
	)));
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function go(index) {
	if (index < 0 || index >= STEPS.length) {
		return;
	}
	state.step = index;
	// An alert belongs to the screen that raised it.
	setNotice(undefined);
	renderStep();
	renderCurrent();
}

function renderCurrent() {
	const name = STEPS[state.step];
	if (name === 'welcome') {
		renderWelcome();
	} else if (name === 'pi') {
		renderPi();
	} else if (name === 'model') {
		renderModel();
	} else if (name === 'theme') {
		renderTheme();
	} else if (name === 'extras') {
		renderExtras();
	} else if (name === 'done') {
		renderDone();
	}
	renderFooter();
}

/** The last step's primary action: record the setup and let the editor open. */
async function finish(skipped) {
	await withBusy('', async () => {
		await window.picode.finish({ skipped: skipped === true, folder: state.folder });
	});
}

$('next').addEventListener('click', async () => {
	if (state.step === STEPS.length - 1) {
		await finish(false);
		return;
	}
	go(state.step + 1);
});
$('back').addEventListener('click', () => go(state.step - 1));
$('skip').addEventListener('click', async () => {
	// "Skip" on the model step means "later, not now" and moves on; anywhere else it leaves.
	if (STEPS[state.step] === 'model') {
		go(state.step + 1);
		return;
	}
	await finish(true);
});
$('notice-close').addEventListener('click', () => setNotice(undefined));
$('theme-all').addEventListener('click', () => {
	state.showAllThemes = !state.showAllThemes;
	renderTheme();
});
$('clone').addEventListener('click', async () => {
	const url = $('clone-url').value.trim();
	if (url.length === 0) {
		return;
	}
	await withBusy(t('cloning'), async () => {
		const answer = await window.picode.clone(url);
		if (answer?.ok === true && answer.path) {
			state.folder = answer.path;
		} else if (answer?.error && answer.error !== 'cancelled') {
			setNotice(answer.error, 'error');
		}
	});
	renderDone();
});

document.addEventListener('keydown', event => {
	if (event.key === 'Escape') {
		finish(true);
	}
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/** Switches the whole page's words, and repaints what is on screen. */
function setLanguage(next) {
	language = next;
	// The button offers the language you would switch **to**, not the one you are reading: a button
	// labelled with the language already on screen looks like a status, and reads as "you are here"
	// rather than "press to change".
	const target = next === 'en' ? 'es' : 'en';
	$('language-label').textContent = STRINGS[target].language;
	$('language').setAttribute('title', next === 'en' ? 'Cambiar a español' : 'Switch to English');
	document.documentElement.lang = next;
	renderStep();
	renderCurrent();
}

$('language').addEventListener('click', () => {
	setLanguage(language === 'en' ? 'es' : 'en');
});

async function main() {
	setLanguage('en');

	// The setup window used to keep its own idea of the session; now it follows the shared one, so a
	// sign-in or a sign-out in the editor shows here immediately (and the reverse is pushed the
	// other way by the same file).
	window.picode.account.onState(message => {
		const email = typeof message?.email === 'string' ? message.email : '';
		// Ignore the echo of our own state: the card already shows it, and repainting would drop
		// the "waiting" spinner mid-flow.
		if (state.account.state === 'waiting') {
			return;
		}
		const signedIn = email.length > 0;
		const already = state.account.state === 'signed-in';
		if (signedIn === already && (state.account.email ?? '') === email) {
			return;
		}
		state.account = signedIn
			? { state: 'signed-in', email, error: undefined }
			: { state: 'idle', email: undefined, error: undefined };
		renderAccount();
		if (signedIn) {
			setNotice(t('accountEditorSignedIn')(email), 'info');
		}
	});
	try {
		const boot = await window.picode.bootstrap();
		state.mode = boot.mode ?? 'first-run';
		state.version = boot.version ?? '';
		if (boot.snapshot) {
			adopt(boot.snapshot);
			if (!boot.snapshot.theme) {
				// Nothing chosen yet: PiCode Dark is the product default, so record it now. This is
				// what makes the card show as chosen and the welcome say the theme, and it keeps
				// the editor on the brand palette instead of an unset setting.
				await command('setTheme', { id: DEFAULT_THEME }).catch(() => undefined);
			}
			state.piChoice = boot.snapshot.runtime === 'external' ? 'external' : 'internal';
			// The extras start from what is recorded, so the switches tell the truth.
			// The switches show what the editor will actually do, defaults included.
			if (boot.snapshot.extras) {
				state.extras = { ...state.extras, ...boot.snapshot.extras };
			}
			if (typeof boot.snapshot.contextMode === 'string') {
				state.contextMode = boot.snapshot.contextMode;
			}
		}
		if (boot.stateError) {
			setNotice(boot.stateError, 'error');
		}
	} catch (error) {
		setNotice(`${t('errorTitle')}: ${error instanceof Error ? error.message : String(error)}`, 'error');
	}

	// Always the welcome. Skipping it because "everything is configured" hid where you were and what
	// the setup had read — the welcome already shows that (pi, model, theme) and every fact there is
	// a shortcut to its step. Arriving mid-flow, at step 2, felt like a form that had lost its start.
	go(0);
}

main();
