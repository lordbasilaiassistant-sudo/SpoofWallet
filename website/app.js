(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let realAddress = null;
  let provider = null;
  let signer = null;
  let contractOwner = null;

  const RPC_URL = 'https://mainnet.base.org';
  const DEFAULT_CONTRACT = '0x0D5d767Dfad78a81237bCa60d986d68bffE9B174';

  const ABI = [
    'function callPublic() external',
    'function setMessage(string calldata newMessage) external',
    'function setFeeRecipient(address newRecipient) external',
    'function claimSpoof() external',
    'function transferOwnership(address newOwner) external',
    'function approveOperator(address operator, bool approved) external',
    'function withdrawTreasury(address to, uint256 amount) external',
    'function diamondCut(address _facetAddress, bytes4[] calldata _selectors, uint8 _action) external',
    'function getState() external view returns (address _owner, address _feeRecipient, string _message, uint256 _publicCalls, uint256 _ownerCalls, bool _spoofSucceeded, uint256 _treasuryBalance)',
    'function owner() external view returns (address)',
    'function isOperator(address addr) external view returns (bool)',
  ];

  function getContractAddr() {
    return $('#target-contract').value.trim() || DEFAULT_CONTRACT;
  }

  function getSpoofAddr() {
    return $('#spoof-address').value.trim();
  }

  // --- Results Log ---

  function logResult(entry) {
    const box = $('#results-log');
    const empty = box.querySelector('.log-empty');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'result-entry';
    div.innerHTML = entry;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function logAttack(fn, simResult, realResult) {
    const ts = new Date().toLocaleTimeString();
    const spoofAddr = getSpoofAddr();
    const entry =
      `<div class="result-header">` +
        `<span class="log-time">${ts}</span> ` +
        `<span class="log-method">${fn}</span> ` +
        `<span class="mono" style="font-size:0.72rem">spoofing as ${spoofAddr ? spoofAddr.slice(0,8)+'...' : 'none'}</span>` +
      `</div>` +
      `<div class="result-compare">` +
        `<div class="result-sim">` +
          `<span class="result-label">SIMULATION (eth_call)</span>` +
          `<span class="${simResult.ok ? 'result-pass' : 'result-fail'}">${simResult.ok ? 'PASSED' : 'REVERTED'}</span>` +
          `<span class="result-detail">${simResult.detail}</span>` +
        `</div>` +
        `<div class="result-real">` +
          `<span class="result-label">REAL TX (eth_sendTransaction)</span>` +
          `<span class="${realResult.ok ? 'result-pass' : 'result-fail'}">${realResult.ok ? 'PASSED' : 'REVERTED'}</span>` +
          `<span class="result-detail">${realResult.detail}</span>` +
        `</div>` +
      `</div>`;
    logResult(entry);
  }

  // --- Wallet Connection ---

  async function connectWallet() {
    if (!window.ethereum) {
      showStatus('#connect-status', 'No wallet detected. Install MetaMask or another EVM wallet.', 'error');
      return;
    }
    try {
      showStatus('#connect-status', 'Requesting accounts...', 'info');
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) {
        showStatus('#connect-status', 'No accounts returned.', 'error');
        return;
      }
      realAddress = accounts[0];
      $('#real-address').textContent = realAddress;
      showStatus('#connect-status', 'Connected — this is your REAL wallet (the attacker).', 'success');
      $('#connect-btn').textContent = 'Connected';
      $('#connect-btn').disabled = true;
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      enableAttackButtons();
    } catch (err) {
      showStatus('#connect-status', err.message, 'error');
    }
  }

  function enableAttackButtons() {
    ['#attack-fee-btn', '#attack-msg-btn', '#attack-claim-btn', '#attack-owner-btn'].forEach(s => {
      $(s).disabled = false;
    });
  }

  // --- Contract State ---

  async function loadContractState() {
    try {
      const rpc = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(getContractAddr(), ABI, rpc);
      const [_owner, _feeRecip, _msg, _pub, _own, _spoof, _treasury] = await contract.getState();
      contractOwner = _owner;

      $('#contract-owner').textContent = _owner;
      $('#contract-fee-recip').textContent = _feeRecip;
      $('#contract-message').textContent = _msg;
      $('#contract-spoof-flag').textContent = _spoof ? 'TRUE — BROKEN!' : 'false';
      $('#contract-spoof-flag').style.color = _spoof ? 'var(--red)' : 'var(--green)';

      if (realAddress && realAddress.toLowerCase() === _owner.toLowerCase()) {
        showStatus('#connect-status', 'WARNING: Your wallet IS the owner. Connect a DIFFERENT wallet to test spoofing.', 'error');
      }
    } catch (err) {
      $('#contract-owner').textContent = 'Error: ' + err.message;
    }
  }

  function autoFillOwner() {
    if (contractOwner) {
      $('#spoof-address').value = contractOwner;
    }
  }

  // --- Attack Engine ---

  async function simulateCall(functionFragment, args) {
    const spoofAddr = getSpoofAddr();
    const rpc = new ethers.JsonRpcProvider(RPC_URL);
    const iface = new ethers.Interface(ABI);
    const data = iface.encodeFunctionData(functionFragment, args);

    try {
      const result = await rpc.call({
        to: getContractAddr(),
        from: spoofAddr || realAddress,
        data: data
      });
      return { ok: true, detail: `from: ${(spoofAddr || realAddress).slice(0,10)}... → success (simulation only, no state change)` };
    } catch (err) {
      const reason = err.reason || err.message || 'Unknown';
      return { ok: false, detail: `from: ${(spoofAddr || realAddress).slice(0,10)}... → ${reason}` };
    }
  }

  async function realTransaction(functionFragment, args) {
    if (!signer) return { ok: false, detail: 'Wallet not connected' };

    const contract = new ethers.Contract(getContractAddr(), ABI, signer);

    try {
      const tx = await contract[functionFragment](...args);
      const receipt = await tx.wait();
      return { ok: true, detail: `tx: ${tx.hash.slice(0,16)}... block ${receipt.blockNumber} — STATE CHANGED ON CHAIN` };
    } catch (err) {
      let reason = 'Unknown error';
      if (err.reason) reason = err.reason;
      else if (err.message && err.message.includes('execution reverted')) reason = err.message.match(/reason="([^"]+)"/)?.[1] || 'execution reverted';
      else reason = err.shortMessage || err.message;
      return { ok: false, detail: `signed by: ${realAddress.slice(0,10)}... → REVERTED: ${reason}` };
    }
  }

  async function runAttack(fnName, args, skipReal) {
    const simResult = await simulateCall(fnName, args);

    let realResult;
    if (skipReal) {
      realResult = { ok: false, detail: 'Skipped (would cost gas)' };
    } else {
      realResult = await realTransaction(fnName, args);
    }

    logAttack(fnName + '(' + args.map(a => typeof a === 'string' && a.startsWith('0x') ? a.slice(0,10)+'...' : a).join(', ') + ')', simResult, realResult);
    loadContractState();
  }

  // --- Attack Handlers ---

  async function attackSetFeeRecipient() {
    const addr = $('#attack-fee-addr').value.trim();
    if (!addr || !ethers.isAddress(addr)) {
      logResult('<div class="result-entry" style="color:var(--red)">Enter a valid address for setFeeRecipient</div>');
      return;
    }
    await runAttack('setFeeRecipient', [addr]);
  }

  async function attackSetMessage() {
    const msg = $('#attack-msg-text').value.trim();
    if (!msg) {
      logResult('<div class="result-entry" style="color:var(--red)">Enter a message</div>');
      return;
    }
    await runAttack('setMessage', [msg]);
  }

  async function attackClaimSpoof() {
    await runAttack('claimSpoof', []);
  }

  async function attackTransferOwnership() {
    const addr = $('#attack-owner-addr').value.trim();
    if (!addr || !ethers.isAddress(addr)) {
      logResult('<div class="result-entry" style="color:var(--red)">Enter a valid address for transferOwnership</div>');
      return;
    }
    await runAttack('transferOwnership', [addr]);
  }

  // --- Transaction Lookup ---

  async function lookupTransaction() {
    const txHash = $('#tx-hash-input').value.trim();
    if (!txHash || !txHash.startsWith('0x') || txHash.length !== 66) {
      showStatus('#lookup-error', 'Enter a valid 66-char tx hash starting with 0x', 'error');
      return;
    }
    $('#lookup-error').classList.add('hidden');
    $('#lookup-result').classList.add('hidden');
    try {
      const rpc = new ethers.JsonRpcProvider(RPC_URL);
      const tx = await rpc.getTransaction(txHash);
      if (!tx) {
        showStatus('#lookup-error', 'Not found — must be a Base mainnet tx.', 'error');
        return;
      }
      $('#tx-sender').textContent = tx.from;
      $('#lookup-result').classList.remove('hidden');
    } catch (err) {
      showStatus('#lookup-error', err.message, 'error');
    }
  }

  function useSenderAsSpoof() {
    const sender = $('#tx-sender').textContent;
    if (sender && sender !== '—') {
      $('#spoof-address').value = sender;
    }
  }

  // --- Helpers ---

  function showStatus(selector, msg, type) {
    const el = $(selector);
    el.textContent = msg;
    el.className = `status ${type}`;
    el.classList.remove('hidden');
  }

  // --- Init ---

  $('#connect-btn').addEventListener('click', connectWallet);
  $('#load-contract-btn').addEventListener('click', loadContractState);
  $('#refresh-state-btn').addEventListener('click', loadContractState);
  $('#use-owner-btn').addEventListener('click', autoFillOwner);
  $('#attack-fee-btn').addEventListener('click', attackSetFeeRecipient);
  $('#attack-msg-btn').addEventListener('click', attackSetMessage);
  $('#attack-claim-btn').addEventListener('click', attackClaimSpoof);
  $('#attack-owner-btn').addEventListener('click', attackTransferOwnership);
  $('#lookup-btn').addEventListener('click', lookupTransaction);
  $('#use-sender-btn').addEventListener('click', useSenderAsSpoof);
  $('#clear-results-btn').addEventListener('click', () => {
    $('#results-log').innerHTML = '<div class="log-empty">No attacks attempted yet.</div>';
  });

  $('#tx-hash-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') lookupTransaction();
  });

  loadContractState();

  if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
      if (accounts.length > 0) {
        realAddress = accounts[0];
        $('#real-address').textContent = realAddress;
      }
    });
  }
})();
