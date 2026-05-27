const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputDir = process.argv[3];

const raw = fs.readFileSync(inputFile, 'utf8');
const json = JSON.parse(raw);
const result = json.result[0];

console.log('ContractName:', result.ContractName);
console.log('CompilerVersion:', result.CompilerVersion);
console.log('Implementation:', result.Implementation);

let sourceCode = result.SourceCode;

// Etherscan wraps multi-file sources in {{...}} (double braces)
if (sourceCode.startsWith('{{')) {
  sourceCode = sourceCode.slice(1, -1); // remove outer braces
}

try {
  const parsed = JSON.parse(sourceCode);
  const sources = parsed.sources || parsed;

  fs.mkdirSync(outputDir, { recursive: true });

  const files = [];
  for (const [filePath, fileData] of Object.entries(sources)) {
    const content = fileData.content || fileData;
    const outPath = path.join(outputDir, filePath.replace(/\//g, '_'));
    fs.writeFileSync(outPath, content, 'utf8');
    files.push({ path: filePath, outPath, size: content.length });
  }

  console.log('\nExtracted', files.length, 'files:');
  files.forEach(f => console.log(`  ${f.path} (${f.size} bytes)`));
} catch (e) {
  // Single file source
  const outPath = path.join(outputDir, result.ContractName + '.sol');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outPath, sourceCode, 'utf8');
  console.log('Single file written to', outPath, '(' + sourceCode.length + ' bytes)');
}
