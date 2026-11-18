import {
  createPublicClient, createWalletClient, custom, http, parseAbi, formatEther, formatUnits, parseEther, getAddress, isAddress,
} from 'viem';
import { xLayer } from 'viem/chains';
import WB_ABI from './abi/WordBonds.json';
import REG from './abi/HandleRegistry.json';

// ------------------------------------------------------------------ config

const WB = '0x25d816626bd0ab53e468b8f8452b000043f6cb01';
const FROM_BLOCK = 76100143n; // Word Bonds deployment block
const BUILT_REGISTRY = typeof __REGISTRY__ === 'string' ? __REGISTRY__ : '';
const RPC_URL = 'https://rpc.xlayer.tech';
const ACTIVE = 1, KEPT = 2, BROKEN = 3;
const STATE = { 1: 'active', 2: 'kept', 3: 'broken' };
const TX = (h) => `https://www.oklink.com/xlayer/tx/${h}`;
const ADDR = (a) => `https://www.oklink.com/xlayer/address/${a}`;
const tokAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const DAY = 86400;

const WHY = {
  BadDeadline: 'The deadline must be between 1 day and 5 years from now.',
  ZeroBaseline: 'These wallets hold none of this token, so there is nothing to promise.',
  TokenHasNoCode: 'There is no token contract at that address on X Layer.',
  BadWalletCount: 'Add between 1 and 8 wallets.',
  DuplicateWallet: 'A wallet is listed twice.',
  ZeroAddress: 'One of the wallets is the zero address.',
  BadFloor: 'The share to keep must be between 0.01% and 100%.',
  StatementTooLong: 'The promise text is too long.',
  NoBond: 'Enter a bond amount above zero.',
  BalanceReadFailed: 'The token did not answer a balance check. It cannot be used.',
  NotBreached: 'The promise is holding, so there is nothing to challenge.',
  NotReleasable: 'This bond cannot be released yet.',
  NotActive: 'This bond is already closed.',
  BadHandle: 'A handle is 1 to 15 letters, numbers or underscores.',
  BadProof: 'The link must be a post from that same X account, like https://x.com/yourname/status/123.',
  NotEnoughGas: 'Your wallet set the gas limit too low. Try again.',
};

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);
const app = () => $('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortTx = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const num = (x, max = 6) => Number(x).toLocaleString('en-US', { maximumFractionDigits: max });
const okb = (wei) => `${num(formatEther(wei))} OKB`;
const pct = (bps) => `${num(Number(bps) / 100, 2)}%`;
const serial = (id) => `Bond No. ${String(id).padStart(6, '0')}`;
const dateLong = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLocal = (ts) => new Date(Number(ts) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const timeLocal = (ts) => new Date(Number(ts) * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
const when = (ts) => new Date(Number(ts) * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const now = () => Math.floor(Date.now() / 1000);
function left(ts) {
  const s = Number(ts) - now();
  if (s <= 0) return 'deadline passed';
  const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / 3600), m = Math.floor((s % 3600) / 60);
  return d >= 2 ? `${d} days left` : d ? `1 day ${h} h left` : h ? `${h} h ${m} min left` : `${Math.max(m, 1)} min left`;
}
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function why(e) {
  if (!e) return 'Something went wrong.';
  if (e.code === 'CLOSED') return 'No wallet connected. Nothing was sent.';
  if (e.code === -32002) return 'Your wallet already has a request waiting. Open the wallet and finish or reject it.';
  if (e.code === 4001 || /rejected|denied/i.test(e.shortMessage || e.message || '')) return 'You cancelled in your wallet. Nothing was sent.';
  const hit = typeof e.walk === 'function' ? e.walk((x) => x?.data?.errorName) : null;
  const name = hit?.data?.errorName || (e.shortMessage || e.message || '').match(/(\w+)\(\)/)?.[1];
  if (name && WHY[name]) return WHY[name];
  return e.shortMessage || e.message || String(e);
}

// ------------------------------------------------------------------ chain

const S = { bonds: null, tokens: new Map(), claims: new Map(), records: new Map(), events: null, account: null, wc: null, wallet: null };
// The public RPC accepts up to 10 calls per batch.
let rpc = createPublicClient({ chain: xLayer, transport: http(RPC_URL, { batch: { batchSize: 10 }, retryCount: 1, timeout: 15000 }) });

function registry() {
  if (isAddress(BUILT_REGISTRY)) return getAddress(BUILT_REGISTRY);
  try { const r = localStorage.getItem('wb-registry'); if (r && isAddress(r)) return getAddress(r); } catch {}
  return null;
}

async function rd(address, abi, functionName, args = []) {
  try {
    return await rpc.readContract({ address, abi, functionName, args });
  } catch (e) {
    const net = /HttpRequestError|TimeoutError|fetch|network/i.test(`${e.name} ${e.shortMessage} ${e.message}`);
    if (net && S.wallet && W.chainId === '0xc4' && rpc !== S.wallet) { rpc = S.wallet; return rpc.readContract({ address, abi, functionName, args }); }
    throw e;
  }
}

async function token(addr) {
  const k = addr.toLowerCase();
  if (!S.tokens.has(k)) {
    S.tokens.set(k, (async () => {
      const [symbol, decimals] = await Promise.all([rd(addr, tokAbi, 'symbol').catch(() => '?'), rd(addr, tokAbi, 'decimals').catch(() => 18)]);
      return { symbol: String(symbol).slice(0, 12), decimals: Number(decimals) };
    })());
  }
  return S.tokens.get(k);
}

async function claimOf(addr) {
  const reg = registry();
  if (!reg) return null;
  const k = addr.toLowerCase();
  if (!S.claims.has(k)) {
    S.claims.set(k, rd(reg, REG.abi, 'claimOf', [addr]).then(([handle, proof, at]) => (at > 0n ? { handle, proof, at } : null)).catch(() => null));
  }
  return S.claims.get(k);
}

async function record(addr) {
  const [kept, broken, keptValue, brokenValue] = await rd(WB, WB_ABI, 'records', [addr]);
  return { kept: Number(kept), broken: Number(broken), keptValue, brokenValue };
}

async function loadBonds(force) {
  if (S.bonds && !force && Date.now() - S.loadedAt < 30000) return S.bonds;
  const n = Number(await rd(WB, WB_ABI, 'bondCount'));
  const bonds = await Promise.all([...Array(n).keys()].map(async (id) => {
    const b = await rd(WB, WB_ABI, 'getBond', [BigInt(id)]);
    const out = { id, ...b, status: Number(b.status), verdict: null };
    if (out.status === ACTIVE) {
      const v = await rd(WB, WB_ABI, 'check', [BigInt(id)]).catch(() => null);
      if (v) out.verdict = { held: Number(v[0]), breach: v[1], releasable: v[2] };
    }
    return out;
  }));
  await Promise.all(bonds.map(async (b) => { b.token$ = await token(b.token); b.claim = await claimOf(b.maker); }));
  S.bonds = bonds; S.loadedAt = Date.now();
  return bonds;
}

/** Re-read one bond straight from the chain, so a bond page never shows a stale verdict. */
async function freshBond(id) {
  const bonds = await loadBonds();
  const i = bonds.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const b = await rd(WB, WB_ABI, 'getBond', [BigInt(id)]);
  const out = { ...bonds[i], ...b, status: Number(b.status), verdict: null };
  if (out.status === ACTIVE) {
    const v = await rd(WB, WB_ABI, 'check', [BigInt(id)]).catch(() => null);
    if (v) out.verdict = { held: Number(v[0]), breach: v[1], releasable: v[2] };
  }
  bonds[i] = out;
  return out;
}

// X Layer's public RPC serves logs only 100 blocks at a time, so a bond's paper trail
// is found differently: a binary search over past contract state (the RPC keeps full
// history) finds the exact block where the bond was made and where it closed, then
// only those blocks' logs are read. A closed bond's trail never changes, so it is cached.
// Smallest n in (lo, hi] where test(n) holds; test(hi) must hold. Each round asks
// 10 points at once, so a million blocks take about six rounds.
async function firstBlock(test, lo, hi) {
  while (hi - lo > 1n) {
    const span = hi - lo, k = span > 10n ? 10n : span - 1n;
    const pts = [...Array(Number(k)).keys()].map((i) => lo + (span * BigInt(i + 1)) / (k + 1n));
    const res = await Promise.all(pts.map((n) => test(n).catch(() => false)));
    const i = res.indexOf(true);
    if (i < 0) lo = pts[pts.length - 1];
    else { hi = pts[i]; if (i > 0) lo = pts[i - 1]; }
  }
  return hi;
}
const pastRead = (functionName, args, blockNumber) => rpc.readContract({ address: WB, abi: WB_ABI, functionName, args, blockNumber });
async function eventsAt(blockNumber, id) {
  const [logs, blk] = await Promise.all([
    rpc.getContractEvents({ address: WB, abi: WB_ABI, fromBlock: blockNumber, toBlock: blockNumber }),
    rpc.getBlock({ blockNumber }),
  ]);
  return logs.filter((l) => l.args?.bondId !== undefined && Number(l.args.bondId) === id)
    .map((l) => ({ name: l.eventName, args: l.args, tx: l.transactionHash, ts: blk.timestamp }));
}
async function trailOf(b) {
  const key = `wb-trail-${WB}-${b.id}`;
  if (b.status !== ACTIVE) {
    try { const c = localStorage.getItem(key); if (c) return JSON.parse(c, (k, v) => (v && typeof v === 'object' && '$n' in v ? BigInt(v.$n) : v)); } catch {}
  }
  const latest = await rpc.getBlockNumber();
  const madeKey = `wb-made-${WB}-${b.id}`;
  const findMade = async () => {
    try { const c = localStorage.getItem(madeKey); if (c) return BigInt(c); } catch {}
    const n = await firstBlock(async (x) => (await pastRead('bondCount', [], x)) > BigInt(b.id), FROM_BLOCK - 1n, latest);
    try { localStorage.setItem(madeKey, String(n)); } catch {}
    return n;
  };
  // A bond's status before it existed reads as "not active" by accident, so the closing
  // search starts once the bond exists: it runs alongside the first, from its own floor.
  const findClosed = async () => (b.status === ACTIVE ? null
    : firstBlock(async (x) => Number((await pastRead('getBond', [BigInt(b.id)], x)).status) > ACTIVE, FROM_BLOCK - 1n, latest));
  const [made, closed] = await Promise.all([findMade(), findClosed()]);
  let evs = await eventsAt(made, b.id);
  if (closed !== null) {
    evs = evs.concat(await eventsAt(closed, b.id));
    try { localStorage.setItem(key, JSON.stringify(evs, (k, v) => (typeof v === 'bigint' ? { $n: v.toString() } : v))); } catch {}
  }
  return evs;
}

// ------------------------------------------------------------------ wallet
//
// Every injected wallet is found through EIP-6963 (OKX, MetaMask, Rabby, Coinbase, Trust, Bitget…),
// with the old window.ethereum as a fallback. The user picks one; we remember the choice and
// reconnect silently next time. Disconnect revokes the site's permission where the wallet
// supports it and always forgets the session. On a phone without a wallet, we hand the page
// over to the wallet app's own browser.

const XLAYER = { chainId: '0xc4', chainName: 'X Layer Mainnet', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: ['https://www.oklink.com/xlayer'] };
const KNOWN = [
  { rdns: 'com.okex.wallet', name: 'OKX Wallet', install: 'https://web3.okx.com/download', open: (u) => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(u)}` },
  { rdns: 'io.metamask', name: 'MetaMask', install: 'https://metamask.io/download/', open: (u) => `https://metamask.app.link/dapp/${u.replace(/^https?:\/\//, '')}` },
  { rdns: 'com.trustwallet.app', name: 'Trust Wallet', install: 'https://trustwallet.com/download', open: (u) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(u)}` },
  { rdns: 'com.coinbase.wallet', name: 'Coinbase Wallet', install: 'https://www.coinbase.com/wallet/downloads', open: (u) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u)}` },
  { rdns: 'com.bitget.web3', name: 'Bitget Wallet', install: 'https://web3.bitget.com/en/wallet-download' },
  { rdns: 'io.rabby', name: 'Rabby', install: 'https://rabby.io' },
];
const order = (rdns) => { const i = KNOWN.findIndex((k) => rdns.startsWith(k.rdns)); return i < 0 ? 99 : i; };
const W = { found: new Map(), eth: null, rdns: null, name: '', icon: '', chainId: null, off: null };
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

function legacyName(p) {
  if (p.isOkxWallet || p.isOKExWallet) return ['com.okex.wallet', 'OKX Wallet'];
  if (p.isRabby) return ['io.rabby', 'Rabby'];
  if (p.isCoinbaseWallet) return ['com.coinbase.wallet', 'Coinbase Wallet'];
  if (p.isTrust || p.isTrustWallet) return ['com.trustwallet.app', 'Trust Wallet'];
  if (p.isBitKeep || p.isBitgetWallet) return ['com.bitget.web3', 'Bitget Wallet'];
  if (p.isBraveWallet) return ['com.brave.wallet', 'Brave Wallet'];
  if (p.isMetaMask) return ['io.metamask', 'MetaMask'];
  return ['injected', 'Browser wallet'];
}
function discover() {
  addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail || {};
    if (!info?.rdns || !provider) return;
    W.found.set(info.rdns, { rdns: info.rdns, name: info.name, icon: info.icon, provider });
    if ($('wdlg')?.open) renderPicker();
  });
  dispatchEvent(new Event('eip6963:requestProvider'));
}
/** Wallets that never announced themselves still count, through window.ethereum / window.okxwallet. */
function legacy() {
  for (const p of [window.okxwallet, window.ethereum, ...(window.ethereum?.providers || [])]) {
    if (!p?.request) continue;
    const [rdns, name] = legacyName(p);
    if ([...W.found.values()].some((w) => w.provider === p || w.rdns.startsWith(rdns))) continue;
    W.found.set(rdns, { rdns, name, icon: '', provider: p });
  }
  return [...W.found.values()].sort((a, b) => order(a.rdns) - order(b.rdns) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- picker

let pick = null; // { resolve, reject } while the picker is waiting for a choice
function openPicker() {
  return new Promise((resolve, reject) => {
    if (pick) pick.reject(Object.assign(new Error('closed'), { code: 'CLOSED' }));
    pick = { resolve, reject };
    dispatchEvent(new Event('eip6963:requestProvider'));
    renderPicker();
    const d = $('wdlg');
    if (!d.open) d.showModal();
  });
}
function closePicker(reason) {
  const d = $('wdlg'); if (d.open) d.close();
  if (pick) { const p = pick; pick = null; reason ? p.reject(Object.assign(new Error('Wallet selection closed.'), { code: 'CLOSED' })) : p.resolve(); }
}
const avatar = (w) => w.icon ? `<img src="${esc(w.icon)}" alt="" width="28" height="28" data-l="${esc(w.name[0] || '?')}" onerror="this.outerHTML='<span class=wav>'+this.dataset.l+'</span>'">` : `<span class="wav">${esc(w.name[0] || '?')}</span>`;
function renderPicker() {
  const list = legacy(), mobile = isMobile(), here = location.href;
  const installed = list.map((w) => `<button class="wopt" data-rdns="${esc(w.rdns)}">${avatar(w)}<span class="wtxt">${esc(w.name)}${w.rdns === W.rdns ? '<small>Connected</small>' : w.rdns.startsWith('com.okex') ? '<small>X Layer’s home wallet</small>' : ''}</span><i>›</i></button>`).join('');
  const handoff = KNOWN.filter((k) => k.open).map((k) => `<a class="wopt" href="${esc(k.open(here))}" rel="noopener">${avatar(k)}<span class="wtxt">${esc(k.name)}<small>Opens this page in the app</small></span><i>↗</i></a>`).join('');
  const get = KNOWN.map((k) => `<a href="${esc(k.install)}" target="_blank" rel="noopener">${esc(k.name)}</a>`).join(' · ');
  $('wdlg-body').innerHTML = list.length
    ? `<p class="wsec">${mobile ? 'Wallet in this app' : 'Found in this browser'}</p><div class="wlist">${installed}</div>`
    : mobile
      ? `<p class="whelp">Your phone’s browser has no wallet built in. Pick your wallet app and this exact page opens inside it, ready to connect.</p><div class="wlist">${handoff}</div><p class="whelp small">No wallet yet? ${get}</p>`
      : `<p class="whelp">No wallet found in this browser. Install one, then reload this page.</p><div class="wget">${get}</div><p class="whelp small">On a phone? Open this page inside your wallet app’s browser.</p>`;
  $('wdlg-body').querySelectorAll('button.wopt').forEach((b) => (b.onclick = () => choose(b.dataset.rdns)));
}
async function choose(rdns) {
  const w = W.found.get(rdns); if (!w) return;
  const btn = $('wdlg-body').querySelector(`[data-rdns="${CSS.escape(rdns)}"]`);
  btn?.classList.add('busy'); $('wdlg-note').textContent = `Approve the connection in ${w.name}…`;
  try { await useWallet(w); $('wdlg-note').textContent = ''; closePicker(); }
  catch (e) { btn?.classList.remove('busy'); $('wdlg-note').textContent = why(e); }
}

// ---------------------------------------------------------------- session

async function useWallet(w, silent = false) {
  const eth = w.provider;
  const accs = await eth.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
  if (!accs?.length) { if (silent) return false; throw new Error(`${w.name} returned no account. Unlock it and try again.`); }
  W.off?.();
  const onAcc = (a) => (a?.length ? setAccount(a[0]) : forget('Your wallet disconnected this site.'));
  const onChain = (c) => { W.chainId = String(c).toLowerCase(); header(); };
  const onDisc = () => forget('Your wallet disconnected.');
  eth.on?.('accountsChanged', onAcc); eth.on?.('chainChanged', onChain); eth.on?.('disconnect', onDisc);
  W.off = () => { eth.removeListener?.('accountsChanged', onAcc); eth.removeListener?.('chainChanged', onChain); eth.removeListener?.('disconnect', onDisc); };
  Object.assign(W, { eth, rdns: w.rdns, name: w.name, icon: w.icon });
  W.chainId = String(await eth.request({ method: 'eth_chainId' }).catch(() => '')).toLowerCase();
  store.set('wb-wallet', w.rdns); store.set('wb-off', null);
  setAccount(accs[0]);
  if (!silent && W.chainId !== XLAYER.chainId) await switchChain().catch(() => {});
  return true;
}
function setAccount(a) {
  const next = a ? getAddress(a) : null;
  const changed = next !== S.account;
  S.account = next;
  S.wc = next ? createWalletClient({ chain: xLayer, transport: custom(W.eth), account: next }) : null;
  S.wallet = next ? createPublicClient({ chain: xLayer, transport: custom(W.eth) }) : null;
  header();
  if (changed) route();
}
function forget(msg) {
  W.off?.(); W.off = null;
  Object.assign(W, { eth: null, rdns: null, name: '', icon: '', chainId: null });
  setAccount(null);
  if (msg) toast(msg, null, 'ok');
}
async function disconnect() {
  const eth = W.eth;
  try { await eth?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {}
  store.set('wb-off', '1'); store.set('wb-wallet', null);
  forget('Disconnected. Your wallet no longer shares an address with this site.');
}
/** Pick another account inside the same wallet (MetaMask, OKX and others show their account chooser). */
async function switchAccount() {
  try {
    await W.eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    const a = await W.eth.request({ method: 'eth_accounts' });
    if (a?.[0]) setAccount(a[0]);
  } catch (e) { if (e?.code !== 4001) toast(`${W.name} can’t switch accounts from here. Switch inside the wallet and this page follows.`, null, 'bad'); }
}
async function switchChain() {
  try { await W.eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: XLAYER.chainId }] }); }
  catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '');
    if (!unknown) throw e;
    await W.eth.request({ method: 'wallet_addEthereumChain', params: [XLAYER] });
  }
  W.chainId = String(await W.eth.request({ method: 'eth_chainId' })).toLowerCase();
  header();
}

