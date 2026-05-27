(function () {
  'use strict';

  const STORAGE_KEY = '__spoofWallet__';

  function getConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { enabled: false, address: '' };
      return JSON.parse(raw);
    } catch { return { enabled: false, address: '' }; }
  }

  function waitForEthereum(cb, attempts) {
    if (window.ethereum) return cb();
    if (attempts <= 0) return;
    setTimeout(() => waitForEthereum(cb, attempts - 1), 100);
  }

  waitForEthereum(() => {
    const realEthereum = window.ethereum;
    const realRequest = realEthereum.request.bind(realEthereum);

    const originalOn = realEthereum.on ? realEthereum.on.bind(realEthereum) : null;

    const spoofedRequest = async function (args) {
      const config = getConfig();

      if (!config.enabled || !config.address) {
        return realRequest(args);
      }

      const method = args.method;
      const spoofAddr = config.address.toLowerCase();

      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        const realAccounts = await realRequest(args);
        console.log(`[SpoofWallet] ${method}: real=${realAccounts[0]}, spoofed=${spoofAddr}`);
        return [spoofAddr];
      }

      if (method === 'eth_getBalance') {
        const params = args.params || [];
        if (params[0] && params[0].toLowerCase() === spoofAddr) {
          const result = await realRequest({
            method: 'eth_getBalance',
            params: [spoofAddr, params[1] || 'latest']
          });
          console.log(`[SpoofWallet] eth_getBalance: showing balance of spoofed address`);
          return result;
        }
        return realRequest(args);
      }

      if (method === 'eth_call') {
        const params = args.params || [];
        if (params[0] && params[0].from) {
          const originalFrom = params[0].from;
          params[0].from = spoofAddr;
          console.log(`[SpoofWallet] eth_call: replaced from=${originalFrom} with ${spoofAddr}`);
          return realRequest({ ...args, params });
        }
        return realRequest(args);
      }

      if (method === 'eth_sendTransaction') {
        console.log(`[SpoofWallet] eth_sendTransaction: tx signed by REAL wallet, not spoofed address. msg.sender will be the real signer.`);
        return realRequest(args);
      }

      return realRequest(args);
    };

    const proxy = new Proxy(realEthereum, {
      get(target, prop, receiver) {
        if (prop === 'request') return spoofedRequest;

        if (prop === 'selectedAddress') {
          const config = getConfig();
          if (config.enabled && config.address) return config.address.toLowerCase();
          return target.selectedAddress;
        }

        if (prop === 'on' && originalOn) {
          return function (event, handler) {
            if (event === 'accountsChanged') {
              return originalOn(event, (accounts) => {
                const config = getConfig();
                if (config.enabled && config.address) {
                  console.log(`[SpoofWallet] accountsChanged: intercepted, returning spoofed address`);
                  handler([config.address.toLowerCase()]);
                } else {
                  handler(accounts);
                }
              });
            }
            return originalOn(event, handler);
          };
        }

        const val = Reflect.get(target, prop, receiver);
        if (typeof val === 'function') return val.bind(target);
        return val;
      }
    });

    Object.defineProperty(window, 'ethereum', {
      get: () => proxy,
      set: () => true,
      configurable: false
    });

    console.log('[SpoofWallet] Provider proxy installed. Configure via localStorage or extension popup.');

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SPOOF_WALLET_CONFIG') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          enabled: event.data.enabled,
          address: event.data.address
        }));
        console.log(`[SpoofWallet] Config updated: enabled=${event.data.enabled}, address=${event.data.address}`);
      }
    });

  }, 50);
})();
