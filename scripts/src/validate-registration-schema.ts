import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registrationsTable } from "@workspace/db";

const apiSourceDirectory = fileURLToPath(
  new URL("../../artifacts/api-server/src/", import.meta.url),
);
const registrationReference = /\bregistrationsTable\.([A-Za-z_$][\w$]*)\b/g;

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  }));

  return nestedFiles.flat();
}

const sourceFiles = await findTypeScriptFiles(apiSourceDirectory);
const referencedFields = new Set<string>();

for (const sourceFile of sourceFiles) {
  const source = await readFile(sourceFile, "utf8");
  for (const match of source.matchAll(registrationReference)) {
    referencedFields.add(match[1]);
  }
}

const undefinedFields = [...referencedFields]
  .filter(field => !field.startsWith("$"))
  .filter(field => !(field in registrationsTable))
  .sort();

if (undefinedFields.length > 0) {
  console.error(
    `Registration schema is missing fields referenced by API queries: ${undefinedFields.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `Registration schema validation passed for ${referencedFields.size} API-selected fields.`,
);