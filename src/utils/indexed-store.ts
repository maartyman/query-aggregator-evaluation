import { Store, Parser } from 'n3';

export class IndexedStore {
  private loadingPromises = new Map<string, Promise<void>>();
  public store = new Store();

  private extractTurtleFromHtml(html: string): string {
    const scriptRegex = /<script[^>]*type=["']text\/turtle["'][^>]*>([\s\S]*?)<\/script>/gi;
    const matches = [];
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
      matches.push(match[1]);
    }

    if (matches.length === 0) {
      throw new Error('No <script type="text/turtle"> tags found in HTML');
    }

    return matches.join('\n\n');
  }

  async add(sources: string[], authFetch: typeof fetch) {
    const loadPromises: Promise<void>[] = [];
    for (const source of sources) {
      const existingPromise = this.loadingPromises.get(source);
      if (existingPromise) {
        loadPromises.push(existingPromise);
        continue;
      }

      const loadPromise = (async () => {
        try {
          const response = await authFetch(source, {
            headers: {
              'Accept': 'text/turtle'
            }
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
          }

          let data = await response.text();

          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('text/html') || data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
            data = this.extractTurtleFromHtml(data);
          }

          const parser = new Parser({format: 'text/turtle', baseIRI: source});
          this.store.addQuads(parser.parse(data));
        } catch (error) {
          console.log(`Error loading source ${source}:`, error);
          throw error;
        }
      })();

      this.loadingPromises.set(source, loadPromise);
      loadPromises.push(loadPromise);
    }

    await Promise.all(loadPromises);
  }

}

/*
import {Store} from 'oxigraph';
import {Term} from "@rdfjs/types";

export class QueryEngine {
store: Store;
loadingPromises = new Map<string, Promise<void>>();

constructor() {
this.store = new Store();
}

private extractTurtleFromHtml(html: string): string {
const scriptRegex = /<script[^>]*type=["']text\/turtle["'][^>]*>([\s\S]*?)<\/script>/gi;
const matches = [];
let match;

while ((match = scriptRegex.exec(html)) !== null) {
matches.push(match[1]);
}

if (matches.length === 0) {
throw new Error('No <script type="text/turtle"> tags found in HTML');
}

return matches.join('\n\n');
}

public async queryBindings(
query: string,
options: {
sources: string[],
fetch: typeof fetch
}
): Promise<Map<string, Term>[]> {
const loadPromises: Promise<void>[] = [];
const sourcesToLoad = options.sources.filter(source => !this.loadingPromises.has(source));
let loadedCount = 0;
const totalToLoad = sourcesToLoad.length;

if (totalToLoad > 0) {
console.log(`Loading data from ${totalToLoad} sources for query`);
}

for (const source of options.sources) {
const existingPromise = this.loadingPromises.get(source);
if (existingPromise) {
loadPromises.push(existingPromise);
continue;
}

const loadPromise = (async () => {
try {
const response = await options.fetch(source, {
headers: {
'Accept': 'text/turtle'
}
});

if (!response.ok) {
throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
}

let data = await response.text();

const contentType = response.headers.get('content-type') || '';
if (contentType.includes('text/html') || data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
data = this.extractTurtleFromHtml(data);
}

this.store.load(data, {
format: 'text/turtle',
base_iri: source
});

loadedCount++;
if (totalToLoad > 0) {
const percentage = Math.round((loadedCount / totalToLoad) * 100);
const barLength = 40;
const filled = Math.round((loadedCount / totalToLoad) * barLength);
const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
process.stdout.write(`\r  Progress: [${bar}] ${percentage}% (${loadedCount}/${totalToLoad})`);
if (loadedCount === totalToLoad) {
process.stdout.write('\n');
}
}
} catch (error) {
loadedCount++;
if (totalToLoad > 0) {
const percentage = Math.round((loadedCount / totalToLoad) * 100);
const barLength = 40;
const filled = Math.round((loadedCount / totalToLoad) * barLength);
const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
process.stdout.write(`\r  Progress: [${bar}] ${percentage}% (${loadedCount}/${totalToLoad})`);
if (loadedCount === totalToLoad) {
process.stdout.write('\n');
}
}
throw error;
}
})();

this.loadingPromises.set(source, loadPromise);
loadPromises.push(loadPromise);
}

await Promise.all(loadPromises);
console.log(`Running query on loaded data`);

return this.store.query(query) as Map<string, Term>[];
}
}
*/
