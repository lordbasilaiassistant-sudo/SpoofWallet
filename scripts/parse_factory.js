const path = require('path');
const outDir = path.join(process.env.USERPROFILE || process.env.HOME, 'factory_src');
const srcFile = path.join(process.env.USERPROFILE || process.env.HOME, 'factory_source.json');
const data = require(srcFile);
const r = data.result[0];
console.log('ContractName:', r.ContractName);
console.log('Compiler:', r.CompilerVersion);
console.log('Proxy:', r.Proxy);
console.log('Implementation:', r.Implementation);
let src = r.SourceCode;
if (src.startsWith('{{')) {
  const inner = src.slice(1, -1);
  const parsed = JSON.parse(inner);
  const sources = parsed.sources || {};
  Object.keys(sources).forEach(f => console.log('FILE:', f));
  console.log('Total files:', Object.keys(sources).length);
  const fs = require('fs');
  fs.mkdirSync(outDir, {recursive: true});
  for (const [fname, obj] of Object.entries(sources)) {
    const safeName = fname.replace(/\//g, '__').replace(/\\/g, '__');
    fs.writeFileSync(path.join(outDir, safeName), obj.content);
  }
  console.log('Files saved to', outDir);
} else {
  console.log('Source length:', src.length);
  const fs = require('fs');
  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, 'ClankerFactory.sol'), src);
}
