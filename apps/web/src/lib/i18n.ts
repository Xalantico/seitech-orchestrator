import { create } from "zustand";

import { useAuthStore } from "../auth/store";

export type Locale = "es" | "en" | "ca";
export const LOCALES: { code: Locale; label: string }[] = [
  { code: "es", label: "Español" },
  { code: "en", label: "English" },
  { code: "ca", label: "Català" },
];

const es = {
  "app.name": "Orquestador",
  "common.save": "Guardar", "common.cancel": "Cancelar", "common.create": "Crear", "common.edit": "Editar", "common.delete": "Eliminar",
  "common.close": "Cerrar", "common.search": "Buscar", "common.refresh": "Actualizar", "common.loading": "Cargando…", "common.empty": "Nada que mostrar",
  "common.yes": "Sí", "common.no": "No", "common.actions": "Acciones", "common.status": "Estado", "common.name": "Nombre", "common.key": "Clave",
  "common.description": "Descripción", "common.created": "Creado", "common.updated": "Actualizado", "common.back": "Volver", "common.run": "Ejecutar",
  "common.retry": "Reintentar", "common.resolve": "Resolver", "common.export": "Exportar", "common.download": "Descargar", "common.filters": "Filtros",
  "common.columns": "Columnas", "common.add": "Añadir", "common.remove": "Quitar", "common.confirm": "Confirmar", "common.total": "Total",
  "common.priority": "Prioridad", "common.type": "Tipo", "common.enabled": "Activo", "common.details": "Detalle", "common.test": "Probar", "common.publish": "Publicar",
  "common.version": "Versión", "common.noAccess": "No tienes permiso para ver esta sección.", "common.confirmDelete": "¿Seguro que quieres eliminarlo?",
  "common.saved": "Guardado", "common.copy": "Copiar", "common.archive": "Archivar", "common.restore": "Restaurar", "common.new": "Nuevo", "common.more": "Más",
  "shell.signOut": "Cerrar sesión", "shell.language": "Idioma", "shell.theme": "Tema", "shell.offline": "Sin conexión: se muestran los últimos datos disponibles", "shell.install": "Instalar aplicación",
  "nav.dashboard": "Panel", "nav.explorer": "Listados", "nav.tasks": "Tareas", "nav.flows": "Flujos", "nav.executions": "Ejecuciones", "nav.integrations": "Integraciones",
  "nav.mappings": "Mapeos", "nav.templates": "Plantillas", "nav.messages": "Mensajes", "nav.alerts": "Alertas", "nav.exports": "Exportaciones", "nav.forms": "Formularios",
  "nav.governance": "Gobernanza", "nav.admin": "Administración", "nav.bi": "Analítica (BI)", "nav.copilot": "Copiloto",
  "nav.group.operations": "Operaciones", "nav.group.automation": "Automatización", "nav.group.communication": "Comunicación", "nav.group.integration": "Integración", "nav.group.control": "Control",
  "login.title": "Acceso a Orquestador", "login.email": "Correo electrónico", "login.sendCode": "Enviar código", "login.code": "Código de 6 dígitos", "login.verify": "Entrar",
  "login.sso": "Entrar con la cuenta corporativa", "login.codeSent": "Te hemos enviado un código a", "login.failed": "No se pudo iniciar sesión",
  "dash.title": "Panel de operaciones", "dash.live": "En vivo", "dash.delegation": "Delegación", "dash.all": "Todas", "dash.drill": "Ver detalle", "dash.updated": "Actualizado",
  "dash.byStatus": "Órdenes de trabajo por estado",
  "explorer.title": "Listados", "explorer.entity": "Lista", "explorer.addFilter": "Añadir filtro", "explorer.saved": "Filtros guardados", "explorer.saveFilter": "Guardar filtro",
  "explorer.rows": "filas", "explorer.page": "Página", "explorer.noFilters": "Sin filtros", "explorer.exportFormat": "Formato", "explorer.exportDone": "Exportación lista",
  "explorer.timeline": "Cronología", "explorer.value": "Valor", "explorer.field": "Campo", "explorer.operator": "Operador",
  "tasks.title": "Bandeja de tareas", "tasks.mine": "Mías", "tasks.unassigned": "Sin asignar", "tasks.overdue": "Vencidas", "tasks.claim": "Coger", "tasks.release": "Soltar",
  "tasks.complete": "Completar", "tasks.reject": "Rechazar", "tasks.comment": "Comentar", "tasks.escalate": "Escalar", "tasks.new": "Nueva tarea", "tasks.sla": "SLA",
  "flows.title": "Biblioteca de flujos", "flows.new": "Nuevo flujo", "flows.open": "Abrir", "flows.published": "Publicado", "flows.draft": "Borrador", "flows.importBpmn": "Importar BPMN",
  "flows.type": "Tipo", "flows.running": "En curso", "flows.versions": "Versiones", "flows.triggers": "Disparadores", "flows.copyOf": "Copiar flujo",
  "editor.save": "Guardar", "editor.simulate": "Simular", "editor.stop": "Detener", "editor.submit": "Enviar a revisión", "editor.approve": "Aprobar", "editor.reject": "Rechazar",
  "editor.publish": "Publicar", "editor.newDraft": "Nuevo borrador", "editor.issues": "Problemas del diagrama", "editor.valid": "Diagrama válido", "editor.readOnly": "Solo lectura: esta versión ya no es un borrador",
  "editor.bpmn": "Exportar BPMN", "editor.rollback": "Volver a esta versión", "editor.back": "Biblioteca",
  "exec.title": "Ejecuciones", "exec.simulated": "Simulada", "exec.timeline": "Cronología", "exec.cancel": "Cancelar", "exec.pause": "Pausar", "exec.resume": "Reanudar",
  "int.title": "Integraciones", "int.health": "Estado de conectores", "int.errors": "Panel de errores", "int.inbox": "Eventos recibidos", "int.outbox": "Llamadas salientes",
  "int.syncs": "Sincronizaciones", "int.backlog": "Pendientes", "int.openErrors": "Errores abiertos", "int.payload": "Datos", "int.replay": "Reprocesar", "int.sync": "Sincronizar", "int.testConn": "Probar conexión",
  "map.title": "Mapeos de datos", "map.new": "Nuevo mapeo", "map.versions": "Versiones", "map.newDraft": "Nuevo borrador", "map.sample": "Datos de ejemplo", "map.result": "Resultado", "map.definition": "Definición (JSON)",
  "tpl.title": "Plantillas de comunicación", "tpl.new": "Nueva plantilla", "tpl.channel": "Canal", "tpl.subject": "Asunto", "tpl.body": "Cuerpo", "tpl.preview": "Vista previa", "tpl.mjml": "Diseño MJML",
  "tpl.compile": "Compilar", "tpl.variables": "Variables", "tpl.draft": "Guardar como borrador", "tpl.published": "Publicada", "tpl.addVersion": "Nueva versión",
  "msg.title": "Mensajes", "msg.to": "Destinatario", "msg.channel": "Canal", "msg.attempts": "Intentos", "msg.sent": "Enviado", "msg.cancel": "Cancelar envío",
  "alerts.title": "Alertas por umbral", "alerts.rules": "Reglas", "alerts.firing": "Activas", "alerts.newRule": "Nueva regla", "alerts.metric": "Indicador", "alerts.operator": "Condición",
  "alerts.threshold": "Umbral", "alerts.severity": "Gravedad", "alerts.recipients": "Destinatarios (correos separados por coma)", "alerts.ack": "Reconocer", "alerts.evaluate": "Evaluar ahora", "alerts.value": "Valor",
  "exports.title": "Exportaciones", "exports.schedules": "Programadas", "exports.history": "Historial", "exports.newSchedule": "Nueva exportación programada", "exports.cron": "Programación (cron)",
  "exports.recipients": "Destinatarios", "exports.runNow": "Ejecutar ahora", "exports.next": "Próxima", "exports.last": "Última",
  "forms.title": "Formularios", "forms.versions": "Versiones", "forms.current": "Vigente", "forms.expired": "Caducada", "forms.source": "Origen",
  "gov.title": "Centro de gobernanza", "gov.overview": "Resumen", "gov.audit": "Auditoría", "gov.gdpr": "Protección de datos", "gov.retention": "Retención", "gov.usage": "Uso de licencias",
  "gov.verify": "Verificar cadena de auditoría", "gov.chainOk": "Cadena íntegra", "gov.chainBroken": "Cadena alterada", "gov.toxic": "Combinaciones de roles incompatibles",
  "gov.exportSubject": "Exportar datos", "gov.erase": "Borrar (anonimizar)", "gov.subjectId": "Identificador de la persona", "gov.subjectType": "Tipo de persona", "gov.reason": "Motivo",
  "gov.eraseWarn": "Irreversible. Los registros legalmente obligatorios se conservan sin vínculo con la persona.", "gov.dryRun": "Simular purga", "gov.runPurge": "Ejecutar purga",
  "gov.customer": "Cliente", "gov.technician": "Técnico", "gov.requests": "Solicitudes tramitadas", "gov.action": "Acción", "gov.actor": "Quién", "gov.when": "Cuándo", "gov.deactivate": "Desactivar licencias",
  "admin.title": "Administración", "admin.users": "Usuarios", "admin.roles": "Roles", "admin.catalogs": "Catálogos", "admin.visitTypes": "Tipos de visita", "admin.queues": "Colas de trabajo",
  "admin.sla": "SLA", "admin.params": "Parámetros", "admin.delegations": "Delegaciones", "admin.zones": "Zonas", "admin.projects": "Proyectos", "admin.channels": "Canales", "admin.connectors": "Conectores", "admin.apiKeys": "Claves API",
  "bi.title": "Analítica (BI)", "bi.notConfigured": "Metabase aún no está conectado. Ejecuta `make bi-bootstrap` en devops.",
  "copilot.title": "Copiloto", "copilot.placeholder": "Pregunta sobre órdenes de trabajo, plazos o legislación…", "copilot.ask": "Preguntar", "copilot.sources": "Fuentes", "copilot.mode.llm": "Modelo de lenguaje", "copilot.mode.retrieval": "Solo búsqueda",
  "copilot.tools": "Consultas realizadas",
} as const;