/** Before any transaction: a wallet, the right account, the right network. */
async function needWallet() {
  if (!S.account) await openPicker();
  if (!S.account) throw new Error('Connect a wallet first.');
  const a = await W.eth.request({ method: 'eth_accounts' }).catch(() => []);
  if (!a?.length) { forget(); throw new Error('Your wallet is locked or disconnected. Connect again.'); }
  if (getAddress(a[0]) !== S.account) setAccount(a[0]);
  W.chainId = String(await W.eth.request({ method: 'eth_chainId' })).toLowerCase();
  if (W.chainId !== XLAYER.chainId) {
    toast(`Switch ${W.name} to X Layer Mainnet to continue…`);
    await switchChain();
    if (W.chainId !== XLAYER.chainId) throw new Error('Your wallet is still on another network. Switch to X Layer Mainnet and try again.');
  }
}

async function restore() {
  if (store.get('wb-off')) return;
  await new Promise((r) => setTimeout(r, 350)); // let wallets announce themselves
  const saved = store.get('wb-wallet'), list = legacy();
  const w = (saved && list.find((x) => x.rdns === saved)) || (!saved && list.length === 1 ? list[0] : null);
  if (w) await useWallet(w, true).catch(() => {});
}

// ---------------------------------------------------------------- header menu

