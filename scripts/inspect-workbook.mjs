import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const sourcePath = process.argv[2];
const outputDir = process.argv[3];

if (!sourcePath || !outputDir) {
  throw new Error("Usage: inspect-workbook.mjs <source.xlsx> <output-dir>");
}

await fs.mkdir(outputDir, { recursive: true });
console.log("LOADING", sourcePath);

const input = await FileBlob.load(sourcePath);
console.log("IMPORTING");
const workbook = await SpreadsheetFile.importXlsx(input);
console.log("IMPORTED");

const sheets = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 12_000,
});

console.log("SHEETS");
console.log(sheets.ndjson);

const sheet = workbook.worksheets.getItem("日本株ログ");
const used = sheet.getUsedRange(true);
const region = await workbook.inspect({
  kind: "region",
  sheetId: sheet.name,
  range: used.address,
  tableMaxRows: 160,
  tableMaxCols: 20,
  tableMaxCellChars: 180,
  maxChars: 80_000,
});

console.log(`REGION ${sheet.name} ${used.address}`);
console.log(region.ndjson);
await fs.writeFile(
  `${outputDir}/日本株ログ.json`,
  JSON.stringify({ address: used.address, values: used.values, formulas: used.formulas }, null, 2),
);

const preview = await workbook.render({
  sheetName: sheet.name,
  range: used.address,
  scale: 1,
  format: "png",
});
await fs.writeFile(
  `${outputDir}/日本株ログ.png`,
  new Uint8Array(await preview.arrayBuffer()),
);
