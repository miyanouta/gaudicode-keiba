// ============================================================
// GAUDICODE 競馬サイト 結果取得スクリプト
// ------------------------------------------------------------
// 指定日のレース結果 (着順・三連複/三連単の払戻) を netkeiba の
// 結果ページから取得し、data/<date>.json の各レースに result として
// マージする。あわせて予想プラン (鉄板/バランス/勝負) の的中判定も
// 記録する。まだ結果が出ていないレースは result を付けずに残す。
//
// 使い方:
//   node scripts/fetch-results.mjs [YYYY-MM-DD] [--venue=05]
// 前提: その日の data/<date>.json が存在すること (先に出走表を取得)。
//
// 結果ページの構造 (2026-11-08 福島11Rで確認):
//   着順テーブル (table.ResultRefund): 着順/枠/馬番/馬名...
//   払戻テーブル (Payout_Detail_Table) の tr.Fuku3 = 3連複、
//   tr.Tan3 = 3連単 (表記は「3連複」「3連単」)。同着時は複数行に
//   なることがあるが v1 では先頭の組み合わせを採用する。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { fetchKeibaOdds } from './odds-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 600;
const BASE = 'https://race.netkeiba.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function jstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function parseResult(html) {
  const doc = new JSDOM(html).window.document;
  // 着順: ResultRefund テーブルの先頭3着
  let top3 = null;
  const rt = doc.querySelector('table.ResultRefund');
  if (rt) {
    const placed = [];
    for (const tr of rt.querySelectorAll('tr')) {
      const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
      const rank = Number(cells[0]);
      const num = Number(cells[2]);
      if (rank >= 1 && rank <= 3 && num >= 1 && num <= 18) placed.push({ rank, num });
    }
    if (placed.length >= 3) top3 = placed.sort((a, b) => a.rank - b.rank).slice(0, 3).map((p) => p.num);
  }
  if (!top3) return null;
  // 払戻: tr.Fuku3 (3連複) / tr.Tan3 (3連単)
  const payoutOf = (tr) => {
    if (!tr) return null;
    const nums = [...tr.querySelectorAll('td.Result li span')].map((s) => Number(s.textContent.trim())).filter((n) => n >= 1 && n <= 18);
    const payM = (tr.querySelector('td.Payout')?.textContent || '').match(/([\d,]+)円/);
    if (nums.length !== 3) return null;
    return { combo: nums.join('-'), payout: payM ? Number(payM[1].replace(/,/g, '')) : null };
  };
  const fuku = payoutOf(doc.querySelector('tr.Fuku3'));
  const tan = payoutOf(doc.querySelector('tr.Tan3'));
  const sanrenpuku = fuku ? { combo: fuku.combo.split('-').map(Number).sort((a, b) => a - b).join('-'), payout: fuku.payout } : null;
  const sanrentan = tan ? { combo: tan.combo, payout: tan.payout } : null;
  return { top3, sanrenpuku, sanrentan };
}

const norm = (s) => s.split('-').map(Number).sort((a, b) => a - b).join('-');

function evaluate(race, result) {
  const hits = {};
  const p = race.prediction;
  if (p?.plans && result.sanrenpuku) {
    const key = norm(result.sanrenpuku.combo);
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plans[tier])) hits[tier] = p.plans[tier].map(norm).includes(key);
    }
  }
  if (p?.plansTan && result.sanrentan) {
    const ordered = result.sanrentan.combo.replace(/-/g, '→');
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plansTan[tier])) hits['tan' + tier[0].toUpperCase() + tier.slice(1)] = p.plansTan[tier].includes(ordered);
    }
    hits.sanrentan = hits.tanTeppan;
  }
  return hits;
}

async function main() {
  const args = process.argv.slice(2);
  const dateStr = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstToday();
  const venueFilter = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const dataPath = path.join(ROOT, 'data', `${dateStr}.json`);
  if (!fs.existsSync(dataPath)) throw new Error(`data/${dateStr}.json がありません。先に出走表を取得してください。`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  let updated = 0, pending = 0, failed = 0;
  for (const v of data.venues) {
    if (venueFilter && v.id !== venueFilter.padStart(2, '0')) continue;
    for (const r of v.races) {
      if (r.status !== 'ready' || !r.raceId) { pending++; continue; }
      try {
        const html = await fetchHtml(`${BASE}/race/result.html?race_id=${r.raceId}&rf=race_list`);
        const result = parseResult(html);
        if (!result) { pending++; }
        else {
          const needOdds = !r.result || !r.odds;
          r.result = { ...result, hits: evaluate(r, result) };
          updated++;
          // 結果の初回記録時 (またはオッズ未保存時) に確定オッズで埋める
          // (競輪と同じ方式)。失敗しても結果の記録は妨げない。
          if (needOdds) {
            try {
              const { odds, oddsTan } = await fetchKeibaOdds(fetchHtml, BASE, r);
              if (Object.keys(odds).length > 0 || Object.keys(oddsTan).length > 0) {
                r.odds = odds;
                r.oddsTan = oddsTan;
                r.oddsAt = new Date().toISOString();
              }
            } catch (e) {
              console.log(`[results] ${v.name} ${r.no}R 確定オッズ取得失敗: ${e.message || e}`);
            }
          }
        }
      } catch (e) {
        failed++;
        console.log(`[results] ${v.name} ${r.no}R 取得失敗: ${e.message || e}`);
      }
      await sleep(DELAY_MS);
    }
  }
  data.resultsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[done] 結果を記録: ${updated}レース / 未確定: ${pending} / 失敗: ${failed}`);
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