function walletMenu() {
  const m = $('wmenu'), wrong = W.chainId && W.chainId !== XLAYER.chainId;
  m.innerHTML = `<div class="wm-head">${avatar({ name: W.name || '?', icon: W.icon })}<div><b>${esc(W.name)}</b><span class="mono">${short(S.account)}</span></div></div>
    <div class="wm-net ${wrong ? 'bad' : ''}"><span>${wrong ? 'On another network' : 'Connected to X Layer Mainnet'}</span>${wrong ? '<button class="btn" id="wm-sw">Switch</button>' : ''}</div>
    <button id="wm-copy">Copy address</button>
    <a href="#maker-${S.account}">My record</a>
    <a href="${ADDR(S.account)}" target="_blank" rel="noopener">View on explorer ↗</a>
    <button id="wm-acc">Switch account</button>
    <button id="wm-wal">Switch wallet</button>
    <button id="wm-off" class="danger">Disconnect</button>`;
  const close = () => { m.hidden = true; $('connect').setAttribute('aria-expanded', 'false'); };
  m.querySelectorAll('a').forEach((a) => (a.onclick = close));
  $('wm-copy').onclick = () => { navigator.clipboard?.writeText(S.account).then(() => toast('Address copied.', null, 'ok')); close(); };
  $('wm-acc').onclick = () => { close(); switchAccount(); };
  $('wm-wal').onclick = () => { close(); openPicker().catch(() => {}); };
  $('wm-off').onclick = () => { close(); disconnect(); };
  if ($('wm-sw')) $('wm-sw').onclick = () => { close(); switchChain().catch(fail); };
  m.hidden = false; $('connect').setAttribute('aria-expanded', 'true');
}

function walletUI() {
  $('connect').onclick = (e) => {
    e.stopPropagation();
    if (!S.account) return openPicker().catch(() => {});
    $('wmenu').hidden ? walletMenu() : ($('wmenu').hidden = true);
  };
  document.addEventListener('click', (e) => { const m = $('wmenu'); if (!m.hidden && !m.contains(e.target)) m.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('wmenu').hidden = true; });
  $('wdlg-x').onclick = () => closePicker('closed');
  $('wdlg').addEventListener('cancel', (e) => { e.preventDefault(); closePicker('closed'); });
  $('wdlg').addEventListener('click', (e) => { if (e.target === $('wdlg')) closePicker('closed'); });
  $('netbar-sw').onclick = () => switchChain().catch(fail);
  discover();
  restore();
}

/** Dry-run, then send, then wait. Every step is shown in the toast. */
async function send(params, label) {
  await needWallet();
  toast(`${label}: checking it will go through…`);
  const { request } = await rpc.simulateContract({ ...params, account: S.account });
  toast(`${label}: confirm in your wallet.`);
  const hash = await S.wc.writeContract(request);
  toast(`${label}: waiting for X Layer…`, hash);
  const r = await rpc.waitForTransactionReceipt({ hash, timeout: 180000 });
  if (r.status !== 'success') throw new Error('The transaction failed on-chain. Nothing changed.');
  toast(`${label}: done.`, hash, 'ok');
  return r;
}

let toastTimer;
function toast(msg, hash, kind = '') {
  const t = $('toast');
  t.className = `toast ${kind}`;
  t.innerHTML = `<span>${esc(msg)}</span>${hash ? `<a href="${TX(hash)}" target="_blank" rel="noopener">View transaction</a>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (kind) toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 12000 : 7000);
}
const fail = (e) => toast(why(e), null, 'bad');

// ------------------------------------------------------------------ pieces

