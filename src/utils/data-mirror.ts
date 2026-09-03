import * as fs from "fs";
import * as path from "path";
import type {ServerInstanceContext} from "../data-generator";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the ordered list of (from -> to) string replacements that rewrite every primary base
 * URL into its aggregator-stack counterpart. Both the raw URLs and their URL-encoded forms are
 * covered, because the generated data embeds encoded base URLs in file contents and file names.
 */
function buildReplacements(
  servers: ServerInstanceContext[],
  aggregatorServers: ServerInstanceContext[]
): Map<string, string> {
  const replacements = new Map<string, string>();
  const aggregatorByIndex = new Map<number, ServerInstanceContext>();
  for (const server of aggregatorServers) {
    aggregatorByIndex.set(server.index, server);
  }

  for (const server of servers) {
    const aggregator = aggregatorByIndex.get(server.index);
    if (!aggregator) {
      continue;
    }
    for (const [from, to] of [
      [server.solidBaseUrl, aggregator.solidBaseUrl],
      [server.umaBaseUrl, aggregator.umaBaseUrl],
    ] as const) {
      if (from === to) {
        continue;
      }
      replacements.set(from, to);
      replacements.set(encodeURIComponent(from), encodeURIComponent(to));
    }
  }

  return replacements;
}

function applyReplacements(value: string, replacements: Map<string, string>, matcher: RegExp): string {
  if (replacements.size === 0) {
    return value;
  }
  return value.replace(matcher, match => replacements.get(match) ?? match);
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Mirror the generated experiment data from the primary stack directory into the aggregator
 * stack directory, rewriting every primary base URL (and URL-encoded base URL, both in file
 * contents and in file names) to the matching aggregator-stack base URL. This yields a fully
 * self-consistent identical copy that only ever references the aggregator CSS/UMA servers.
 */
export function mirrorExperimentData(
  primaryDataDirectory: string,
  aggregatorDataDirectory: string,
  servers: ServerInstanceContext[],
  aggregatorServers: ServerInstanceContext[]
): void {
  if (!fs.existsSync(primaryDataDirectory)) {
    throw new Error(`Cannot mirror experiment data: source directory does not exist: ${primaryDataDirectory}`);
  }

  fs.rmSync(aggregatorDataDirectory, {recursive: true, force: true});
  fs.mkdirSync(path.dirname(aggregatorDataDirectory), {recursive: true});
  fs.cpSync(primaryDataDirectory, aggregatorDataDirectory, {recursive: true});

  const replacements = buildReplacements(servers, aggregatorServers);
  if (replacements.size === 0) {
    return;
  }

  const matcher = new RegExp(
    Array.from(replacements.keys())
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g"
  );

  for (const filePath of collectFiles(aggregatorDataDirectory)) {
    const contents = fs.readFileSync(filePath, "utf8");
    const rewritten = applyReplacements(contents, replacements, matcher);
    if (rewritten !== contents) {
      fs.writeFileSync(filePath, rewritten);
    }

    const fileName = path.basename(filePath);
    const rewrittenName = applyReplacements(fileName, replacements, matcher);
    if (rewrittenName !== fileName) {
      const newPath = path.join(path.dirname(filePath), rewrittenName);
      fs.renameSync(filePath, newPath);
    }
  }
}
