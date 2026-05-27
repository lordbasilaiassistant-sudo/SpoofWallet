const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const SECRETS_PATH = path.join(process.env.USERPROFILE, '.claude', 'secrets', 'engine.env');

function loadEnv(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

function loadArtifact(name) {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', `${name}.json`), 'utf8'
  ));
}

function getSelectors(abi) {
  const iface = new ethers.Interface(abi);
  return iface.fragments
    .filter(f => f.type === 'function')
    .map(f => iface.getFunction(f.name).selector);
}

async function main() {
  loadEnv(SECRETS_PATH);
  const pk = process.env.THRYXTREASURY_PRIVATE_KEY;
  if (!pk) throw new Error('Key not found');

  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(pk, provider);

  console.log('Deployer:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(bal), 'ETH');

  const diamondArtifact = loadArtifact('Diamond');
  const cutArtifact = loadArtifact('DiamondCutFacet');
  const challengeArtifact = loadArtifact('ChallengeFacet');

  console.log('\n--- Deploying DiamondCutFacet ---');
  const cutFactory = new ethers.ContractFactory(cutArtifact.abi, cutArtifact.bytecode, wallet);
  const cutFacet = await cutFactory.deploy();
  await cutFacet.waitForDeployment();
  const cutAddr = await cutFacet.getAddress();
  console.log('DiamondCutFacet:', cutAddr);

  console.log('\n--- Deploying ChallengeFacet ---');
  const chalFactory = new ethers.ContractFactory(challengeArtifact.abi, challengeArtifact.bytecode, wallet);
  const chalFacet = await chalFactory.deploy();
  await chalFacet.waitForDeployment();
  const chalAddr = await chalFacet.getAddress();
  console.log('ChallengeFacet:', chalAddr);

  const cutSelectors = getSelectors(cutArtifact.abi);
  const chalSelectors = getSelectors(challengeArtifact.abi);

  console.log('\nDiamondCut selectors:', cutSelectors);
  console.log('Challenge selectors:', chalSelectors);

  console.log('\n--- Deploying Diamond (with facets wired in constructor) ---');
  const diamondFactory = new ethers.ContractFactory(diamondArtifact.abi, diamondArtifact.bytecode, wallet);
  const diamond = await diamondFactory.deploy(
    wallet.address,
    [
      { facetAddress: cutAddr, selectors: cutSelectors },
      { facetAddress: chalAddr, selectors: chalSelectors }
    ]
  );
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();
  console.log('Diamond:', diamondAddr);

  // Verify facets work
  const fullAbi = [...cutArtifact.abi, ...challengeArtifact.abi];
  const contract = new ethers.Contract(diamondAddr, fullAbi, provider);

  const owner = await contract.owner();
  console.log('\nOwner:', owner);

  const state = await contract.getState();
  console.log('Fee Recipient:', state._feeRecipient);
  console.log('Message:', state._message);
  console.log('Spoof Flag:', state._spoofSucceeded);

  const deployInfo = {
    diamond: diamondAddr,
    diamondCutFacet: cutAddr,
    challengeFacet: chalAddr,
    deployer: wallet.address,
    owner: wallet.address,
    chainId: 8453,
    network: 'base-mainnet',
    cutSelectors,
    chalSelectors,
    allSelectors: [...cutSelectors, ...chalSelectors],
    timestamp: new Date().toISOString(),
    status: 'LIVE'
  };

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', 'deployment.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  console.log('\nDiamond fully deployed and wired. Saved to artifacts/diamond/deployment.json');
}

main().catch(err => { console.error(err); process.exit(1); });