function seal(state, pop) {
  const word = { active: 'ACTIVE', broken: 'BROKEN', breach: 'BROKEN', kept: 'KEPT', draft: 'DRAFT' }[state];
  const sub = { active: 'bond held', broken: 'bond slashed', breach: 'challenge open', kept: 'bond returned', draft: 'not yet signed' }[state];
  const ring = state === 'breach' ? 'BROKEN · OPEN TO CHALLENGE · BROKEN · OPEN TO CHALLENGE · ' : state === 'broken' ? 'PROMISE BROKEN · BOND SLASHED · PROMISE BROKEN · BOND SLASHED · ' : 'WORD BONDS · X LAYER · TAPEOUT CIRCUIT 19 · WORD BONDS · X LAYER · ';
  const rid = 'r' + Math.random().toString(36).slice(2, 8);
  return `<svg class="seal ${state === 'breach' ? 'broken' : state}${pop ? ' pop' : ''}" viewBox="0 0 132 132" role="img" aria-label="Status: ${word}"><defs><path id="${rid}" d="M66,66 m-52,0 a52,52 0 1,1 104,0 a52,52 0 1,1 -104,0"/></defs>
  <circle cx="66" cy="66" r="63" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="66" cy="66" r="59.5" fill="none" stroke="currentColor" stroke-width=".6"/>
  <circle cx="66" cy="66" r="43" fill="none" stroke="currentColor" stroke-width=".6" ${state === 'active' || state === 'draft' ? 'stroke-dasharray="2 3"' : ''}/>
  <text font-size="7.4" letter-spacing="1.6" font-weight="500"><textPath href="#${rid}" textLength="322">${ring}</textPath></text>
  <text x="66" y="68" text-anchor="middle" font-size="17" font-weight="600" letter-spacing="2">${word}</text>
  <text x="66" y="82" text-anchor="middle" font-size="7.5" letter-spacing="1.2">${sub.toUpperCase()}</text></svg>`;
}

const who = (addr, claim) => claim
  ? `<a href="#maker-${addr}" class="who-link">@${esc(claim.handle)}</a>`
  : `<a href="#maker-${addr}" class="mono who-link">${short(addr)}</a>`;

function card(b) {
  const st = STATE[b.status];
  const right = b.status === ACTIVE ? `<span data-deadline="${b.deadline}">${left(b.deadline)}</span>` : st === 'kept' ? 'returned to maker' : 'slashed';
  return `<a class="card" href="#bond-${b.id}"><canvas aria-hidden="true"></canvas><div class="card-in">
    <div class="card-top"><span class="label">${serial(b.id)}</span><span class="pill ${st}">${st}</span></div>
    <q>${esc(b.statement || 'No statement')}</q>
    <div class="card-by">${b.claim ? `@${esc(b.claim.handle)}` : `<span class="mono">${short(b.maker)}</span>`}</div>
    <div class="card-foot"><span><b>${okb(b.amount)}</b> ${b.status === BROKEN ? '' : b.status === KEPT ? '' : 'locked'}</span><span>${right}</span></div></div></a>`;
}

const ghost = `<a class="card ghost" href="#make"><b>Your promise here</b><span>Bond it and it joins the record.</span></a>`;

function guilloche(c, seed) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  x.strokeStyle = getComputedStyle(c).getPropertyValue('--engrave').trim() || '#0e5b45'; x.lineWidth = .6;
  const waves = Math.max(6, Math.round(w / 34));
  for (let k = 0; k < 9; k++) {
    x.globalAlpha = .2 + .05 * (k % 3); x.beginPath();
    for (let px = 0; px <= w; px += 1.5) {
      const t = px / w * Math.PI * 2;
      const y = h / 2 + Math.sin(t * waves + k * .7 + seed) * (h / 2 - 3) * Math.cos(t * 3 + k * .35);
      px ? x.lineTo(px, y) : x.moveTo(px, y);
    }
    x.stroke();
  }
}
const draw = () => document.querySelectorAll('canvas').forEach((c, i) => guilloche(c, (i % 2) * 1.6));

function header() {
  const a = S.account, c = $('connect');
  c.innerHTML = a ? `${W.icon ? `<img src="${esc(W.icon)}" alt="" width="16" height="16">` : ''}<span class="mono">${short(a)}</span><i aria-hidden="true">▾</i>` : 'Connect wallet';
  c.title = a ? `${W.name}: ${a}` : '';
  c.setAttribute('aria-haspopup', a ? 'menu' : 'dialog');
  $('mine').hidden = !a;
  if (a) $('mine').href = `#maker-${a}`;
  const wrong = !!(a && W.chainId && W.chainId !== '0xc4');
  $('netbar').hidden = !wrong;
  if (wrong) $('netbar-name').textContent = W.name;
  if (!a) $('wmenu').hidden = true;
}

const loading = (what) => `<div class="loading"><span class="dot"></span>Reading ${esc(what)} from X Layer…</div>`;
const problem = (e) => `<div class="soon"><h2>Could not reach X Layer</h2><p>${esc(why(e))}</p><p><button class="btn line" onclick="location.reload()">Try again</button></p></div>`;

// ------------------------------------------------------------------ pages

let seq = 0;

async function home() {
  const tk = ++seq;
  app().innerHTML = `
  <section class="hero">
    <div>
      <h1>Put money behind <em>your word.</em></h1>
      <p class="lede">Lock a bond behind a public promise about your tokens. A circuit on X Layer watches the wallets. Keep the promise and the bond comes back to you. Break it and the bond burns, on the record, for good.</p>
      <div class="cta"><a class="btn" href="#make">Make a bond</a><a class="btn line" href="#maker">Look up a founder or KOL</a></div>
    </div>
    <div class="demo" id="demo">
      <span class="demo-tag">Demo. Drag to sell.</span>
      <article class="cert">
        <canvas aria-hidden="true"></canvas>
        <div class="cert-in">
          <p class="statement">“Our team wallets will keep at least 80% of their tokens until 1 March 2027.”</p>
          <div class="signed">
            <div class="try">
              <label for="sell"><span class="label">Team wallets hold</span><b id="d-held">100%</b></label>
              <div class="meter" id="d-meter"><i id="d-fill" style="width:100%"></i><u style="left:calc(80% - 1px)"></u></div>
              <input type="range" id="sell" min="0" max="100" value="100" step="1" aria-label="Share of tokens the team wallets still hold">
            </div>
            <div id="d-seal"></div>
          </div>
          <p class="outcome" id="d-out"></p>
        </div>
        <canvas aria-hidden="true"></canvas>
      </article>
    </div>
  </section>
  <dl class="tally" id="tally"><div><dt class="label">Bonds made</dt><dd>…</dd></div><div><dt class="label">Bonded so far</dt><dd>…</dd></div><div><dt class="label">Active</dt><dd>…</dd></div><div><dt class="label">Kept</dt><dd>…</dd></div><div><dt class="label">Broken</dt><dd>…</dd></div></dl>
  <section class="sec">
    <div class="sec-head"><h2>On the record</h2><p>Every bond is public. Open one to see its verdict and paper trail.</p></div>
    <div class="wall" id="wall">${loading('the record')}</div>
  </section>
  <section class="sec" id="how">
    <div class="sec-head"><h2>How a verdict is reached</h2><p>No votes, no committee, no admin key.</p></div>
    <ol class="steps">
      <li><b>The promise is fixed</b>The maker names the token, the wallets, the share they will keep and the date. After signing, none of it can be changed, by them or by us.</li>
      <li><b>Anyone can check it</b>The contract reads the wallets and asks a TapeOut circuit one question: are they under the floor? Whoever catches a breach earns 10% of the bond.</li>
      <li><b>The circuit decides</b>Under the floor, the bond is slashed and 90% is burned. Past the deadline with the promise intact, the full bond returns to the maker.</li>
    </ol>
  </section>
  <section class="sec">
    <div class="sec-head"><h2>Who it is for</h2></div>
    <div class="who">
      <div><b>Founders</b>Saying "the team is not selling" costs nothing. Bonding it costs something, and holders can see the difference.</div>
      <div><b>KOLs</b>Show you still hold what you called, with a stake that burns if you quietly exit.</div>
      <div><b>Holders</b>Search a handle before you trust it: promises kept, promises broken, and how much was at stake each time.</div>
    </div>
  </section>`;
  demoState = ''; demo(); $('sell').addEventListener('input', demo); draw();
  if (location.hash === '#how') $('how').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth' });
  try {
    const bonds = await loadBonds();
    if (tk !== seq) return;
    const count = (s) => bonds.filter((b) => b.status === s).length;
    const total = bonds.reduce((a, b) => a + b.amount, 0n);
    $('tally').innerHTML = [['Bonds made', bonds.length], ['Bonded so far', `${num(formatEther(total), 4)} <small>OKB</small>`], ['Active', count(ACTIVE)], ['Kept', count(KEPT)], ['Broken', count(BROKEN)]]
      .map(([k, v]) => `<div><dt class="label">${k}</dt><dd>${v}</dd></div>`).join('');
    $('wall').innerHTML = [...bonds].reverse().slice(0, 11).map(card).join('') + ghost;
    draw();
  } catch (e) {
    if (tk === seq) $('wall').innerHTML = problem(e);
  }
}