export type Key = keyof typeof es;
type Dict = Record<Key, string>;

const en: Dict = {
  "app.name": "Orchestrator",
  "common.save": "Save", "common.cancel": "Cancel", "common.create": "Create", "common.edit": "Edit", "common.delete": "Delete",
  "common.close": "Close", "common.search": "Search", "common.refresh": "Refresh", "common.loading": "Loading…", "common.empty": "Nothing to show",
  "common.yes": "Yes", "common.no": "No", "common.actions": "Actions", "common.status": "Status", "common.name": "Name", "common.key": "Key",
  "common.description": "Description", "common.created": "Created", "common.updated": "Updated", "common.back": "Back", "common.run": "Run",
  "common.retry": "Retry", "common.resolve": "Resolve", "common.export": "Export", "common.download": "Download", "common.filters": "Filters",
  "common.columns": "Columns", "common.add": "Add", "common.remove": "Remove", "common.confirm": "Confirm", "common.total": "Total",
  "common.priority": "Priority", "common.type": "Type", "common.enabled": "Enabled", "common.details": "Details", "common.test": "Test", "common.publish": "Publish",
  "common.version": "Version", "common.noAccess": "You do not have permission to see this section.", "common.confirmDelete": "Are you sure you want to delete it?",
  "common.saved": "Saved", "common.copy": "Copy", "common.archive": "Archive", "common.restore": "Restore", "common.new": "New", "common.more": "More",
  "shell.signOut": "Sign out", "shell.language": "Language", "shell.theme": "Theme", "shell.offline": "Offline: showing the latest available data", "shell.install": "Install app",
  "nav.dashboard": "Dashboard", "nav.explorer": "Lists", "nav.tasks": "Tasks", "nav.flows": "Flows", "nav.executions": "Executions", "nav.integrations": "Integrations",
  "nav.mappings": "Mappings", "nav.templates": "Templates", "nav.messages": "Messages", "nav.alerts": "Alerts", "nav.exports": "Exports", "nav.forms": "Forms",
  "nav.governance": "Governance", "nav.admin": "Administration", "nav.bi": "Analytics (BI)", "nav.copilot": "Copilot",
  "nav.group.operations": "Operations", "nav.group.automation": "Automation", "nav.group.communication": "Communication", "nav.group.integration": "Integration", "nav.group.control": "Control",
  "login.title": "Sign in to Orchestrator", "login.email": "Email", "login.sendCode": "Send code", "login.code": "6-digit code", "login.verify": "Sign in",
  "login.sso": "Sign in with your corporate account", "login.codeSent": "We sent a code to", "login.failed": "Could not sign in",
  "dash.title": "Operations dashboard", "dash.live": "Live", "dash.delegation": "Delegation", "dash.all": "All", "dash.drill": "See detail", "dash.updated": "Updated",
  "dash.byStatus": "Work orders by status",
  "explorer.title": "Lists", "explorer.entity": "List", "explorer.addFilter": "Add filter", "explorer.saved": "Saved filters", "explorer.saveFilter": "Save filter",
  "explorer.rows": "rows", "explorer.page": "Page", "explorer.noFilters": "No filters", "explorer.exportFormat": "Format", "explorer.exportDone": "Export ready",
  "explorer.timeline": "Timeline", "explorer.value": "Value", "explorer.field": "Field", "explorer.operator": "Operator",
  "tasks.title": "Task inbox", "tasks.mine": "Mine", "tasks.unassigned": "Unassigned", "tasks.overdue": "Overdue", "tasks.claim": "Claim", "tasks.release": "Release",
  "tasks.complete": "Complete", "tasks.reject": "Reject", "tasks.comment": "Comment", "tasks.escalate": "Escalate", "tasks.new": "New task", "tasks.sla": "SLA",
  "flows.title": "Flow library", "flows.new": "New flow", "flows.open": "Open", "flows.published": "Published", "flows.draft": "Draft", "flows.importBpmn": "Import BPMN",
  "flows.type": "Type", "flows.running": "Running", "flows.versions": "Versions", "flows.triggers": "Triggers", "flows.copyOf": "Copy flow",
  "editor.save": "Save", "editor.simulate": "Simulate", "editor.stop": "Stop", "editor.submit": "Submit for review", "editor.approve": "Approve", "editor.reject": "Reject",
  "editor.publish": "Publish", "editor.newDraft": "New draft", "editor.issues": "Diagram issues", "editor.valid": "Diagram is valid", "editor.readOnly": "Read only: this version is no longer a draft",
  "editor.bpmn": "Export BPMN", "editor.rollback": "Make this version live again", "editor.back": "Library",
  "exec.title": "Executions", "exec.simulated": "Simulated", "exec.timeline": "Timeline", "exec.cancel": "Cancel", "exec.pause": "Pause", "exec.resume": "Resume",
  "int.title": "Integrations", "int.health": "Connector health", "int.errors": "Error panel", "int.inbox": "Received events", "int.outbox": "Outgoing calls",
  "int.syncs": "Synchronisations", "int.backlog": "Backlog", "int.openErrors": "Open errors", "int.payload": "Data", "int.replay": "Reprocess", "int.sync": "Synchronise", "int.testConn": "Test connection",
  "map.title": "Data mappings", "map.new": "New mapping", "map.versions": "Versions", "map.newDraft": "New draft", "map.sample": "Sample data", "map.result": "Result", "map.definition": "Definition (JSON)",
  "tpl.title": "Communication templates", "tpl.new": "New template", "tpl.channel": "Channel", "tpl.subject": "Subject", "tpl.body": "Body", "tpl.preview": "Preview", "tpl.mjml": "MJML design",
  "tpl.compile": "Compile", "tpl.variables": "Variables", "tpl.draft": "Save as draft", "tpl.published": "Published", "tpl.addVersion": "New version",
  "msg.title": "Messages", "msg.to": "Recipient", "msg.channel": "Channel", "msg.attempts": "Attempts", "msg.sent": "Sent", "msg.cancel": "Cancel sending",
  "alerts.title": "Threshold alerts", "alerts.rules": "Rules", "alerts.firing": "Active", "alerts.newRule": "New rule", "alerts.metric": "Indicator", "alerts.operator": "Condition",
  "alerts.threshold": "Threshold", "alerts.severity": "Severity", "alerts.recipients": "Recipients (comma-separated emails)", "alerts.ack": "Acknowledge", "alerts.evaluate": "Evaluate now", "alerts.value": "Value",
  "exports.title": "Exports", "exports.schedules": "Scheduled", "exports.history": "History", "exports.newSchedule": "New scheduled export", "exports.cron": "Schedule (cron)",
  "exports.recipients": "Recipients", "exports.runNow": "Run now", "exports.next": "Next", "exports.last": "Last",
  "forms.title": "Forms", "forms.versions": "Versions", "forms.current": "Current", "forms.expired": "Expired", "forms.source": "Source",
  "gov.title": "Governance centre", "gov.overview": "Overview", "gov.audit": "Audit", "gov.gdpr": "Data protection", "gov.retention": "Retention", "gov.usage": "Licence usage",
  "gov.verify": "Verify the audit chain", "gov.chainOk": "Chain intact", "gov.chainBroken": "Chain tampered", "gov.toxic": "Incompatible role combinations",
  "gov.exportSubject": "Export data", "gov.erase": "Erase (anonymise)", "gov.subjectId": "Person identifier", "gov.subjectType": "Type of person", "gov.reason": "Reason",
  "gov.eraseWarn": "Irreversible. Legally required records are kept with no link to the person.", "gov.dryRun": "Preview purge", "gov.runPurge": "Run purge",
  "gov.customer": "Customer", "gov.technician": "Technician", "gov.requests": "Requests handled", "gov.action": "Action", "gov.actor": "Who", "gov.when": "When", "gov.deactivate": "Deactivate licences",
  "admin.title": "Administration", "admin.users": "Users", "admin.roles": "Roles", "admin.catalogs": "Catalogues", "admin.visitTypes": "Visit types", "admin.queues": "Work queues",
  "admin.sla": "SLA", "admin.params": "Parameters", "admin.delegations": "Delegations", "admin.zones": "Zones", "admin.projects": "Projects", "admin.channels": "Channels", "admin.connectors": "Connectors", "admin.apiKeys": "API keys",
  "bi.title": "Analytics (BI)", "bi.notConfigured": "Metabase is not connected yet. Run `make bi-bootstrap` in devops.",
  "copilot.title": "Copilot", "copilot.placeholder": "Ask about work orders, deadlines or legislation…", "copilot.ask": "Ask", "copilot.sources": "Sources", "copilot.mode.llm": "Language model", "copilot.mode.retrieval": "Search only",
  "copilot.tools": "Lookups made",
};

