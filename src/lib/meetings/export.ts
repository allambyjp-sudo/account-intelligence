import { AlignmentType, Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { citeText, type OnePager } from "./onepager";

const cite = (cites: number[]) => (cites.length ? [new TextRun({ text: ` [${cites.join(", ")}]`, superScript: true, color: "1D5FBF" })] : []);

export async function onePagerToDocx(p: OnePager): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: p.title })] }),
    new Paragraph({ children: [new TextRun({ text: p.subtitle, color: "555555" })], spacing: { after: 200 } }),
  ];
  for (const s of p.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: s.heading })], spacing: { before: 200 } }));
    for (const para of s.paragraphs ?? []) children.push(new Paragraph({ children: [new TextRun({ text: para.text }), ...cite(para.cites)] }));
    for (const item of s.items ?? []) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item.text, bold: Boolean(item.detail) }), ...cite(item.cites)] }));
      if (item.detail) children.push(new Paragraph({ indent: { left: 720 }, children: [new TextRun({ text: item.detail, color: "444444" })] }));
    }
  }
  if (p.sources.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: "Evidence" })], spacing: { before: 200 } }));
    for (const src of p.sources) {
      const label = `[${src.n}] ${src.label} (${src.date})`;
      children.push(
        new Paragraph({
          children: src.url ? [new ExternalHyperlink({ link: src.url, children: [new TextRun({ text: label, style: "Hyperlink", size: 18 })] })] : [new TextRun({ text: label, size: 18 })],
        }),
      );
    }
  }
  children.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { before: 300 }, children: [new TextRun({ text: p.footer, italics: true, size: 16, color: "777777" })] }));
  const doc = new Document({
    creator: "Account Intelligence",
    title: p.title,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

export function onePagerToPdf(p: OnePager): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: p.title, Creator: "Account Intelligence" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a").text(p.title);
    doc.font("Helvetica").fontSize(9.5).fillColor("#555555").text(p.subtitle).moveDown(0.6);
    for (const s of p.sections) {
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#12305e").text(s.heading).moveDown(0.15);
      doc.fillColor("#0f172a");
      for (const para of s.paragraphs ?? []) doc.font("Helvetica").fontSize(9.5).text(`${para.text}${citeText(para.cites)}`).moveDown(0.2);
      for (const item of s.items ?? []) {
        doc.font(item.detail ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).text(`•  ${item.text}${citeText(item.cites)}`, { indent: 0 });
        if (item.detail) doc.font("Helvetica").fillColor("#444444").text(item.detail, { indent: 12 }).fillColor("#0f172a");
        doc.moveDown(0.15);
      }
      doc.moveDown(0.4);
    }
    if (p.sources.length) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#12305e").text("Evidence").moveDown(0.1);
      for (const src of p.sources) {
        doc.font("Helvetica").fontSize(8).fillColor(src.url ? "#1d5fbf" : "#444444").text(`[${src.n}] ${src.label} (${src.date})`, src.url ? { link: src.url, underline: false } : {});
      }
    }
    doc.moveDown(0.8).font("Helvetica-Oblique").fontSize(7.5).fillColor("#777777").text(p.footer);
    doc.end();
  });
}
