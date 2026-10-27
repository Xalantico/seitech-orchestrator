import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import type { Column } from "./query.js";

export type ExportFormat = "csv" | "xlsx" | "pdf";
export type RenderInput = { title: string; columns: Column[]; rows: Record<string, unknown>[]; generatedAt?: Date; filterSummary?: string };
export type Rendered = { data: Buffer; mime: string; extension: string };

const MIME: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

function cellText(value: unknown, col: Column): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return col.type === "date" ? value.toISOString().slice(0, 10) : value.toISOString().replace("T", " ").slice(0, 19);
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Spreadsheet formula injection: values starting with = + - @ are neutralised for CSV and XLSX. */
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s);

export function renderCsv(input: RenderInput): Buffer {
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [input.columns.map((c) => esc(c.label)).join(";")];
  for (const row of input.rows) lines.push(input.columns.map((c) => esc(safe(cellText(row[c.key], c)))).join(";"));
  // BOM so Excel opens UTF-8 accents correctly; ";" is the Spanish list separator.
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export async function renderXlsx(input: RenderInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Orquestador";
  wb.created = input.generatedAt ?? new Date();
  const ws = wb.addWorksheet(input.title.slice(0, 31).replace(/[\\/?*[\]:]/g, " "), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = input.columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(40, Math.max(12, c.label.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
  for (const row of input.rows) {
    ws.addRow(
      Object.fromEntries(
        input.columns.map((c) => {
          const v = row[c.key];
          if (v === null || v === undefined) return [c.key, null];
          if (c.type === "number") return [c.key, Number(v)];
          if (c.type === "date" || c.type === "timestamp") return [c.key, v instanceof Date ? v : new Date(String(v))];
          if (c.type === "bool") return [c.key, v ? "Sí" : "No"];
          return [c.key, safe(cellText(v, c))];
        }),
      ),
    );
  }
  input.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === "date") col.numFmt = "dd/mm/yyyy";
    if (c.type === "timestamp") col.numFmt = "dd/mm/yyyy hh:mm";
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, input.columns.length) } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function renderPdf(input: RenderInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28, info: { Title: input.title, Creator: "Orquestador" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const cols = input.columns.slice(0, 12);
    const width = doc.page.width - 56;
    const colW = width / Math.max(1, cols.length);
    const header = () => {
      doc.font("Helvetica-Bold").fontSize(7);
      let x = 28;
      const y = doc.y;
      for (const c of cols) {
        doc.text(c.label, x, y, { width: colW - 4, height: 20, ellipsis: true });
        x += colW;
      }
      doc.moveTo(28, y + 18).lineTo(28 + width, y + 18).strokeColor("#999").stroke();
      doc.y = y + 22;
      doc.font("Helvetica").fontSize(7);
    };
    doc.font("Helvetica-Bold").fontSize(13).text(input.title, 28, 28);
    doc.font("Helvetica").fontSize(8).fillColor("#555").text(`${(input.generatedAt ?? new Date()).toISOString().slice(0, 16).replace("T", " ")} · ${input.rows.length} filas${input.filterSummary ? ` · ${input.filterSummary}` : ""}`);
    doc.moveDown(0.6).fillColor("#000");
    header();
    for (const row of input.rows) {
      if (doc.y > doc.page.height - 50) {
        doc.addPage();
        header();
      }
      let x = 28;
      const y = doc.y;
      for (const c of cols) {
        doc.text(cellText(row[c.key], c), x, y, { width: colW - 4, height: 10, ellipsis: true, lineBreak: false });
        x += colW;
      }
      doc.y = y + 11;
    }
    doc.end();
  });
}

export async function renderExport(format: ExportFormat, input: RenderInput): Promise<Rendered> {
  const data = format === "csv" ? renderCsv(input) : format === "xlsx" ? await renderXlsx(input) : await renderPdf(input);
  return { data, mime: MIME[format], extension: format };
}