const ca: Dict = {
  "app.name": "Orquestrador",
  "common.save": "Desa", "common.cancel": "Cancel·la", "common.create": "Crea", "common.edit": "Edita", "common.delete": "Elimina",
  "common.close": "Tanca", "common.search": "Cerca", "common.refresh": "Actualitza", "common.loading": "Carregant…", "common.empty": "Res a mostrar",
  "common.yes": "Sí", "common.no": "No", "common.actions": "Accions", "common.status": "Estat", "common.name": "Nom", "common.key": "Clau",
  "common.description": "Descripció", "common.created": "Creat", "common.updated": "Actualitzat", "common.back": "Torna", "common.run": "Executa",
  "common.retry": "Reintenta", "common.resolve": "Resol", "common.export": "Exporta", "common.download": "Descarrega", "common.filters": "Filtres",
  "common.columns": "Columnes", "common.add": "Afegeix", "common.remove": "Treu", "common.confirm": "Confirma", "common.total": "Total",
  "common.priority": "Prioritat", "common.type": "Tipus", "common.enabled": "Actiu", "common.details": "Detall", "common.test": "Prova", "common.publish": "Publica",
  "common.version": "Versió", "common.noAccess": "No tens permís per veure aquesta secció.", "common.confirmDelete": "Segur que ho vols eliminar?",
  "common.saved": "Desat", "common.copy": "Copia", "common.archive": "Arxiva", "common.restore": "Restaura", "common.new": "Nou", "common.more": "Més",
  "shell.signOut": "Tanca la sessió", "shell.language": "Idioma", "shell.theme": "Tema", "shell.offline": "Sense connexió: es mostren les últimes dades disponibles", "shell.install": "Instal·la l'aplicació",
  "nav.dashboard": "Tauler", "nav.explorer": "Llistats", "nav.tasks": "Tasques", "nav.flows": "Fluxos", "nav.executions": "Execucions", "nav.integrations": "Integracions",
  "nav.mappings": "Mapatges", "nav.templates": "Plantilles", "nav.messages": "Missatges", "nav.alerts": "Alertes", "nav.exports": "Exportacions", "nav.forms": "Formularis",
  "nav.governance": "Governança", "nav.admin": "Administració", "nav.bi": "Analítica (BI)", "nav.copilot": "Copilot",
  "nav.group.operations": "Operacions", "nav.group.automation": "Automatització", "nav.group.communication": "Comunicació", "nav.group.integration": "Integració", "nav.group.control": "Control",
  "login.title": "Accés a Orquestrador", "login.email": "Correu electrònic", "login.sendCode": "Envia el codi", "login.code": "Codi de 6 dígits", "login.verify": "Entra",
  "login.sso": "Entra amb el compte corporatiu", "login.codeSent": "Hem enviat un codi a", "login.failed": "No s'ha pogut iniciar la sessió",
  "dash.title": "Tauler d'operacions", "dash.live": "En directe", "dash.delegation": "Delegació", "dash.all": "Totes", "dash.drill": "Veure detall", "dash.updated": "Actualitzat",
  "dash.byStatus": "Ordres de treball per estat",
  "explorer.title": "Llistats", "explorer.entity": "Llista", "explorer.addFilter": "Afegeix filtre", "explorer.saved": "Filtres desats", "explorer.saveFilter": "Desa el filtre",
  "explorer.rows": "files", "explorer.page": "Pàgina", "explorer.noFilters": "Sense filtres", "explorer.exportFormat": "Format", "explorer.exportDone": "Exportació llesta",
  "explorer.timeline": "Cronologia", "explorer.value": "Valor", "explorer.field": "Camp", "explorer.operator": "Operador",
  "tasks.title": "Safata de tasques", "tasks.mine": "Meves", "tasks.unassigned": "Sense assignar", "tasks.overdue": "Vençudes", "tasks.claim": "Agafa", "tasks.release": "Deixa anar",
  "tasks.complete": "Completa", "tasks.reject": "Rebutja", "tasks.comment": "Comenta", "tasks.escalate": "Escala", "tasks.new": "Nova tasca", "tasks.sla": "SLA",
  "flows.title": "Biblioteca de fluxos", "flows.new": "Nou flux", "flows.open": "Obre", "flows.published": "Publicat", "flows.draft": "Esborrany", "flows.importBpmn": "Importa BPMN",
  "flows.type": "Tipus", "flows.running": "En curs", "flows.versions": "Versions", "flows.triggers": "Activadors", "flows.copyOf": "Copia el flux",
  "editor.save": "Desa", "editor.simulate": "Simula", "editor.stop": "Atura", "editor.submit": "Envia a revisió", "editor.approve": "Aprova", "editor.reject": "Rebutja",
  "editor.publish": "Publica", "editor.newDraft": "Nou esborrany", "editor.issues": "Problemes del diagrama", "editor.valid": "Diagrama vàlid", "editor.readOnly": "Només lectura: aquesta versió ja no és un esborrany",
  "editor.bpmn": "Exporta BPMN", "editor.rollback": "Torna a aquesta versió", "editor.back": "Biblioteca",
  "exec.title": "Execucions", "exec.simulated": "Simulada", "exec.timeline": "Cronologia", "exec.cancel": "Cancel·la", "exec.pause": "Pausa", "exec.resume": "Represa",
  "int.title": "Integracions", "int.health": "Estat dels connectors", "int.errors": "Panell d'errors", "int.inbox": "Esdeveniments rebuts", "int.outbox": "Trucades sortints",
  "int.syncs": "Sincronitzacions", "int.backlog": "Pendents", "int.openErrors": "Errors oberts", "int.payload": "Dades", "int.replay": "Reprocessa", "int.sync": "Sincronitza", "int.testConn": "Prova la connexió",
  "map.title": "Mapatges de dades", "map.new": "Nou mapatge", "map.versions": "Versions", "map.newDraft": "Nou esborrany", "map.sample": "Dades d'exemple", "map.result": "Resultat", "map.definition": "Definició (JSON)",
  "tpl.title": "Plantilles de comunicació", "tpl.new": "Nova plantilla", "tpl.channel": "Canal", "tpl.subject": "Assumpte", "tpl.body": "Cos", "tpl.preview": "Previsualització", "tpl.mjml": "Disseny MJML",
  "tpl.compile": "Compila", "tpl.variables": "Variables", "tpl.draft": "Desa com a esborrany", "tpl.published": "Publicada", "tpl.addVersion": "Nova versió",
  "msg.title": "Missatges", "msg.to": "Destinatari", "msg.channel": "Canal", "msg.attempts": "Intents", "msg.sent": "Enviat", "msg.cancel": "Cancel·la l'enviament",
  "alerts.title": "Alertes per llindar", "alerts.rules": "Regles", "alerts.firing": "Actives", "alerts.newRule": "Nova regla", "alerts.metric": "Indicador", "alerts.operator": "Condició",
  "alerts.threshold": "Llindar", "alerts.severity": "Gravetat", "alerts.recipients": "Destinataris (correus separats per coma)", "alerts.ack": "Reconeix", "alerts.evaluate": "Avalua ara", "alerts.value": "Valor",
  "exports.title": "Exportacions", "exports.schedules": "Programades", "exports.history": "Historial", "exports.newSchedule": "Nova exportació programada", "exports.cron": "Programació (cron)",
  "exports.recipients": "Destinataris", "exports.runNow": "Executa ara", "exports.next": "Propera", "exports.last": "Darrera",
  "forms.title": "Formularis", "forms.versions": "Versions", "forms.current": "Vigent", "forms.expired": "Caducada", "forms.source": "Origen",
  "gov.title": "Centre de governança", "gov.overview": "Resum", "gov.audit": "Auditoria", "gov.gdpr": "Protecció de dades", "gov.retention": "Retenció", "gov.usage": "Ús de llicències",
  "gov.verify": "Verifica la cadena d'auditoria", "gov.chainOk": "Cadena íntegra", "gov.chainBroken": "Cadena alterada", "gov.toxic": "Combinacions de rols incompatibles",
  "gov.exportSubject": "Exporta les dades", "gov.erase": "Esborra (anonimitza)", "gov.subjectId": "Identificador de la persona", "gov.subjectType": "Tipus de persona", "gov.reason": "Motiu",
  "gov.eraseWarn": "Irreversible. Els registres legalment obligatoris es conserven sense vincle amb la persona.", "gov.dryRun": "Simula la purga", "gov.runPurge": "Executa la purga",
  "gov.customer": "Client", "gov.technician": "Tècnic", "gov.requests": "Sol·licituds tramitades", "gov.action": "Acció", "gov.actor": "Qui", "gov.when": "Quan", "gov.deactivate": "Desactiva llicències",
  "admin.title": "Administració", "admin.users": "Usuaris", "admin.roles": "Rols", "admin.catalogs": "Catàlegs", "admin.visitTypes": "Tipus de visita", "admin.queues": "Cues de treball",
  "admin.sla": "SLA", "admin.params": "Paràmetres", "admin.delegations": "Delegacions", "admin.zones": "Zones", "admin.projects": "Projectes", "admin.channels": "Canals", "admin.connectors": "Connectors", "admin.apiKeys": "Claus API",
  "bi.title": "Analítica (BI)", "bi.notConfigured": "Metabase encara no està connectat. Executa `make bi-bootstrap` a devops.",
  "copilot.title": "Copilot", "copilot.placeholder": "Pregunta sobre ordres de treball, terminis o legislació…", "copilot.ask": "Pregunta", "copilot.sources": "Fonts", "copilot.mode.llm": "Model de llenguatge", "copilot.mode.retrieval": "Només cerca",
  "copilot.tools": "Consultes fetes",
};

