import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const surfacePath = path.join(
  repo,
  "runtime",
  "node",
  "generated",
  "node24-surface.json",
);
const outputPath = path.join(
  repo,
  "runtime",
  "node",
  "generated",
  "node24-docs.json",
);
const nodeVersion = "24.13.0";
const sourceUrl = `https://nodejs.org/download/release/v${nodeVersion}/docs/api/all.json`;
const childCollections = [
  "modules",
  "classes",
  "methods",
  "classMethods",
  "ctors",
  "properties",
  "globals",
  "events",
  "miscs",
];
const platformNames = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "posix",
  "sunos",
  "unix",
  "windows",
];

const response = await fetch(sourceUrl);
if (!response.ok)
  throw new Error(`Unable to download ${sourceUrl}: HTTP ${response.status}`);
const sourceBytes = Buffer.from(await response.arrayBuffer());
const sourceSha256 = crypto
  .createHash("sha256")
  .update(sourceBytes)
  .digest("hex");
const docs = JSON.parse(sourceBytes.toString("utf8"));
const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));

const records = [];
function visit(nodes, parentPath = "") {
  if (!Array.isArray(nodes)) return;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node || typeof node !== "object") continue;
    const type = typeof node.type === "string" ? node.type : "section";
    const name = typeof node.name === "string" ? node.name : `unnamed-${index}`;
    const recordPath = `${parentPath}/${type}:${name}`;
    const desc = typeof node.desc === "string" ? node.desc.toLowerCase() : "";
    const platformMentions = platformNames.filter((platform) =>
      new RegExp(`\\b${platform}\\b`, "i").test(desc),
    );
    const record = {
      path: recordPath,
      type,
      name,
    };
    for (const key of [
      "textRaw",
      "displayName",
      "source",
      "stability",
      "stabilityText",
    ]) {
      if (node[key] !== undefined) record[key] = node[key];
    }
    if (node.introduced_in !== undefined)
      record.introducedIn = node.introduced_in;
    if (node.meta !== undefined) record.meta = node.meta;
    if (node.platform !== undefined) record.platform = node.platform;
    if (node.platforms !== undefined) record.platforms = node.platforms;
    if (platformMentions.length > 0) record.platformMentions = platformMentions;
    records.push(record);
    for (const collection of childCollections)
      visit(node[collection], recordPath);
  }
}

for (const collection of [
  "miscs",
  "modules",
  "classes",
  "globals",
  "methods",
]) {
  visit(docs[collection], "");
}
records.sort((left, right) => left.path.localeCompare(right.path));

const availableSources = new Set(
  records.map((record) => record.source).filter(Boolean),
);
const specialDocumentationSources = {
  constants: "doc/api/deprecations.md",
  globals: "doc/api/globals.md",
  sea: "doc/api/single-executable-applications.md",
  sys: "doc/api/util.md",
  trace_events: "doc/api/tracing.md",
};
const declarationModules = Object.keys(surface.modules).map((moduleName) => {
  const builtinName = moduleName.slice("node:".length);
  const rootName = builtinName.split("/")[0];
  const documentationSource =
    specialDocumentationSources[builtinName] ??
    specialDocumentationSources[rootName] ??
    `doc/api/${rootName}.md`;
  return {
    module: moduleName,
    documentationSource,
    documented: availableSources.has(documentationSource),
  };
});

const snapshot = {
  formatVersion: 1,
  target: {
    nodeVersion,
    declarationPackage: surface.target.typesPackage,
    declarationVersion: surface.target.typesVersion,
  },
  source: {
    url: sourceUrl,
    sha256: sourceSha256,
    bytes: sourceBytes.length,
    format: "Node.js official all.json API documentation",
  },
  metadata: {
    records: records.length,
    stabilityRecords: records.filter((record) => record.stability !== undefined)
      .length,
    platformFieldRecords: records.filter(
      (record) =>
        record.platform !== undefined || record.platforms !== undefined,
    ).length,
    platformMentionRecords: records.filter(
      (record) => record.platformMentions?.length,
    ).length,
    note: "The official all.json input has no uniform platform field; platformMentions retain structured OS-name evidence without inferring support semantics.",
  },
  declarationModules,
  records,
};

fs.writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(
  `Pinned Node ${nodeVersion} documentation: ${records.length} records, sha256 ${sourceSha256}\n`,
);
