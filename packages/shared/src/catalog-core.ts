import { registerNodeDefinitions, type FieldDef, type NodeDefinition } from "./catalog.js";

const str = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "string", label, ...extra });
const text = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "text", label, rows: 3, ...extra });
const num = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "number", label, ...extra });
const dur = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "duration", label, placeholder: "30m, 4h, 3d", ...extra });
const bool = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "boolean", label, default: false, ...extra });
const json = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, type: "json", label, rows: 4, ...extra });
const select = (key: string, label: string, options: [string, string][], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  type: "select",
  label,
  options: options.map(([value, l]) => ({ value, label: l })),
  ...extra,
});

export const PRIORITY_OPTIONS: [string, string][] = [["low", "Baja"], ["medium", "Media"], ["high", "Alta"], ["urgent", "Urgente"]];

/** SLA / deadline fields shared by every node that waits for a person or a system. */
const waitingFields = (): FieldDef[] => [
  dur("warnAfter", "Aviso de SLA tras", { help: "Genera un aviso (sla.warning) transcurrido este tiempo" }),
  dur("breachAfter", "Incumplimiento de SLA tras", { help: "Marca el SLA como incumplido (sla.breached)" }),
  dur("timeout", "Caducar tras", { help: "Al caducar, el flujo sigue por la salida «timeout»" }),
  bool("businessHours", "Contar sólo horas hábiles", { help: "Calendario laboral y festivos de la delegación" }),
];

const taskFields = (): FieldDef[] => [
  str("title", "Título de la tarea", { required: true, default: "Revisar {{entity.number}}" }),
  text("instructions", "Instrucciones"),
  str("queue", "Cola de trabajo", { placeholder: "clave de la cola (p. ej. backoffice-general)" }),
  str("assigneeEmail", "Responsable (correo)", { placeholder: "persona@empresa.com o {{variables.owner}}" }),
  select("priority", "Prioridad", PRIORITY_OPTIONS, { default: "medium" }),
  str("formKey", "Formulario", { placeholder: "clave del formulario (opcional)" }),
  dur("dueIn", "Vence en"),
  ...waitingFields(),
];

const errorFree = { noErrorPolicy: true } as const;