const dictionaries: Record<Locale, Dict> = { es, en, ca };

// Spanish is the product default regardless of the browser language; only an explicit choice
// made with the language switch (persisted in localStorage) overrides it.
const initial = (): Locale => {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("orq.locale") : null;
  const locale: Locale = saved === "en" || saved === "ca" ? saved : "es";
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  return locale;
};

export const useLocale = create<{ locale: Locale; set: (l: Locale) => void }>((set) => ({
  locale: initial(),
  set: (locale) => {
    localStorage.setItem("orq.locale", locale);
    document.documentElement.lang = locale;
    set({ locale });
    if (useAuthStore.getState().user) void fetch("/api/v1/auth/me", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) });
  },
}));

export function translate(locale: Locale, key: Key, vars?: Record<string, string | number>) {
  let text = dictionaries[locale][key] ?? es[key];
  for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, String(v));
  return text;
}

export function useT() {
  const locale = useLocale((s) => s.locale);
  return (key: Key, vars?: Record<string, string | number>) => translate(locale, key, vars);
}

export const useDateFormat = () => {
  const locale = useLocale((s) => s.locale);
  return (value: unknown, withTime = true) => {
    if (!value) return "—";
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(locale === "ca" ? "ca-ES" : locale === "en" ? "en-GB" : "es-ES", withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" });
  };
};
