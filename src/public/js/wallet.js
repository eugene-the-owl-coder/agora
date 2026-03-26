/**
 * AGORA Wallet Utility — Phantom/Backpack Solana Wallet Connection
 * Shared across all pages. Include after Tailwind CSS CDN.
 *
 * Usage:
 *   <script src="/js/wallet.js"></script>
 *   Then call AgoraWallet.init() after DOM is ready.
 *
 * API:
 *   AgoraWallet.init()              — detect, auto-reconnect, inject wallet button into nav
 *   AgoraWallet.getWalletAddress()  — returns connected pubkey string or null
 *   AgoraWallet.connect()           — trigger connect (opens Phantom popup)
 *   AgoraWallet.disconnect()        — disconnect + clear state
 *   AgoraWallet.signTransaction(tx) — sign a @solana/web3.js Transaction
 *   AgoraWallet.signMessage(msg)    — sign arbitrary Uint8Array message
 *   AgoraWallet.onConnect(cb)       — register connect callback
 *   AgoraWallet.onDisconnect(cb)    — register disconnect callback
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'walletAddress';
  const WALLET_PROVIDER_KEY = 'walletProvider'; // 'phantom' | 'backpack'

  let _provider = null;
  let _address = null;
  let _connectCallbacks = [];
  let _disconnectCallbacks = [];
  let _dropdownOpen = false;

  // ─── Provider Detection ───────────────────────────────────
  function getPhantomProvider() {
    if ('phantom' in window) {
      const p = window.phantom?.solana;
      if (p?.isPhantom) return p;
    }
    return null;
  }

  function getBackpackProvider() {
    if ('backpack' in window) {
      const p = window.backpack;
      if (p) return p;
    }
    // xnft provider (Backpack alternative)
    if (window.xnft?.solana) return window.xnft.solana;
    return null;
  }

  function getProvider(preferredName) {
    if (preferredName === 'backpack') {
      return getBackpackProvider() || getPhantomProvider();
    }
    // Default: prefer Phantom
    return getPhantomProvider() || getBackpackProvider();
  }

  function detectProviderName() {
    if (getPhantomProvider()) return 'phantom';
    if (getBackpackProvider()) return 'backpack';
    return null;
  }

  // ─── Truncate address ─────────────────────────────────────
  function truncateAddress(addr) {
    if (!addr || addr.length < 8) return addr || '';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  }

  // ─── UI Injection ─────────────────────────────────────────
  function injectWalletButton() {
    // Find the nav element (first <nav> on page)
    const nav = document.querySelector('nav .max-w-6xl');
    if (!nav) return;

    // Find the right side container (second child = flex with links)
    const rightSide = nav.querySelector('.flex.items-center.gap-6') ||
                      nav.querySelector('.flex.items-center.gap-4') ||
                      nav.lastElementChild;
    if (!rightSide) return;

    // Don't inject twice
    if (document.getElementById('wallet-btn-container')) return;

    // Create wallet button container
    const container = document.createElement('div');
    container.id = 'wallet-btn-container';
    container.className = 'relative';
    container.innerHTML = `
      <button id="wallet-connect-btn"
              class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
              style="background: #AB9FF2; color: #0f0f23;"
              onmouseenter="this.style.background='#c4b8ff'"
              onmouseleave="this.style.background= this.dataset.connected === 'true' ? 'rgba(171,159,242,0.15)' : '#AB9FF2'"
      >
        <svg width="16" height="16" viewBox="0 0 128 128" fill="currentColor" class="flex-shrink-0">
          <path d="M108.53 68.69C107.29 68.69 106.08 68.89 104.93 69.27L95.89 50.45C95.07 48.73 93.74 47.34 92.07 46.45C90.4 45.56 88.49 45.21 86.61 45.45L72.29 47.27C71.19 44.89 69.37 42.93 67.12 41.64C64.86 40.35 62.26 39.79 59.69 40.04L36.91 42.45C34.48 42.71 32.22 43.77 30.47 45.46C28.73 47.16 27.58 49.38 27.23 51.79L24.71 69.77C22.93 70.33 21.33 71.37 20.11 72.76C18.89 74.16 18.09 75.87 17.8 77.71L15.5 92.01C15.14 94.27 15.65 96.59 16.93 98.49C18.21 100.39 20.16 101.72 22.39 102.17L73.39 112.41C74.09 112.55 74.8 112.63 75.52 112.63C77.52 112.63 79.47 112.01 81.1 110.85C82.73 109.69 83.96 108.05 84.61 106.17L85.53 103.49L99.07 106.21C99.77 106.35 100.48 106.43 101.2 106.43C103.2 106.43 105.15 105.81 106.78 104.65C108.41 103.49 109.64 101.85 110.29 99.97L115.77 83.69C116.55 81.37 116.38 78.85 115.31 76.65C114.23 74.45 112.31 72.75 109.97 71.93C109.55 71.77 108.53 68.69 108.53 68.69Z"/>
        </svg>
        <span id="wallet-btn-text">Connect Wallet</span>
      </button>
      <div id="wallet-dropdown"
           class="absolute right-0 top-full mt-2 w-56 bg-[#1a1a2e] border border-white/10 rounded-xl shadow-xl z-[200] hidden"
           style="backdrop-filter: blur(12px);">
        <div class="p-3 border-b border-white/5">
          <div class="text-xs text-gray-500 mb-1">Connected Wallet</div>
          <div id="wallet-dropdown-addr" class="text-sm text-white font-mono truncate"></div>
        </div>
        <div class="p-1">
          <button id="wallet-copy-btn"
                  class="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded-lg transition flex items-center gap-2">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-width="2"/></svg>
            Copy Address
          </button>
          <button id="wallet-disconnect-btn"
                  class="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-lg transition flex items-center gap-2">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16,17 21,12 16,7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Disconnect
          </button>
        </div>
      </div>
    `;

    rightSide.appendChild(container);

    // Event listeners
    document.getElementById('wallet-connect-btn').addEventListener('click', handleButtonClick);
    document.getElementById('wallet-copy-btn').addEventListener('click', handleCopy);
    document.getElementById('wallet-disconnect-btn').addEventListener('click', handleDisconnect);

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (_dropdownOpen && !container.contains(e.target)) {
        closeDropdown();
      }
    });
  }

  function handleButtonClick(e) {
    e.stopPropagation();
    if (_address) {
      toggleDropdown();
    } else {
      AgoraWallet.connect();
    }
  }

  function toggleDropdown() {
    _dropdownOpen = !_dropdownOpen;
    const dd = document.getElementById('wallet-dropdown');
    if (dd) dd.classList.toggle('hidden', !_dropdownOpen);
  }

  function closeDropdown() {
    _dropdownOpen = false;
    const dd = document.getElementById('wallet-dropdown');
    if (dd) dd.classList.add('hidden');
  }

  async function handleCopy() {
    if (_address) {
      await navigator.clipboard.writeText(_address);
      const btn = document.getElementById('wallet-copy-btn');
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
    closeDropdown();
  }

  async function handleDisconnect() {
    closeDropdown();
    await AgoraWallet.disconnect();
  }

  function updateUI(address) {
    const btn = document.getElementById('wallet-connect-btn');
    const text = document.getElementById('wallet-btn-text');
    const ddAddr = document.getElementById('wallet-dropdown-addr');
    if (!btn || !text) return;

    if (address) {
      text.textContent = truncateAddress(address);
      text.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
      btn.style.background = 'rgba(171,159,242,0.15)';
      btn.style.color = '#AB9FF2';
      btn.dataset.connected = 'true';
      btn.onmouseenter = function() { this.style.background = 'rgba(171,159,242,0.25)'; };
      btn.onmouseleave = function() { this.style.background = 'rgba(171,159,242,0.15)'; };
      if (ddAddr) ddAddr.textContent = address;
    } else {
      text.textContent = 'Connect Wallet';
      text.style.fontFamily = '';
      btn.style.background = '#AB9FF2';
      btn.style.color = '#0f0f23';
      btn.dataset.connected = 'false';
      btn.onmouseenter = function() { this.style.background = '#c4b8ff'; };
      btn.onmouseleave = function() { this.style.background = '#AB9FF2'; };
      closeDropdown();
    }
  }

  // ─── Public API ───────────────────────────────────────────
  const AgoraWallet = {
    /**
     * Initialize wallet: detect providers, auto-reconnect, inject UI.
     * Call once after DOMContentLoaded.
     */
    async init() {
      injectWalletButton();

      // Check for previously connected wallet
      const savedAddress = localStorage.getItem(STORAGE_KEY);
      const savedProvider = localStorage.getItem(WALLET_PROVIDER_KEY) || 'phantom';

      if (savedAddress) {
        // Attempt auto-reconnect
        const provider = getProvider(savedProvider);
        if (provider) {
          try {
            const resp = await provider.connect({ onlyIfTrusted: true });
            const pubkey = resp.publicKey.toString();
            _provider = provider;
            _address = pubkey;
            localStorage.setItem(STORAGE_KEY, pubkey);
            updateUI(pubkey);
            _fireConnect(pubkey);

            // Listen for disconnect events
            provider.on && provider.on('disconnect', () => {
              _address = null;
              _provider = null;
              localStorage.removeItem(STORAGE_KEY);
              localStorage.removeItem(WALLET_PROVIDER_KEY);
              updateUI(null);
              _fireDisconnect();
            });

            provider.on && provider.on('accountChanged', (publicKey) => {
              if (publicKey) {
                const newAddr = publicKey.toString();
                _address = newAddr;
                localStorage.setItem(STORAGE_KEY, newAddr);
                updateUI(newAddr);
                _fireConnect(newAddr);
              } else {
                // Account removed
                AgoraWallet.disconnect();
              }
            });

            return;
          } catch (err) {
            // Auto-reconnect failed (user hasn't approved), clear stored address
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(WALLET_PROVIDER_KEY);
          }
        } else {
          // Provider not installed, clear stored
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(WALLET_PROVIDER_KEY);
        }
      }

      updateUI(null);
    },

    /**
     * Prompt user to connect wallet.
     */
    async connect() {
      const providerName = detectProviderName();
      if (!providerName) {
        // No wallet detected — open Phantom install page
        window.open('https://phantom.app/', '_blank');
        return null;
      }

      const provider = getProvider(providerName);
      if (!provider) {
        window.open('https://phantom.app/', '_blank');
        return null;
      }

      try {
        const resp = await provider.connect();
        const pubkey = resp.publicKey.toString();
        _provider = provider;
        _address = pubkey;
        localStorage.setItem(STORAGE_KEY, pubkey);
        localStorage.setItem(WALLET_PROVIDER_KEY, providerName);
        updateUI(pubkey);
        _fireConnect(pubkey);

        // Listen for events
        provider.on && provider.on('disconnect', () => {
          _address = null;
          _provider = null;
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(WALLET_PROVIDER_KEY);
          updateUI(null);
          _fireDisconnect();
        });

        provider.on && provider.on('accountChanged', (publicKey) => {
          if (publicKey) {
            const newAddr = publicKey.toString();
            _address = newAddr;
            localStorage.setItem(STORAGE_KEY, newAddr);
            updateUI(newAddr);
            _fireConnect(newAddr);
          } else {
            AgoraWallet.disconnect();
          }
        });

        return pubkey;
      } catch (err) {
        console.error('[AgoraWallet] Connect failed:', err);
        return null;
      }
    },

    /**
     * Disconnect wallet and clear state.
     */
    async disconnect() {
      if (_provider) {
        try {
          await _provider.disconnect();
        } catch (err) {
          console.warn('[AgoraWallet] Disconnect error:', err);
        }
      }
      _provider = null;
      _address = null;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(WALLET_PROVIDER_KEY);
      updateUI(null);
      _fireDisconnect();
    },

    /**
     * Get the connected wallet address or null.
     */
    getWalletAddress() {
      return _address;
    },

    /**
     * Sign a Solana transaction (expects @solana/web3.js Transaction).
     */
    async signTransaction(tx) {
      if (!_provider) throw new Error('Wallet not connected');
      return await _provider.signTransaction(tx);
    },

    /**
     * Sign an arbitrary message (Uint8Array).
     */
    async signMessage(message) {
      if (!_provider) throw new Error('Wallet not connected');
      const encoded = typeof message === 'string'
        ? new TextEncoder().encode(message)
        : message;
      const result = await _provider.signMessage(encoded, 'utf8');
      return result;
    },

    /**
     * Register a callback for wallet connect events.
     * Callback receives (address: string).
     */
    onConnect(cb) {
      if (typeof cb === 'function') _connectCallbacks.push(cb);
    },

    /**
     * Register a callback for wallet disconnect events.
     * Callback receives no arguments.
     */
    onDisconnect(cb) {
      if (typeof cb === 'function') _disconnectCallbacks.push(cb);
    },

    /**
     * Check if a wallet provider is available (installed).
     */
    isProviderAvailable() {
      return !!detectProviderName();
    },
  };

  function _fireConnect(address) {
    _connectCallbacks.forEach(cb => {
      try { cb(address); } catch (e) { console.error('[AgoraWallet] onConnect callback error:', e); }
    });
    // Dispatch custom event for other scripts
    window.dispatchEvent(new CustomEvent('agoraWalletConnect', { detail: { address } }));
  }

  function _fireDisconnect() {
    _disconnectCallbacks.forEach(cb => {
      try { cb(); } catch (e) { console.error('[AgoraWallet] onDisconnect callback error:', e); }
    });
    window.dispatchEvent(new CustomEvent('agoraWalletDisconnect'));
  }

  // Export to global scope
  window.AgoraWallet = AgoraWallet;
})();
