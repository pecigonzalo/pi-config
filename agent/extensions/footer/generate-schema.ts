import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createFooterJsonSchema } from "./schema";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const outputPath = path.join(scriptDir, "footer.schema.json");
const schema = createFooterJsonSchema();

fs.writeFileSync(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf-8");
console.log(`Wrote ${outputPath}`);
