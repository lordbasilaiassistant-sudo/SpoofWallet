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
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(pk, provider);

  const DIAMOND = '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174';
  const cutAbi = loadArtifact('DiamondCutFacet').abi;
  const erc20Artifact = loadArtifact('ERC20Facet');
  const bountyArtifact = loadArtifact('BountyFacet');

  console.log('Deployer:', wallet.address);

  // Deploy FIXED ERC20Facet
  console.log('\n--- Deploying fixed ERC20Facet ---');
  const erc20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, wallet);
  const erc20Facet = await erc20Factory.deploy();
  await erc20Facet.waitForDeployment();
  const erc20Addr = await erc20Facet.getAddress();
  console.log('ERC20Facet:', erc20Addr);

  await new Promise(r => setTimeout(r, 5000));

  // Deploy FIXED BountyFacet
  console.log('\n--- Deploying fixed BountyFacet ---');
  const bountyFactory = new ethers.ContractFactory(bountyArtifact.abi, bountyArtifact.bytecode, wallet);
  const bountyFacet = await bountyFactory.deploy();
  await bountyFacet.waitForDeployment();
  const bountyAddr = await bountyFacet.getAddress();
  console.log('BountyFacet:', bountyAddr);

  // Replace selectors in Diamond (action=1 = Replace)
  const diamond = new ethers.Contract(DIAMOND, cutAbi, wallet);
  const erc20Sels = getSelectors(erc20Artifact.abi);
  const bountySels = getSelectors(bountyArtifact.abi);

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Replacing ERC20Facet selectors ---');
  let tx = await diamond.diamondCut(erc20Addr, erc20Sels, 1); // 1 = Replace
  await tx.wait();
  console.log('ERC20 replaced:', tx.hash);

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Replacing BountyFacet selectors ---');
  tx = await diamond.diamondCut(bountyAddr, bountySels, 1);
  await tx.wait();
  console.log('Bounty replaced:', tx.hash);

  // Now initialize token
  const TOTAL_SUPPLY = ethers.parseEther('1000000000');
  const fullAbi = [...erc20Artifact.abi, ...bountyArtifact.abi];
  const tokenContract = new ethers.Contract(DIAMOND, fullAbi, wallet);

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Initializing Token ---');
  tx = await tokenContract.initializeToken('Spoof Bounty', 'SPOOF', TOTAL_SUPPLY, wallet.address);
  await tx.wait();
  console.log('Token init:', tx.hash);

  const BOUNTY_POOL = ethers.parseEther('1000000');
  const MAX_PER_EXPLOIT = ethers.parseEther('100000');

  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Initializing Bounty Pool ---');
  tx = await tokenContract.initializeBounty(BOUNTY_POOL, MAX_PER_EXPLOIT);
  await tx.wait();
  console.log('Bounty init:', tx.hash);

  // Verify
  const name = await tokenContract.name();
  const symbol = await tokenContract.symbol();
  const supply = await tokenContract.totalSupply();
  const ownerBal = await tokenContract.balanceOf(wallet.address);
  const bountyInfo = await tokenContract.getBountyInfo();

  console.log('\n=== SPOOF Token Live ===');
  console.log('Name:', name, '| Symbol:', symbol);
  console.log('Total Supply:', ethers.formatEther(supply));
  console.log('Owner Balance:', ethers.formatEther(ownerBal));
  console.log('Bounty Pool:', ethers.formatEther(bountyInfo.totalPool));
  console.log('Max Per Exploit:', ethers.formatEther(bountyInfo.maxPerExploit));

  // Update deployment info
  const deployInfo = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', 'deployment.json'), 'utf8'
  ));
  deployInfo.erc20Facet = erc20Addr;
  deployInfo.bountyFacet = bountyAddr;
  deployInfo.token = { name, symbol, totalSupply: ethers.formatEther(supply), bountyPool: ethers.formatEther(bountyInfo.totalPool) };
  fs.writeFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'diamond', 'deployment.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
