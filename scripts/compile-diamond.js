const solc = require('solc');
const fs = require('fs');
const path = require('path');

const contractsDir = path.resolve(__dirname, '..', 'contracts');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const sources = {
  'diamond/DiamondStorage.sol': { content: readSource(path.join(contractsDir, 'diamond', 'DiamondStorage.sol')) },
  'diamond/Diamond.sol': { content: readSource(path.join(contractsDir, 'diamond', 'Diamond.sol')) },
  'diamond/facets/DiamondCutFacet.sol': { content: readSource(path.join(contractsDir, 'diamond', 'facets', 'DiamondCutFacet.sol')) },
  'diamond/facets/ChallengeFacet.sol': { content: readSource(path.join(contractsDir, 'diamond', 'facets', 'ChallengeFacet.sol')) },
  'diamond/facets/ERC20Facet.sol': { content: readSource(path.join(contractsDir, 'diamond', 'facets', 'ERC20Facet.sol')) },
  'diamond/facets/BountyFacet.sol': { content: readSource(path.join(contractsDir, 'diamond', 'facets', 'BountyFacet.sol')) },
  'diamond/facets/FeeVaultFacet.sol': { content: readSource(path.join(contractsDir, 'diamond', 'facets', 'FeeVaultFacet.sol')) }
};

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};

function findImports(importPath) {
  const fullPath = path.join(contractsDir, importPath);
  if (fs.existsSync(fullPath)) {
    return { contents: fs.readFileSync(fullPath, 'utf8') };
  }
  return { error: `File not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

if (output.errors) {
  const fatal = output.errors.filter(e => e.severity === 'error');
  if (fatal.length) {
    console.error('Compilation errors:');
    fatal.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors.filter(e => e.severity === 'warning').forEach(w => console.warn(w.formattedMessage));
}

const outDir = path.resolve(__dirname, '..', 'artifacts', 'diamond');
fs.mkdirSync(outDir, { recursive: true });

for (const [fileName, fileContracts] of Object.entries(output.contracts)) {
  for (const [contractName, contract] of Object.entries(fileContracts)) {
    if (['DiamondStorage', 'TokenStorage', 'BountyStorage', 'FeeVaultStorage'].includes(contractName)) continue;
    const artifact = {
      abi: contract.abi,
      bytecode: '0x' + contract.evm.bytecode.object
    };
    const outPath = path.join(outDir, `${contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`${contractName} -> artifacts/diamond/${contractName}.json`);
    console.log('  Functions:', artifact.abi.filter(a => a.type === 'function').map(a => a.name).join(', '));
    console.log('  Bytecode size:', Math.floor(artifact.bytecode.length / 2), 'bytes');
  }
}