const definitions: NodeDefinition[] = [
  // ───────────── start ─────────────
  {
    type: "flow.trigger", label: "Disparador", description: "Inicio de una ejecución duradera (evento, webhook, programación o transición de estado)", icon: "Lightning",
    group: "start", start: true, kind: "inline", fields: [], ...errorFree,
  },

  // ───────────── control ─────────────
  {
    type: "flow.condition", label: "Condición", description: "Verdadero / falso sobre una comparación", icon: "GitBranch", group: "control", kind: "inline",
    ports: ["true", "false"], portLabels: { true: "sí", false: "no" }, branching: true,
    fields: [
      str("left", "Izquierda", { required: true, default: "{{variables.value}}" }),
      select("operator", "Operador", [["truthy", "Verdadero"], ["eq", "Igual"], ["neq", "Distinto"], ["contains", "Contiene"], ["gt", "Mayor que"], ["lt", "Menor que"]], { default: "eq", required: true }),
      str("right", "Derecha"),
    ],
  },
  {
    type: "flow.switch", label: "Selector", description: "Enruta por coincidencia exacta con hasta cinco casos", icon: "TreeStructure", group: "control", kind: "inline",
    ports: ["c1", "c2", "c3", "c4", "c5", "default"], portLabels: { c1: "caso 1", c2: "caso 2", c3: "caso 3", c4: "caso 4", c5: "caso 5", default: "otro" }, branching: true,
    fields: [
      str("value", "Valor", { required: true, default: "{{variables.value}}" }),
      str("case1", "Caso 1"), str("case2", "Caso 2"), str("case3", "Caso 3"), str("case4", "Caso 4"), str("case5", "Caso 5"),
    ],
  },
  { type: "flow.parallel", label: "Paralelo (dividir)", description: "Lanza varias ramas a la vez", icon: "ArrowsSplit", group: "control", kind: "inline", fields: [], ...errorFree },
  { type: "flow.join", label: "Unir (todas)", description: "Espera a todas las ramas activas (AND)", icon: "ArrowsMerge", group: "control", kind: "inline", join: "all", fields: [], ...errorFree },
  { type: "flow.join-any", label: "Unir (primera)", description: "Continúa con la primera rama que llegue (OR)", icon: "ArrowsMerge", group: "control", kind: "inline", join: "any", fields: [], ...errorFree },
  {
    type: "flow.set-variable", label: "Variable", description: "Guarda un valor con nombre para los nodos siguientes", icon: "Cube", group: "control", kind: "inline",
    fields: [str("name", "Nombre", { required: true, default: "score" }), text("value", "Valor", { required: true, default: "{{trigger.value}}" })],
  },
  {
    type: "flow.transform", label: "Transformar", description: "Compone un valor a partir de plantillas", icon: "MagicWand", group: "control", kind: "inline",
    fields: [text("template", "Plantilla", { required: true, default: "{{trigger}}" })],
  },
  {
    type: "flow.log", label: "Registro", description: "Escribe un mensaje en la línea de tiempo de la ejecución", icon: "List", group: "control", kind: "inline",
    fields: [text("message", "Mensaje", { default: "hecho: {{trigger}}" })],
  },
  {
    type: "flow.subprocess", label: "Subproceso", description: "Ejecuta otro flujo publicado como proceso hijo", icon: "TreeView", group: "control", kind: "subprocess",
    fields: [
      str("flowId", "Flujo (id o clave)", { required: true }),
      num("version", "Versión", { help: "Vacío = última publicada", min: 1 }),
      select("mode", "Modo", [["wait", "Esperar al resultado"], ["detach", "Lanzar y continuar"]], { default: "wait" }),
      json("input", "Entrada (JSON)", { default: "{}" }),
    ],
  },
  {
    type: "flow.end", label: "Fin", description: "Termina el flujo con un resultado", icon: "FlagCheckered", group: "control", kind: "end", ...errorFree,
    fields: [
      select("status", "Estado final", [["completed", "Completado"], ["failed", "Fallido"], ["cancelled", "Cancelado"]], { default: "completed" }),
      str("outcomeValue", "Resultado (p. ej. conforme)"),
      text("message", "Mensaje", { rows: 2 }),
      bool("terminate", "Terminar el resto de ramas"),
    ],
  },

  // ───────────── time ─────────────
  {
    type: "flow.timer", label: "Temporizador", description: "Espera una duración o hasta una fecha, opcionalmente en horas hábiles", icon: "Hourglass", group: "time", kind: "timer",
    ...errorFree,
    fields: [
      dur("duration", "Duración", { default: "1h" }),
      str("until", "…o hasta (fecha ISO)", { placeholder: "2026-12-31T09:00:00Z o {{variables.dueDate}}" }),
      bool("businessHours", "Contar sólo horas hábiles"),
    ],
  },
  {
    type: "flow.wait-event", label: "Esperar evento", description: "Pausa hasta que llegue un evento externo (con caducidad opcional)", icon: "Broadcast", group: "time", kind: "wait",
    ports: ["received", "timeout"], portLabels: { received: "recibido", timeout: "caducado" }, branching: true,
    required: ["eventName"],
    fields: [str("eventName", "Nombre del evento", { required: true, placeholder: "certificado.firmado" }), str("correlation", "Correlación", { placeholder: "{{entity.id}}" }), ...waitingFields()],
  },
  {
    type: "flow.pause", label: "Pausa manual", description: "Detiene el flujo hasta que un operador lo reanude", icon: "PauseCircle", group: "time", kind: "wait",
    ports: ["resumed", "timeout"], portLabels: { resumed: "reanudado", timeout: "caducado" }, branching: true,
    fields: [text("reason", "Motivo", { rows: 2 }), ...waitingFields()],
  },

  // ───────────── human work ─────────────
  {
    type: "human.user-task", label: "Tarea de usuario", description: "Crea una tarea en una cola de trabajo y espera a que se resuelva", icon: "User", group: "human", kind: "wait",
    queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    ports: ["done", "rejected", "timeout"], portLabels: { done: "hecha", rejected: "rechazada", timeout: "caducada" }, branching: true,
    fields: taskFields(),
  },
  {
    type: "human.approval", label: "Aprobación", description: "Una persona aprueba o rechaza (con segunda validación opcional)", icon: "SealCheck", group: "human", kind: "wait",
    queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    ports: ["approved", "rejected", "timeout"], portLabels: { approved: "aprobada", rejected: "rechazada", timeout: "caducada" }, branching: true,
    fields: [
      ...taskFields().map((f) => (f.key === "title" ? { ...f, default: "Aprobar {{entity.number}}" } : f)),
      str("approverRole", "Rol aprobador", { placeholder: "supervisor, director_tecnico…" }),
      bool("secondValidation", "Requiere segunda validación (cuatro ojos)", { help: "Alta tensión: una segunda persona distinta debe confirmar" }),
    ],
  },
  {
    type: "human.subtask", label: "Subtareas", description: "Crea varias subtareas y espera a que se cierren todas", icon: "ListChecks", group: "human", kind: "wait",
    queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    ports: ["done", "timeout"], portLabels: { done: "todas hechas", timeout: "caducadas" }, branching: true,
    fields: [
      str("title", "Título base", { required: true, default: "Subtarea de {{entity.number}}" }),
      json("items", "Subtareas (JSON: lista de textos o de objetos)", { required: true, default: '["Revisar documentación","Confirmar con el cliente"]' }),
      str("queue", "Cola de trabajo"),
      str("assigneeEmail", "Responsable (correo)"),
      select("priority", "Prioridad", PRIORITY_OPTIONS, { default: "medium" }),
      ...waitingFields(),
    ],
  },

  // ───────────── communications ─────────────
  {
    type: "comm.notify", label: "Notificar", description: "Envía un mensaje por el canal de la delegación (correo, SMS, WhatsApp, push)", icon: "EnvelopeSimple", group: "comms", kind: "activity",
    queue: "notifications", startToCloseTimeout: "30s", retry: { maximumAttempts: 5, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "5m" },
    required: ["to"],
    fields: [
      select("channel", "Canal", [["email", "Correo"], ["sms", "SMS"], ["whatsapp", "WhatsApp"], ["push", "Push"], ["internal", "Interno"]], { default: "email", required: true }),
      str("to", "Destinatario", { required: true, placeholder: "{{entity.customerEmail}}" }),
      str("templateKey", "Plantilla", { placeholder: "clave de plantilla (opcional)" }),
      str("subject", "Asunto"),
      text("body", "Mensaje", { default: "Hola, su inspección {{entity.number}} está programada." }),
      json("variables", "Variables de plantilla (JSON)", { default: "{}" }),
      str("language", "Idioma", { placeholder: "es, en, ca" }),
    ],
  },
  {
    type: "comm.webhook", label: "Webhook saliente", description: "Llama a un sistema externo con firma HMAC (reintentos y bandeja de salida)", icon: "WebhooksLogo", group: "comms", kind: "activity",
    queue: "integrations", startToCloseTimeout: "45s", retry: { maximumAttempts: 6, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "10m" },
    required: ["url"],
    fields: [
      str("url", "URL", { required: true, placeholder: "https://…" }),
      select("method", "Método", [["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"]], { default: "POST" }),
      text("body", "Cuerpo JSON", { default: '{"entity":"{{entity.id}}"}' }),
      str("secretRef", "Secreto de firma (referencia)", { placeholder: "connectors/mi-sistema/webhook" }),
    ],
  },

  // ───────────── integration ─────────────
  {
    type: "int.http", label: "Petición HTTP", description: "Llama a un endpoint HTTP (reintenta 429/5xx)", icon: "Globe", group: "integration", kind: "activity",
    queue: "integrations", startToCloseTimeout: "45s", retry: { maximumAttempts: 3 },
    required: ["url"],
    fields: [
      str("url", "URL", { required: true, placeholder: "https://…" }),
      select("method", "Método", [["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]], { default: "GET", required: true }),
      text("body", "Cuerpo"),
      json("headersJson", "Cabeceras (JSON)", { default: "" }),
      num("delayMs", "Retraso (ms)", { min: 0, max: 60000 }),
    ],
  },

  {
    type: "int.call", label: "Llamar a conector", description: "Ejecuta una acción de un conector (HubSpot, ERP, planificador…) con reintentos, idempotencia y bandeja de salida", icon: "PlugsConnected", group: "integration", kind: "activity",
    queue: "integrations", startToCloseTimeout: "60s", retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2m" },
    required: ["connector", "action"],
    fields: [
      str("connector", "Conector", { required: true, placeholder: "clave del conector" }),
      str("action", "Acción", { required: true, placeholder: "p. ej. request, push-order" }),
      json("input", "Datos de entrada (JSON)", { default: "{}" }),
      select("mode", "Modo", [["sync", "Síncrono (espera la respuesta)"], ["async", "Asíncrono (bandeja de salida)"]], { default: "sync" }),
      str("idempotencyKey", "Clave de idempotencia", { placeholder: "vacío = ejecución + nodo" }),
      str("variable", "Guardar respuesta en", { default: "integration", placeholder: "integration" }),
    ],
  },
  {
    type: "int.map", label: "Aplicar mapeo", description: "Transforma datos con un mapeo versionado del registro (campo a campo)", icon: "ArrowsMerge", group: "integration", kind: "activity",
    queue: "integrations", startToCloseTimeout: "20s", retry: { maximumAttempts: 2 },
    required: ["mapping"],
    fields: [
      str("mapping", "Mapeo", { required: true, placeholder: "clave del mapeo publicado" }),
      json("source", "Datos de origen (JSON)", { default: "{{trigger.payload}}" }),
      bool("passthroughExtra", "Pasar campos no mapeados a «extra»"),
      str("passthroughFrom", "Objeto del que copiar los campos sin mapear", { placeholder: "p. ej. properties" }),
      str("variable", "Guardar resultado en", { default: "mapped", placeholder: "mapped" }),
    ],
  },

  // ───────────── data ─────────────
  {
    type: "data.entity-update", label: "Actualizar entidad", description: "Cambia campos de una orden, visita, no conformidad, certificado o línea de facturación", icon: "PencilSimpleLine", group: "data", kind: "activity",
    queue: "flows", startToCloseTimeout: "20s", retry: { maximumAttempts: 3 },
    required: ["entity", "fields"],
    fields: [
      select("entity", "Entidad", [["orders", "Pedido"], ["work_orders", "Orden de trabajo"], ["visits", "Visita"], ["nonconformities", "No conformidad"], ["certificates", "Certificado"], ["billing_lines", "Línea de facturación"]], { required: true }),
      str("id", "Id del registro", { placeholder: "vacío = entidad del flujo", help: "Por defecto, la entidad con la que se lanzó el flujo" }),
      json("fields", "Campos a cambiar (JSON)", { required: true, default: '{"status":"in_progress"}' }),
    ],
  },

  {
    type: "data.entity-create", label: "Crear registro", description: "Crea un certificado, una línea de facturación o una no conformidad ligada a la OT", icon: "PlusCircle", group: "data", kind: "activity",
    queue: "flows", startToCloseTimeout: "20s", retry: { maximumAttempts: 3 },
    required: ["entity"],
    fields: [
      select("entity", "Registro", [["certificates", "Certificado"], ["billing_lines", "Línea de facturación"], ["nonconformities", "No conformidad"]], { required: true }),
      str("workOrderId", "Id de la OT", { placeholder: "vacío = OT del flujo" }),
      json("fields", "Campos (JSON)", { default: "{}" }),
      str("variable", "Guardar resultado en", { default: "created", placeholder: "created" }),
    ],
  },
  {
    type: "data.load-entity", label: "Cargar entidad", description: "Carga los datos de la entidad del flujo (cliente, instalación, técnico, plazos) para usarlos como {{entity.…}}", icon: "Database", group: "data", kind: "activity",
    queue: "flows", startToCloseTimeout: "20s", retry: { maximumAttempts: 3 },
    fields: [
      select("entityType", "Tipo de entidad", [["", "La del flujo"], ["order", "Pedido"], ["work_order", "Orden de trabajo"], ["visit", "Visita"], ["nonconformity", "No conformidad"], ["certificate", "Certificado"]], { default: "" }),
      str("id", "Id de la entidad", { placeholder: "vacío = entidad del flujo" }),
    ],
  },
  {
    type: "data.query", label: "Consultar datos", description: "Ejecuta una consulta filtrada (mismo lenguaje que las listas) y guarda filas, recuento y texto resumen", icon: "MagnifyingGlass", group: "data", kind: "activity",
    queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    required: ["entity"],
    fields: [
      str("entity", "Entidad", { required: true, placeholder: "work_orders, visits, qualifications, tasks…" }),
      json("filter", "Filtro (JSON)", { help: "Mismo lenguaje que los filtros guardados; admite fechas relativas (today, +30d)" }),
      num("limit", "Máximo de filas", { min: 1, max: 500, default: 100 }),
      str("lineTemplate", "Plantilla de línea", { placeholder: "{{entity.technician}} · {{entity.kind}} · {{entity.valid_to}}" }),
      str("variable", "Guardar en variable", { default: "query", help: "Disponible como {{variables.<nombre>.count}}, .text y .lines" }),
    ],
  },

  // ───────────── rules & state ─────────────
  {
    type: "flow.rule", label: "Regla", description: "Evalúa un conjunto de reglas (si-entonces) y enruta por «sí» o «no»", icon: "Scales", group: "control", kind: "inline",
    ports: ["true", "false"], portLabels: { true: "se cumple", false: "no se cumple" }, branching: true,
    fields: [
      str("ruleSet", "Conjunto de reglas", { placeholder: "clave del conjunto publicado (se fija al publicar el flujo)" }),
      json("definition", "…o reglas en línea (JSON)", { help: "Se usa si no hay conjunto publicado; editor visual en el panel de propiedades" }),
    ],
  },
  {
    type: "flow.decision-table", label: "Tabla de decisión", description: "Resuelve valores de salida con una tabla de decisión y los guarda como variables", icon: "Table", group: "control", kind: "inline",
    ports: ["true", "false"], portLabels: { true: "hay coincidencia", false: "sin coincidencia" }, branching: true,
    fields: [
      str("table", "Tabla de decisión", { placeholder: "clave de la tabla publicada" }),
      json("definition", "…o tabla en línea (JSON)"),
      str("prefix", "Prefijo de variables", { placeholder: "vacío = sin prefijo", help: "Las salidas se guardan como variables (prefijo + clave)" }),
    ],
  },
  {
    type: "state.transition", label: "Cambiar estado", description: "Mueve la entidad a otro estado con su máquina de estados (guardas, roles, acciones)", icon: "ArrowsLeftRight", group: "state", kind: "activity",
    queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    required: ["to"],
    fields: [
      str("entityType", "Tipo de entidad", { placeholder: "vacío = la del flujo", help: "work_order, visit, nonconformity, certificate…" }),
      str("id", "Id de la entidad", { placeholder: "vacío = entidad del flujo" }),
      str("to", "Estado destino", { required: true, placeholder: "planned" }),
      str("transition", "Transición (clave)", { help: "Opcional: fuerza una transición concreta" }),
      json("payload", "Datos de la transición (JSON)", { default: "{}" }),
    ],
  },
];

registerNodeDefinitions(definitions);

/** Proof-of-concept node types: kept (hidden from the palette) so stored diagrams keep running. */
const legacy: NodeDefinition[] = [
  { type: "poc/trigger", label: "Disparador", description: "", icon: "Lightning", group: "legacy", hidden: true, start: true, kind: "inline", fields: [], noErrorPolicy: true },
  { type: "poc/condition", label: "Condición", description: "", icon: "GitBranch", group: "legacy", hidden: true, kind: "inline", ports: ["true", "false"], branching: true, fields: [] },
  { type: "poc/decision", label: "Decisión", description: "", icon: "GitBranch", group: "legacy", hidden: true, kind: "inline", ports: ["true", "false"], branching: true, fields: [] },
  { type: "poc/switch", label: "Selector", description: "", icon: "TreeStructure", group: "legacy", hidden: true, kind: "inline", ports: ["one", "two", "three", "default"], branching: true, fields: [] },
  { type: "poc/set-variable", label: "Variable", description: "", icon: "Cube", group: "legacy", hidden: true, kind: "inline", fields: [] },
  { type: "poc/transform", label: "Transformar", description: "", icon: "MagicWand", group: "legacy", hidden: true, kind: "inline", fields: [] },
  { type: "poc/log", label: "Registro", description: "", icon: "List", group: "legacy", hidden: true, kind: "inline", fields: [] },
  { type: "poc/wait", label: "Esperar", description: "", icon: "Hourglass", group: "legacy", hidden: true, kind: "timer", fields: [] },
  {
    type: "poc/approval", label: "Aprobación", description: "", icon: "User", group: "legacy", hidden: true, kind: "wait", queue: "flows", startToCloseTimeout: "30s", retry: { maximumAttempts: 3 },
    ports: ["approved", "rejected"], branching: true, fields: [],
  },
  { type: "poc/http-request", label: "Petición HTTP", description: "", icon: "Globe", group: "legacy", hidden: true, kind: "activity", queue: "integrations", startToCloseTimeout: "45s", retry: { maximumAttempts: 3 }, required: ["url"], fields: [] },
  { type: "poc/flaky", label: "Inestable", description: "", icon: "Warning", group: "legacy", hidden: true, kind: "activity", queue: "integrations", startToCloseTimeout: "20s", retry: { maximumAttempts: 5 }, fields: [] },
  { type: "poc/notify", label: "Notificar", description: "", icon: "EnvelopeSimple", group: "legacy", hidden: true, kind: "activity", queue: "notifications", startToCloseTimeout: "15s", retry: { maximumAttempts: 3 }, fields: [] },
  { type: "poc/create-ticket", label: "Crear ticket", description: "", icon: "Ticket", group: "legacy", hidden: true, kind: "activity", queue: "flows", startToCloseTimeout: "15s", retry: { maximumAttempts: 3 }, required: ["title"], fields: [] },
];
registerNodeDefinitions(legacy);

export const CORE_NODE_TYPES = definitions.map((d) => d.type);
