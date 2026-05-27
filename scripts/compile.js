const solc = require('solc');
const fs = require('fs');
const path = require('path');

const contracts = ['SpoofTest.sol', 'SpoofChallenge.sol'];
const sources = {};
for (const name of contracts) {
  const p = path.resolve(__dirname, '..', 'contracts', name);
  if (fs.existsSync(p)) sources[name] = { content: fs.readFileSync(p, 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const fatal = output.errors.filter(e => e.severity === 'error');
  if (fatal.length) {
    console.error('Compilation errors:');
    fatal.forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }
  output.errors.filter(e => e.severity === 'warning').forEach(w => console.warn(w.formattedMessage));
}

const outDir = path.resolve(__dirname, '..', 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

for (const [fileName, fileContracts] of Object.entries(output.contracts)) {
  for (const [contractName, contract] of Object.entries(fileContracts)) {
    const artifact = {
      abi: contract.abi,
      bytecode: '0x' + contract.evm.bytecode.object
    };
    fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
    console.log(`Compiled ${fileName}:${contractName} -> artifacts/${contractName}.json`);
    console.log('  Functions:', artifact.abi.filter(a => a.type === 'function').map(a => a.name).join(', '));
  }
}
