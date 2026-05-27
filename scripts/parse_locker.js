const fs = require('fs');
const path = require('path');
const data = require(path.join(process.env.USERPROFILE, 'locker_source.json'));
const r = data.result[0];
console.log('ContractName:', r.ContractName);
console.log('Proxy:', r.Proxy);
console.log('Implementation:', r.Implementation);
const outDir = path.join(process.env.USERPROFILE, 'locker_src');
let src = r.SourceCode;
if (src.startsWith('{{')) {
  const inner = src.slice(1, -1);
  const parsed = JSON.parse(inner);
  const sources = parsed.sources || {};
  Object.keys(sources).forEach(f => console.log('FILE:', f));
  console.log('Total files:', Object.keys(sources).length);
  fs.mkdirSync(outDir, {recursive: true});
  for (const [fname, obj] of Object.entries(sources)) {
    const safeName = fname.split('/').join('__').split('\\').join('__');
    fs.writeFileSync(path.join(outDir, safeName), obj.content);
  }
} else {
  console.log('Source length:', src.length);
  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, 'Locker.sol'), src);
}
