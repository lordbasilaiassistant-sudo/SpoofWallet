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

async function main() {
  loadEnv(SECRETS_PATH);

  const pk = process.env.THRYXTREASURY_PRIVATE_KEY;
  if (!pk) throw new Error('THRYXTREASURY_PRIVATE_KEY not found');

  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(pk, provider);

  console.log('Deployer:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(balance), 'ETH');

  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'artifacts', 'SpoofChallenge.json'), 'utf8')
  );

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log('Deploying SpoofChallenge...');
  const contract = await factory.deploy();
  console.log('Tx hash:', contract.deploymentTransaction().hash);

  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log('Deployed at:', addr);

  const [_owner, _feeRecip, _msg, _pubCalls, _ownerCalls, _spoofOk] = await contract.getState();
  console.log('Owner:', _owner);
  console.log('Fee Recipient:', _feeRecip);
  console.log('Message:', _msg);

  const deployInfo = {
    contract: 'SpoofChallenge',
    address: addr,
    txHash: contract.deploymentTransaction().hash,
    owner: _owner,
    feeRecipient: _feeRecip,
    deployer: wallet.address,
    chainId: 8453,
    network: 'base-mainnet',
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(
    path.resolve(__dirname, '..', 'artifacts', 'deployment-challenge.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  console.log('\nSaved to artifacts/deployment-challenge.json');
}

main().catch(err => { console.error(err); process.exit(1); });
