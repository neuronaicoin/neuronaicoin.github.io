// NEURON Data Engine — runs on GitHub Actions every hour.
// Fetches Robinhood Chain pools, scores them with the NEURON formula,
// writes api/scores.json (latest) and api/history.json (rolling ~7 days).
// No secrets, no keys — public data in, public data out.

const fs = require('fs');
const path = require('path');

const API = 'https://api.geckoterminal.com/api/v2';
const NET = 'robinhood';
const OUT_DIR = path.join(process.cwd(), 'api');
const HISTORY_CAP = 180; // ~7.5 days of hourly snapshots

// ── same scoring formula as the site tools (kept in sync manually)
function scorePool(a){
  let s = 50; const flags = [];
  const liq  = parseFloat(a.reserve_in_usd) || 0;
  const vol24= parseFloat(a.volume_usd?.h24) || 0;
  const vol6 = parseFloat(a.volume_usd?.h6) || 0;
  const mcap = parseFloat(a.market_cap_usd || a.fdv_usd) || 0;
  const ch24 = parseFloat(a.price_change_percentage?.h24);
  const buys = a.transactions?.h24?.buys || 0;
  const sells= a.transactions?.h24?.sells || 0;
  const tot = buys + sells; const bp = tot > 0 ? buys / tot : 0.5;
  const ageH = a.pool_created_at ? (Date.now() - new Date(a.pool_created_at).getTime()) / 3.6e6 : 999;

  if (liq >= 250000){ s += 15; flags.push('LIQ OK'); }
  else if (liq >= 50000){ s -= 5; flags.push('LOW LIQ'); }
  else { s -= 25; flags.push('MICRO LIQ'); }

  if (tot > 0){
    if (bp >= 0.58){ s += 12; flags.push('BUY>SELL'); }
    else if (bp <= 0.42){ s -= 12; flags.push('SELL>BUY'); }
  }
  if (ageH < 24){ s -= 8; flags.push('FRESH'); }
  if (mcap > 0 && vol24 > mcap){ s -= 5; flags.push('HOT VOL'); }
  if (!isNaN(ch24) && ch24 < -40){ s -= 15; flags.push('DUMP RISK'); }
  if (!isNaN(ch24) && ch24 > 10 && ch24 < 200 && liq >= 50000){ s += 8; }

  let trend = 'flat';
  if (vol24 > 1000 && vol6 > 0){
    const pace = vol6 * 4 / vol24;
    if (pace >= 1.25) trend = 'up'; else if (pace <= 0.7) trend = 'down';
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(s))),
    flags, trend,
    liq: Math.round(liq), vol: Math.round(vol24),
    mcap: Math.round(mcap),
    ch24: isNaN(ch24) ? null : Math.round(ch24 * 10) / 10,
    buys, sells
  };
}

async function getJson(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

function mapPools(j){
  const inc = {};
  (j.included || []).forEach(x => { inc[x.id] = x.attributes; });
  return (j.data || []).map(p => {
    const a = p.attributes;
    const bid = p.relationships?.base_token?.data?.id;
    const sym = (bid && inc[bid]?.symbol) || (a.name || '?').split('/')[0].trim();
    const tokenAddr = bid ? bid.split('_').slice(1).join('_') : '';
    return { sym, tokenAddr, poolAddr: a.address || '', ...scorePool(a) };
  }).filter(p => p.sym && p.sym !== '?');
}

async function main(){
  // top volume + trending → merge, dedup by symbol (keep first = higher volume)
  const [volJ, trJ] = await Promise.all([
    getJson(API + '/networks/' + NET + '/pools?include=base_token&sort=h24_volume_usd_desc&page=1'),
    getJson(API + '/networks/' + NET + '/trending_pools?include=base_token&duration=24h').catch(() => ({ data: [] }))
  ]);
  const merged = [...mapPools(volJ), ...mapPools(trJ)];
  const seen = {}; const pools = [];
  merged.forEach(p => { const k = p.sym.toUpperCase(); if (!seen[k]){ seen[k] = 1; pools.push(p); } });
  if (!pools.length) throw new Error('No pools returned — aborting to protect existing data.');

  const now = new Date().toISOString();
  const avg = Math.round(pools.reduce((s, p) => s + p.score, 0) / pools.length);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // latest scores
  const scores = {
    project: 'NEURON AI', chain: NET, generated_at: now,
    pool_count: pools.length, avg_score: avg,
    docs: 'https://neuronaicoin.com',
    disclaimer: 'Activity-health scores, not price predictions. Not financial advice. DYOR.',
    pools
  };
  fs.writeFileSync(path.join(OUT_DIR, 'scores.json'), JSON.stringify(scores, null, 1));

  // rolling history (compact per snapshot)
  const histFile = path.join(OUT_DIR, 'history.json');
  let hist = { project: 'NEURON AI', chain: NET, note: 'hourly snapshots, compact keys: s=symbol sc=score l=liq v=vol24 c=ch24', snapshots: [] };
  try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch (e) { /* first run */ }
  if (!Array.isArray(hist.snapshots)) hist.snapshots = [];
  hist.snapshots.push({
    t: now, avg,
    pools: pools.map(p => ({ s: p.sym, sc: p.score, l: p.liq, v: p.vol, c: p.ch24 }))
  });
  if (hist.snapshots.length > HISTORY_CAP) hist.snapshots = hist.snapshots.slice(-HISTORY_CAP);
  fs.writeFileSync(histFile, JSON.stringify(hist));

  console.log('OK — ' + pools.length + ' pools scored, avg ' + avg + ', snapshots: ' + hist.snapshots.length);
}

main().catch(e => { console.error('ENGINE FAILED:', e.message); process.exit(1); });
