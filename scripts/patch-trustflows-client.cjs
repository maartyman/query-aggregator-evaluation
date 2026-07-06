const fs = require('node:fs');
const path = require('node:path');

const packageDir = path.join(__dirname, '..', 'node_modules', 'trustflows-client', 'dist');

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(location);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [location] : [];
  });
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.') || path.extname(specifier)) {
    return specifier;
  }

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(`${resolved}.js`)) {
    return `${specifier}.js`;
  }
  if (fs.existsSync(path.join(resolved, 'index.js'))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

for (const file of walk(packageDir)) {
  const source = fs.readFileSync(file, 'utf8');
  const patched = source.replace(
    /(from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\2/g,
    (match, prefix, quote, specifier) => {
      const resolved = resolveRelativeImport(file, specifier);
      return `${prefix}${quote}${resolved}${quote}`;
    }
  );

  if (patched !== source) {
    fs.writeFileSync(file, patched);
  }
}