let demoState = '';
function demo() {
  const held = Number($('sell').value), state = held < 80 ? 'broken' : 'active';
  $('d-held').textContent = held + '%'; $('d-fill').style.width = held + '%';
  $('d-meter').className = 'meter' + (state === 'broken' ? ' bad' : ''); $('demo').classList.toggle('bad', state === 'broken');
  if (state !== demoState) { $('d-seal').innerHTML = seal(state, demoState !== ''); demoState = state; }
  $('d-out').innerHTML = state === 'active'
    ? (held === 100 ? 'The promise is holding. Drag the handle left to see what selling does.' : 'Still above the 80% floor. <b>Nothing can touch the bond.</b>')
    : 'Under the floor. Anyone can challenge now: <b>90% of the bond burns</b>, 10% goes to whoever caught it, and the breach stays on the maker’s record.';
}

async function bondPage(id) {
  const tk = ++seq;
  app().innerHTML = `<a class="back" href="#home">← All bonds</a>${loading('this bond')}`;
  let bonds, b;
  try { bonds = await loadBonds(); b = await freshBond(id); } catch (e) { if (tk === seq) app().innerHTML = problem(e); return; }
  if (tk !== seq) return;
  if (!b) { app().innerHTML = `<div class="soon"><h2>No bond ${id} yet</h2><p>There are ${bonds.length} bonds on the record.</p><p><a class="back" href="#home">← Back to the record</a></p></div>`; return; }
  const st = STATE[b.status], T = b.token$, v = b.verdict;
  const rec = await record(b.maker).catch(() => null);
  if (tk !== seq) return;
  const held = v ? v.held : null;
  const holdHTML = (h, label) => `<div class="hold">
          <div class="hold-top"><span class="label">${label}, against the day the bond was made</span><b>${pct(h)}</b></div>
          <div class="meter${h < b.floorBps ? ' bad' : ''}"><i style="width:${Math.min(h / 100, 100)}%"></i><u style="left:calc(${b.floorBps / 100}% - 1px)"></u></div>
          <div class="scale"><span style="left:0">0%</span><span style="left:${b.floorBps / 100}%">floor ${pct(b.floorBps)}</span><span style="left:100%">100%</span></div>
        </div>`;
  const isMaker = S.account && S.account.toLowerCase() === b.maker.toLowerCase();
  const V = st === 'active'
    ? (v?.breach
      ? ['The promise is broken.', `The wallets hold ${pct(held)} of their starting balance, under the ${pct(b.floorBps)} floor. Anyone can challenge now and earn 10% of the bond.`, 'Yes', 'yes', 'No']
      : v?.releasable
        ? ['The promise was kept.', `The deadline has passed with the wallets at ${pct(held)}. Anyone can release the bond back to the maker.`, 'No', 'ok', 'Yes, now']
        : ['The promise is holding.', `The wallets hold ${pct(held ?? 0)} of their starting balance. The floor is ${pct(b.floorBps)}.`, 'No', 'ok', 'After the deadline'])
    : st === 'broken'
      ? ['The promise was broken.', `The wallets fell ${held !== null ? `to ${pct(held)}, ` : ''}under the ${pct(b.floorBps)} floor and the bond was slashed.`, 'Yes', 'yes', 'No']
      : ['The promise was kept.', 'The wallets stayed above the floor until the deadline. The bond went back to the maker.', 'No', 'ok', 'Released'];
  const shareText = isMaker
    ? `I've put money behind my word: "${b.statement}"\n\n${okb(b.amount)} is locked on X Layer. If I break it, it burns.`
    : `This promise is bonded on X Layer: "${b.statement}"\n\n${okb(b.amount)} is locked behind it.`;
  const share = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(location.href.split('#')[0] + '#bond-' + id)}`;
  app().innerHTML = `
  <a class="back" href="#home">← All bonds</a>
  <div class="grid">
    <article class="cert">
      <canvas aria-hidden="true"></canvas>
      <div class="cert-in">
        <div class="cert-head"><span class="label">${serial(id)}</span><span class="label">X Layer mainnet · chain 196</span></div>
        <div><p class="label" style="margin:0 0 10px">Public promise</p><p class="statement">“${esc(b.statement)}”</p></div>
        <div class="signed">
          <dl>
            <div><dt class="label">Made by</dt><dd>${b.claim ? `<a href="#maker-${b.maker}" class="handle">@${esc(b.claim.handle)}</a> · ` : ''}<a href="#maker-${b.maker}" class="mono">${b.maker}</a></dd></div>
            <div><dt class="label">Wallets watched</dt><dd class="mono">${b.wallets.map((w) => `<a href="${ADDR(w)}" target="_blank" rel="noopener">${short(w)}</a>`).join(' · ')}</dd></div>
          </dl>
          <div>${seal(st === 'active' && v?.breach ? 'breach' : st, true)}</div>
        </div>
        <dl class="facts">
          <div><dt class="label">Bond locked</dt><dd>${okb(b.amount)}<small>${st === 'broken' ? 'slashed' : st === 'kept' ? 'returned to maker' : 'held by the contract'}</small></dd></div>
          <div><dt class="label">Must keep</dt><dd>${pct(b.floorBps)}<small>of ${num(formatUnits(b.baseline, T.decimals), 4)} ${esc(T.symbol)}</small></dd></div>
          <div><dt class="label">Until</dt><dd>${dayLocal(b.deadline)}<small>${timeLocal(b.deadline)} · ${st === 'active' ? `<span data-deadline="${b.deadline}">${left(b.deadline)}</span>` : 'closed'}</small></dd></div>
          <div><dt class="label">Token</dt><dd>${esc(T.symbol)}<small class="mono"><a href="${ADDR(b.token)}" target="_blank" rel="noopener">${short(b.token)}</a></small></dd></div>
        </dl>
        <div id="hold-slot">${held !== null ? holdHTML(held, 'Held now') : ''}</div>
      </div>
      <canvas aria-hidden="true"></canvas>
    </article>
    <aside class="side">
      <section class="panel">
        <span class="label">Verdict from the circuit</span>
        <h2>${V[0]}</h2><p>${V[1]}</p>
        <dl class="kv"><dt>Promise broken</dt><dd class="${V[3]}">${V[2]}</dd><dt>Bond can be released</dt><dd>${V[4]}</dd><dt>Decided by</dt><dd class="mono">TapeOut circuit 19</dd></dl>
      </section>
      <section class="panel">
        <span class="label">Actions</span>
        <div class="acts">
          <button class="btn" id="a-challenge" ${st === 'active' && v?.breach ? '' : 'disabled'}>Challenge and earn ${okb(b.amount / 10n)}</button>
          <p class="note">${st !== 'active' ? 'This bond is closed.' : v?.breach ? 'The wallets are under the floor. The first person to challenge gets the bounty.' : 'Nothing to challenge while the wallets stay above the floor.'}</p>
          <button class="btn line" id="a-release" ${st === 'active' && v?.releasable ? '' : 'disabled'}>Release to maker</button>
          <p class="note">${st !== 'active' ? 'This bond is closed.' : v?.releasable ? 'Anyone can press this. The bond goes to the maker, not to you.' : `Opens ${when(b.deadline)} if the promise still holds.`}</p>
          <a class="btn line" href="${share}" target="_blank" rel="noopener">Share on X</a>
          <button class="btn line" id="a-copy">Copy link</button>
        </div>
      </section>
      <section class="panel">
        <span class="label">Maker’s record</span>
        ${rec ? `<dl class="kv"><dt>Promises kept</dt><dd>${rec.kept}</dd><dt>Promises broken</dt><dd>${rec.broken}</dd><dt>Value kept</dt><dd>${okb(rec.keptValue)}</dd><dt>Value broken</dt><dd>${okb(rec.brokenValue)}</dd></dl>` : '<p>Could not read the record.</p>'}
        <a class="back" href="#maker-${b.maker}">See every bond by this maker →</a>
      </section>
    </aside>
  </div>
  <section class="sec"><h2>Paper trail</h2><div class="rows" id="trail">${loading('the paper trail')}</div></section>
  <section class="sec">
    <h2>What this bond does not prove</h2>
    <ul class="limits">
      <li><b>Whose wallets these are</b>It proves the listed wallets kept holding. It does not prove they are the maker’s only wallets.</li>
      <li><b>That nobody sold and bought back</b>A breach counts only if someone challenges while the wallets are under the floor.</li>
      <li><b>That the token reports honestly</b>The rule trusts the token’s own balance figures. Rebasing tokens are not supported.</li>
    </ul>
  </section>`;
  draw();
  $('a-copy').onclick = async () => { const el = $('a-copy'); try { await navigator.clipboard.writeText(location.href.split('#')[0] + '#bond-' + id); el.textContent = 'Link copied'; } catch { el.textContent = 'Copy blocked here'; } setTimeout(() => (el.textContent = 'Copy link'), 1800); };
  $('a-challenge').onclick = act(() => send({ address: WB, abi: WB_ABI, functionName: 'challenge', args: [BigInt(id)] }, 'Challenge'), id);
  $('a-release').onclick = act(() => send({ address: WB, abi: WB_ABI, functionName: 'release', args: [BigInt(id)] }, 'Release'), id);
  let evs = null;
  try { evs = await trailOf(b); } catch {}
  if (tk !== seq) return;
  const rows = [];
  if (evs && evs.length) {
    for (const e of evs) {
      if (e.name === 'BondCreated') rows.push([e.ts, `Bond made. ${okb(e.args.amount)} locked after the 1% fee.`, e.tx]);
      if (e.name === 'BondBroken') {
        rows.push([e.ts, `Challenged at ${pct(e.args.heldBps)} held. Circuit ruled the promise broken. ${okb(e.args.slashed)} burned, ${okb(e.args.bounty)} paid to the challenger.`, e.tx]);
        if (held === null) $('hold-slot').innerHTML = holdHTML(Number(e.args.heldBps), 'Held when challenged');
      }
      if (e.name === 'BondKept') rows.push([e.ts, `Released after the deadline. ${okb(e.args.amount)} returned to the maker.`, e.tx]);
    }
  } else {
    rows.push([b.createdAt, `Bond made. ${okb(b.amount)} locked after the 1% fee.`, null]);
  }
  $('trail').innerHTML = rows.map(([t, what, h]) => `<div class="row"><time>${when(t)}</time><span>${what}</span>${h ? `<a href="${TX(h)}" target="_blank" rel="noopener">${shortTx(h)}</a>` : `<a href="${ADDR(WB)}" target="_blank" rel="noopener">On the explorer</a>`}</div>`).join('');
}

const act = (fn, id) => async (ev) => {
  const btn = ev.currentTarget; btn.disabled = true;
  try { await fn(); S.claims.clear(); S.events = null; await loadBonds(true); location.hash === `#bond-${id}` ? bondPage(id) : route(); }
  catch (e) { fail(e); btn.disabled = false; }
};

