chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SPOOF_CONFIG') {
    chrome.storage.local.get(['spoofEnabled', 'spoofAddress'], (data) => {
      sendResponse({
        enabled: data.spoofEnabled || false,
        address: data.spoofAddress || ''
      });
    });
    return true;
  }

  if (msg.type === 'SET_SPOOF_CONFIG') {
    chrome.storage.local.set({
      spoofEnabled: msg.enabled,
      spoofAddress: msg.address
    }, () => sendResponse({ ok: true }));
    return true;
  }
});
