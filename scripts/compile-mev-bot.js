const solc = require('solc');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'contracts', 'mev-bot', 'FlashSandwich.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'FlashSandwich.sol': { content: source } },
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
  output.errors.filter(e => e.severity === 'warning').forEach(w => console.warn('WARN:', w.message));
}

const contract = output.contracts['FlashSandwich.sol']['FlashSandwich'];
const artifact = {
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object
};

const outDir = path.resolve(__dirname, '..', 'artifacts', 'mev-bot');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'FlashSandwich.json'), JSON.stringify(artifact, null, 2));
console.log('Compiled FlashSandwich');
console.log('  Bytecode size:', Math.floor(artifact.bytecode.length / 2), 'bytes');
console.log('  Functions:', artifact.abi.filter(a => a.type === 'function').map(a => a.name).join(', '));