// ------------------------------------------------------------------ make

const F = { token: null, balances: [], err: {} };

function minDeadlineDate() {
  const d = new Date((now() + DAY + 900) * 1000);
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  return new Date(noon / 1000 >= now() + DAY + 900 ? noon : noon + DAY * 1000);
}
const iso = (d) => d.toISOString().slice(0, 10);

async function makePage() {
  ++seq;
  const min = minDeadlineDate(), def = new Date(min.getTime() + 29 * DAY * 1000), max = new Date((now() + 5 * 365 * DAY - DAY) * 1000);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('wb-draft') || '{}'); } catch {}
  app().innerHTML = `
  <div class="sec-head"><h1 class="page-title">Make a bond</h1><p>The certificate shows exactly what people will see once you sign.</p></div>
  <div class="make">
    <form class="form" id="form" novalidate>
      <div class="field">
        <label for="f-token">Token</label>
        <input id="f-token" class="mono" placeholder="0x… token address on X Layer" autocomplete="off" spellcheck="false" value="${esc(saved.token || '')}">
        <p class="hint" id="h-token">The token your promise is about.</p>
      </div>
      <div class="field">
        <label for="f-voice">Who is promising</label>
        <select id="f-voice"><option value="team">Our team</option><option value="me">I (personal)</option></select>
      </div>
      <div class="field">
        <label for="f-wallets">Wallets to watch</label>
        <textarea id="f-wallets" class="mono" rows="3" placeholder="One address per line, up to 8" spellcheck="false">${esc(saved.wallets || '')}</textarea>
        <p class="hint" id="h-wallets">The contract adds up what these wallets hold today. That total is the starting balance.</p>
      </div>
      <div class="two">
        <div class="field"><label for="f-floor">Keep at least</label><div class="suffix"><input id="f-floor" type="number" inputmode="decimal" min="0.01" max="100" step="0.01" value="${esc(saved.floor || '80')}"><span>%</span></div><p class="hint" id="h-floor"></p></div>
        <div class="field"><label for="f-date">Until</label><input id="f-date" type="date" min="${iso(min)}" max="${iso(max)}" value="${esc(saved.date && saved.date >= iso(min) ? saved.date : iso(def))}"><p class="hint">12:00 UTC on that day.</p></div>
      </div>
      <div class="field">
        <label for="f-amount">Bond</label>
        <div class="suffix"><input id="f-amount" type="number" inputmode="decimal" min="0" step="0.001" value="${esc(saved.amount || '0.05')}"><span>OKB</span></div>
        <p class="hint" id="h-amount"></p>
      </div>
      <div class="sum" id="sum"></div>
      <button class="btn big" id="f-submit" type="submit">Sign and lock the bond</button>
      <p class="hint" id="h-submit"></p>
    </form>
    <div class="preview-col">
      <span class="label">Preview</span>
      <article class="cert" id="p-cert">
        <canvas aria-hidden="true"></canvas>
        <div class="cert-in">
          <div class="cert-head"><span class="label">Bond No. — not yet signed</span><span class="label">X Layer mainnet</span></div>
          <div><p class="label" style="margin:0 0 10px">Public promise</p><p class="statement" id="p-statement"></p></div>
          <div class="signed"><dl><div><dt class="label">Made by</dt><dd class="mono" id="p-maker"></dd></div><div><dt class="label">Wallets watched</dt><dd class="mono" id="p-wallets"></dd></div></dl><div>${seal('draft')}</div></div>
          <dl class="facts">
            <div><dt class="label">Bond locked</dt><dd id="p-amount"></dd></div>
            <div><dt class="label">Must keep</dt><dd id="p-floor"></dd></div>
            <div><dt class="label">Until</dt><dd id="p-date"></dd></div>
            <div><dt class="label">Token</dt><dd id="p-token"></dd></div>
          </dl>
        </div>
        <canvas aria-hidden="true"></canvas>
      </article>
    </div>
  </div>`;
  $('f-voice').value = saved.voice || 'team';
  if (!$('f-wallets').value && S.account) $('f-wallets').value = S.account;
  draw();
  let t, wantDeep = false;
  const onChange = (deep) => {
    wantDeep = wantDeep || deep; clearTimeout(t);
    t = setTimeout(() => { const d = wantDeep; wantDeep = false; refreshForm(d).catch(fail); }, wantDeep ? 350 : 0);
  };
  for (const id of ['f-voice', 'f-floor', 'f-date', 'f-amount']) $(id).addEventListener('input', () => onChange(false));
  for (const id of ['f-token', 'f-wallets']) $(id).addEventListener('input', () => onChange(true));
  $('form').addEventListener('submit', (e) => { e.preventDefault(); submitBond().catch(fail); });
  refreshForm(true).catch(fail);
}

function readForm() {
  const ws = $('f-wallets').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const date = $('f-date').value;
  const deadline = date ? Math.floor(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12) / 1000) : 0;
  const floor = Number($('f-floor').value);
  let value = 0n;
  try { value = parseEther(String($('f-amount').value || '0')); } catch {}
  return { tokenIn: $('f-token').value.trim(), ws, voice: $('f-voice').value, floor, floorBps: Math.round(floor * 100), deadline, date, value };
}

