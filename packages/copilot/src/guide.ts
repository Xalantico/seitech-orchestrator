import type pg from "pg";

import { upsertKnowledge, type KnowledgeDoc } from "./knowledge.js";

/**
 * Platform guide: how this system behaves, written from the implementation so the copilot can answer "how do I..." and
 * "what happens when..." questions. Legislation is different: it must come from the official texts, so it is loaded by an
 * administrator (`POST /copilot/knowledge`) and never shipped as our own summary.
 */
export const PLATFORM_GUIDE: KnowledgeDoc[] = [
  {
    source: "guide", ref: "visit-lifecycle", title: "Ciclo de vida de una visita",
    content: `Una visita pasa por los estados: creada, programada, en curso, completada. También puede quedar con incidencia o cancelada.
Se programa asignando técnico y fecha (el sistema propone la duración según el tipo de visita). Al completarse se registra el resultado: favorable, condicionado, desfavorable, parcial o fallido.

Un resultado desfavorable o condicionado puede crear una no conformidad y sugerir una segunda visita, enlazada a la anterior y a la orden de trabajo, con plazo legal.`,
  },
  {
    source: "guide", ref: "nonconformity", title: "No conformidades",
    content: `Estados de una no conformidad: detectada, comunicada, en subsanación, verificación, escalada y cerrada.
Al detectarla se informa al cliente y se fija un plazo de subsanación. Si el plazo vence sin subsanar, la no conformidad se escala y aparece en las colas de trabajo del back office. Al verificarla se cierra y se puede emitir el certificado.`,
  },
  {
    source: "guide", ref: "queues", title: "Colas de trabajo y tareas",
    content: `Las tareas manuales (incidencias, errores de integración, lotes a subir a las administraciones, firmas rechazadas) llegan a colas: lotes, integraciones, backoffice, certificación y otras. Cada cola tiene un SLA; la tarea muestra cuánto falta para incumplirlo.
Desde la tarea se puede reclamar, reasignar, adjuntar ficheros y ejecutar las acciones disponibles (reintentar una integración, avanzar un estado, completar un formulario).`,
  },
  {
    source: "guide", ref: "integration-errors", title: "Errores de integración",
    content: `Cuando una llamada a un sistema externo falla de forma permanente (por ejemplo, datos rechazados) se crea un error de integración y una tarea en la cola de integraciones. Los fallos temporales (red, límites de uso, errores 5xx) se reintentan automáticamente con espera creciente.
Desde la tarea se puede corregir el dato y reintentar, o descartar el error. El mapeo de campos entre sistemas es versionado: un cambio de mapeo no afecta a lo ya procesado.`,
  },
  {
    source: "guide", ref: "exports-alerts", title: "Exportaciones programadas y alertas",
    content: `Cualquier listado filtrado se puede exportar a Excel, CSV o PDF. Una exportación programada repite la consulta con una periodicidad (expresión cron) y envía por correo un enlace de descarga que caduca; los datos se leen con los permisos y el alcance de quien creó la programación.
Las alertas vigilan un indicador del panel (por ejemplo, OT vencidas) y se disparan al cruzar un umbral. Se avisa por correo, no se repite hasta pasado el tiempo de reaviso, y se cierran solas cuando el indicador vuelve a la normalidad.`,
  },
  {
    source: "guide", ref: "gdpr", title: "Protección de datos: acceso y supresión",
    content: `Para atender una solicitud de acceso o portabilidad se exportan todos los datos de una persona (cliente o técnico) en formato estructurado. Para el derecho de supresión se anonimiza: se eliminan nombre, contacto, dirección y textos libres, y se conservan los registros que la ley obliga a mantener (órdenes de trabajo, certificados, facturación) sin vínculo con la persona.
La supresión se rechaza mientras haya órdenes de trabajo o visitas abiertas. Toda solicitud queda registrada.`,
  },
];

export async function seedGuide(db: Pick<pg.PoolClient, "query">): Promise<number> {
  let n = 0;
  for (const doc of PLATFORM_GUIDE) n += await upsertKnowledge(db, doc);
  return n;
}
