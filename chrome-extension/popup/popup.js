const toggle = document.getElementById('toggle');
const addressInput = document.getElementById('address');
const statusEl = document.getElementById('status');

function updateStatus() {
  const enabled = toggle.checked;
  const addr = addressInput.value.trim();

  if (enabled && addr) {
    statusEl.className = 'status active';
    statusEl.textContent = `Spoofing as ${addr.slice(0, 6)}...${addr.slice(-4)}`;
  } else if (enabled && !addr) {
    statusEl.className = 'status active';
    statusEl.textContent = 'Enter an address to spoof';
  } else {
    statusEl.className = 'status inactive';
    statusEl.textContent = 'Spoof disabled';
  }
}

function saveConfig() {
  const config = {
    spoofEnabled: toggle.checked,
    spoofAddress: addressInput.value.trim()
  };
  chrome.storage.local.set(config);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SPOOF_WALLET_CONFIG',
        enabled: config.spoofEnabled,
        address: config.spoofAddress
      }).catch(() => {});

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (enabled, address) => {
          window.postMessage({
            type: 'SPOOF_WALLET_CONFIG',
            enabled,
            address
          }, '*');
        },
        args: [config.spoofEnabled, config.spoofAddress],
        world: 'MAIN'
      }).catch(() => {});
    }
  });

  updateStatus();
}

chrome.storage.local.get(['spoofEnabled', 'spoofAddress'], (data) => {
  toggle.checked = data.spoofEnabled || false;
  addressInput.value = data.spoofAddress || '';
  updateStatus();
});

toggle.addEventListener('change', saveConfig);
addressInput.addEventListener('input', saveConfig);