function statementOf(f) {
  const me = f.voice === 'me', sym = F.token?.symbol || 'tokens', n = f.ws.length || 1;
  const where = n === 1 ? (me ? 'my wallet' : 'our wallet') : `${me ? 'my' : 'our'} ${n} declared wallets`;
  return `${me ? 'I' : 'Our team'} will keep at least ${num(f.floor || 0, 2)}% of ${me ? 'my' : 'our'} ${sym} in ${where} until 12:00 UTC on ${f.deadline ? dateLong(f.deadline) : '…'}.`;
}

let formSeq = 0;
async function refreshForm(deep) {
  const mySeq = ++formSeq;
  const f = readForm(), err = {};
  try { localStorage.setItem('wb-draft', JSON.stringify({ token: f.tokenIn, wallets: $('f-wallets').value, voice: f.voice, floor: $('f-floor').value, date: f.date, amount: $('f-amount').value })); } catch {}
  if (deep) {
    F.token = null; F.balances = [];
    if (isAddress(f.tokenIn)) {
      $('h-token').textContent = 'Reading the token…';
      const code = await rpc.getCode({ address: f.tokenIn }).catch(() => null);
      if (!code || code === '0x') err.token = 'No token contract at this address on X Layer.';
      else F.token = { address: getAddress(f.tokenIn), ...(await token(f.tokenIn)) };
    } else if (f.tokenIn) err.token = 'That is not a valid address.';
    const okWs = f.ws.filter(isAddress);
    if (F.token && okWs.length) F.balances = await Promise.all(okWs.map((w) => rd(F.token.address, tokAbi, 'balanceOf', [w]).catch(() => null)));
    if (mySeq !== formSeq) return; // a newer edit is already being checked
    F.checked = { token: f.tokenIn.toLowerCase(), wallets: f.ws.join(',').toLowerCase() };
  }
  if (!f.tokenIn) err.token = 'Paste the token’s contract address.';
  const stale = !F.checked || F.checked.token !== f.tokenIn.toLowerCase() || F.checked.wallets !== f.ws.join(',').toLowerCase();
  if (!f.ws.length) err.wallets = 'Add at least one wallet.';
  else if (f.ws.length > 8) err.wallets = 'Up to 8 wallets.';
  else if (f.ws.some((w) => !isAddress(w))) err.wallets = `Not a valid address: ${f.ws.find((w) => !isAddress(w)).slice(0, 14)}…`;
  else if (new Set(f.ws.map((w) => w.toLowerCase())).size !== f.ws.length) err.wallets = 'A wallet is listed twice.';
  if (!(f.floorBps >= 1 && f.floorBps <= 10000)) err.floor = 'Between 0.01% and 100%.';
  if (!f.deadline || f.deadline < now() + DAY + 300) err.date = 'At least a day away.';
  if (f.value === 0n) err.amount = 'Enter an amount.';
  const T = F.token;
  const baseline = F.balances.length && F.balances.every((x) => x !== null) ? F.balances.reduce((a, b) => a + b, 0n) : null;
  if (T && F.balances.some((x) => x === null)) err.wallets = 'The token did not answer for one of these wallets.';
  if (T && baseline === 0n && !err.wallets) err.wallets = `These wallets hold no ${T.symbol}, so there is nothing to promise.`;
  if (!err.token && !err.wallets && (stale || !F.token || baseline === null)) err.check = 'Checking the token and wallets…';
  F.err = err;

  const fee = (f.value * 100n) / 10000n, locked = f.value - fee;
  $('h-token').innerHTML = err.token ? `<span class="bad">${esc(err.token)}</span>` : T ? `<b>${esc(T.symbol)}</b>, ${T.decimals} decimals.` : 'The token your promise is about.';
  $('h-wallets').innerHTML = err.wallets ? `<span class="bad">${esc(err.wallets)}</span>`
    : baseline !== null ? `Together they hold <b>${num(formatUnits(baseline, T.decimals), 4)} ${esc(T.symbol)}</b> today. That is the starting balance.`
      : 'The contract adds up what these wallets hold today. That total is the starting balance.';
  $('h-floor').innerHTML = err.floor ? `<span class="bad">${esc(err.floor)}</span>` : baseline ? `Breaks if they drop under ${num(formatUnits((baseline * BigInt(f.floorBps)) / 10000n, T.decimals), 4)} ${esc(T.symbol)}.` : '';
  $('h-amount').innerHTML = err.amount ? `<span class="bad">${esc(err.amount)}</span>` : `1% fee (${okb(fee)}). ${okb(locked)} is locked.`;
  $('sum').innerHTML = `<b>If you keep it:</b> ${okb(locked)} comes back after the deadline.<br><b>If you break it:</b> anyone can challenge. 90% burns, 10% goes to them, and it stays on your record.`;

  const st = statementOf(f);
  $('p-statement').textContent = `“${st}”`;
  $('p-maker').textContent = S.account || 'your wallet, once connected';
  $('p-wallets').textContent = f.ws.length ? f.ws.map((w) => (isAddress(w) ? short(w) : w.slice(0, 8) + '…')).join(' · ') : '—';
  $('p-amount').innerHTML = `${f.value ? okb(locked) : '—'}<small>held by the contract</small>`;
  $('p-floor').innerHTML = `${num(f.floor || 0, 2)}%<small>of ${baseline !== null ? `${num(formatUnits(baseline, T.decimals), 4)} ${esc(T.symbol)}` : 'the starting balance'}</small>`;
  $('p-date').innerHTML = `${f.deadline ? dateLong(f.deadline) : '—'}<small>12:00 UTC</small>`;
  $('p-token').innerHTML = `${T ? esc(T.symbol) : '—'}<small class="mono">${T ? short(T.address) : ''}</small>`;
  const first = Object.values(err)[0];
  $('f-submit').disabled = !!first;
  $('h-submit').innerHTML = first ? esc(first) : S.account ? 'Your wallet will show the amount before anything is sent.' : 'You will be asked to connect a wallet first.';
}

async function submitBond() {
  await needWallet();
  await refreshForm(true);
  if (Object.keys(F.err).length) return;
  const f = readForm();
  const statement = statementOf(f);
  const r = await send({ address: WB, abi: WB_ABI, functionName: 'createBond', value: f.value,
    args: [0, F.token.address, f.ws.map(getAddress), f.floorBps, BigInt(f.deadline), statement] }, 'Bond');
  try { localStorage.removeItem('wb-draft'); } catch {}
  S.events = null;
  const bonds = await loadBonds(true);
  const mine = [...bonds].reverse().find((b) => b.maker === S.account);
  location.hash = mine ? `#bond-${mine.id}` : '#home';
  return r;
}

// ------------------------------------------------------------------ makers

async function searchPage(q = '', note = '') {
  ++seq;
  app().innerHTML = `
  <div class="lookup">
    <h1 class="page-title">Look up a founder or KOL</h1>
    <p class="lede">Search an X handle or a wallet. You will see every promise they bonded, which ones they kept, and which ones they broke.</p>
    <form id="q-form" class="q"><input id="q" placeholder="@handle or 0x… wallet" autocomplete="off" spellcheck="false" value="${esc(q)}" aria-label="X handle or wallet address"><button class="btn" type="submit">Search</button></form>
    <p class="hint" id="q-note">${esc(note)}</p>
    ${registry() ? '' : '<p class="hint">Handle search turns on once the handle registry is live. Wallet search works now.</p>'}
  </div>`;
  $('q-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('q').value.trim().replace(/^https?:\/\/(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?]/)[0];
    if (isAddress(v)) location.hash = `#maker-${getAddress(v)}`;
    else if (/^[A-Za-z0-9_]{1,15}$/.test(v)) location.hash = `#at-${v}`;
    else $('q-note').textContent = 'Enter an X handle like @baronoffweb3, or a 0x wallet address.';
  };
  $('q').focus({ preventScroll: true });
}

async function handlePage(handle) {
  const tk = ++seq, reg = registry();
  if (!reg) return searchPage('@' + handle, 'Handle search is not live yet. Search by wallet address for now.');
  app().innerHTML = loading('@' + handle);
  try {
    const list = await rd(reg, REG.abi, 'claimants', [handle, 0n, 50n]);
    const claims = (await Promise.all(list.map(async (a) => ({ a, c: await claimOf(a) })))).filter((x) => x.c && x.c.handle.toLowerCase() === handle.toLowerCase());
    if (tk !== seq) return;
    if (!claims.length) return searchPage('@' + handle, `Nobody has claimed @${handle} yet.`);
    if (claims.length === 1) return makerPage(claims[0].a, true);
    app().innerHTML = `<div class="lookup"><h1 class="page-title">${claims.length} wallets claim @${esc(handle)}</h1>
      <p class="lede">Only the real account can post its own proof. Open each proof post and check it names the same wallet.</p>
      <div class="rows">${claims.map(({ a, c }) => `<div class="row"><a class="mono" href="#maker-${a}">${a}</a><span>claimed ${when(c.at)}</span><a href="${esc(c.proof)}" target="_blank" rel="noopener">Proof post</a></div>`).join('')}</div></div>`;
  } catch (e) { if (tk === seq) app().innerHTML = problem(e); }
}

async function makerPage(addr, viaHandle) {
  const tk = viaHandle ? seq : ++seq;
  app().innerHTML = loading('this maker');
  try {
    const [bonds, rec, claim] = await Promise.all([loadBonds(), record(addr), claimOf(addr)]);
    if (tk !== seq) return;
    const mine = bonds.filter((b) => b.maker.toLowerCase() === addr.toLowerCase()).reverse();
    const isMe = S.account && S.account.toLowerCase() === addr.toLowerCase();
    const reg = registry();
    app().innerHTML = `
    <section class="maker">
      <div class="maker-id">
        <span class="label">${claim ? 'X handle, claimed by this wallet' : 'Wallet'}</span>
        <h1 class="page-title${claim ? '' : ' title-addr'}">${claim ? `@${esc(claim.handle)}` : short(addr)}</h1>
        <p class="mono addr"><a href="${ADDR(addr)}" target="_blank" rel="noopener">${addr}</a></p>
        ${claim ? `<p class="hint">Claimed ${when(claim.at)}. <a href="${esc(claim.proof)}" target="_blank" rel="noopener">Open the proof post</a> and check it names this wallet.</p>` : '<p class="hint">No X handle claimed.</p>'}
      </div>
      <dl class="tally small">
        <div><dt class="label">Kept</dt><dd>${rec.kept}</dd></div>
        <div><dt class="label">Broken</dt><dd>${rec.broken}</dd></div>
        <div><dt class="label">OKB kept</dt><dd>${num(formatEther(rec.keptValue), 4)}</dd></div>
        <div><dt class="label">OKB slashed</dt><dd>${num(formatEther(rec.brokenValue), 4)}</dd></div>
      </dl>
    </section>
    ${isMe && reg ? claimPanel(claim) : ''}
    <section class="sec">
      <div class="sec-head"><h2>Bonds by this maker</h2><p>${mine.length ? `${mine.length} in total, newest first.` : ''}</p></div>
      <div class="wall">${mine.length ? mine.map(card).join('') : `<div class="soon"><p>No bonds yet.</p></div>`}${isMe ? ghost : ''}</div>
    </section>`;
    draw();
    if (isMe && reg) wireClaim();
  } catch (e) { if (tk === seq) app().innerHTML = problem(e); }
}

function claimPanel(claim) {
  const text = `I'm putting my wallet on the record with Word Bonds. Every promise I bond is public, kept or broken.\n\nWallet: ${S.account}`;
  return `<section class="claim">
    <div><span class="label">${claim ? 'Change your X handle' : 'Put your name on your record'}</span>
    <h2>Link your X handle</h2>
    <p class="hint">People search by handle. Two steps: post one line from your X account, then save the link here.</p></div>
    <ol class="claim-steps">
      <li><b>Post the proof</b><a class="btn line" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(text)}">Open X with the post written</a><span class="hint">The post names this wallet, so anyone can check the handle is yours.</span></li>
      <li><b>Paste the post’s link</b>
        <form id="c-form" class="q"><input id="c-url" placeholder="https://x.com/yourname/status/…" autocomplete="off" spellcheck="false" aria-label="Link to your proof post"><button class="btn" type="submit">Save handle</button></form>
        <span class="hint" id="c-note">The handle is read from the link.</span></li>
    </ol>
  </section>`;
}

function wireClaim() {
  const parse = () => {
    const m = $('c-url').value.trim().match(/^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})/);
    return m ? { handle: m[1], proof: `https://x.com/${m[1]}/status/${m[2]}` } : null;
  };
  $('c-url').oninput = () => { const p = parse(); $('c-note').innerHTML = p ? `Saves <b>@${esc(p.handle)}</b> for this wallet.` : 'The handle is read from the link.'; };
  $('c-form').onsubmit = async (e) => {
    e.preventDefault();
    const p = parse();
    if (!p) { $('c-note').innerHTML = `<span class="bad">${esc(WHY.BadProof)}</span>`; return; }
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      await send({ address: registry(), abi: REG.abi, functionName: 'claim', args: [p.handle, p.proof] }, 'Handle');
      S.claims.clear(); await loadBonds(true); makerPage(S.account);
    } catch (err) { fail(err); if (btn) btn.disabled = false; }
  };
}

// ------------------------------------------------------------------ setup

function setupPage() {
  ++seq;
  const reg = registry();
  app().innerHTML = `<div class="lookup"><h1 class="page-title">Setup</h1>
    <p class="lede">One-time step for the Word Bonds team: put the handle registry on X Layer.</p>
    ${reg ? `<p>Registry is live at <a class="mono" href="${ADDR(reg)}" target="_blank" rel="noopener">${reg}</a>.</p>` : ''}
    <p><button class="btn" id="s-deploy">${reg ? 'Deploy a new registry' : 'Deploy the handle registry'}</button></p>
    <p class="hint" id="s-note">Costs gas only, a few cents.</p></div>`;
  $('s-deploy').onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await needWallet();
      toast('Registry: confirm in your wallet.');
      const hash = await S.wc.deployContract({ abi: REG.abi, bytecode: REG.bytecode });
      toast('Registry: waiting for X Layer…', hash);
      const r = await rpc.waitForTransactionReceipt({ hash, timeout: 180000 });
      if (r.status !== 'success' || !r.contractAddress) throw new Error('Deployment failed on-chain.');
      try { localStorage.setItem('wb-registry', r.contractAddress); } catch {}
      S.claims.clear(); S.bonds = null;
      toast('Registry is live.', hash, 'ok');
      $('s-note').innerHTML = `Registry live at <b class="mono">${r.contractAddress}</b>. Send this address to Claude. Transaction <a href="${TX(hash)}" target="_blank" rel="noopener">${shortTx(hash)}</a>.`;
    } catch (e) { fail(e); ev.currentTarget.disabled = false; }
  };
}

// ------------------------------------------------------------------ router

function route() {
  const h = location.hash.slice(1) || 'home';
  let m;
  const section = h === 'make' ? 'make' : (h === 'maker' || h.startsWith('at-') || (h.startsWith('maker-') && !(S.account && h === `maker-${S.account}`))) ? 'maker' : h.startsWith('maker-') ? 'mine' : 'home';
  document.querySelectorAll('.nav a[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  if (!['how'].includes(h)) scrollTo(0, 0);
  if ((m = h.match(/^bond-(\d+)$/))) return bondPage(Number(m[1]));
  if (h === 'make') return makePage();
  if (h === 'maker') return searchPage();
  if ((m = h.match(/^maker-(0x[0-9a-fA-F]{40})$/))) return makerPage(getAddress(m[1]));
  if ((m = h.match(/^at-([A-Za-z0-9_]{1,15})$/))) return handlePage(m[1]);
  if (h === 'setup') return setupPage();
  return home();
}

window.addEventListener('DOMContentLoaded', () => {
  walletUI();
  const reg = registry();
  $('f-contract').innerHTML = `Contract <a class="mono" href="${ADDR(WB)}" target="_blank" rel="noopener">${short(WB)}</a>${reg ? ` · Handles <a class="mono" href="${ADDR(reg)}" target="_blank" rel="noopener">${short(reg)}</a>` : ''}`;
  route();
  addEventListener('hashchange', route);
  addEventListener('resize', draw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
  setInterval(() => document.querySelectorAll('[data-deadline]').forEach((el) => (el.textContent = left(el.dataset.deadline))), 30000);
});
