// ============================================================
// GAUDICODE 競馬サイト オッズ取得スクリプト
// ------------------------------------------------------------
// netkeiba のオッズAPIから三連複・三連単のオッズを取得し、
// data/<date>.json の各レースに odds / oddsTan / oddsAt として
// マージする (競輪サイトと同じ保存形式。保存はプランの買い目分のみ)。
// 発走済み・結果確定済みのレースは通常モードでは上書きしない
// (発走時点で凍結し、確定オッズは fetch-results が結果の初回記録時に
// 上書きする)。
//
// 使い方:
//   node scripts/fetch-odds.mjs [YYYY-MM-DD] [--venue=05] [--all] [--final]
// 対象 (通常モード): 今日のファイルで、発走時刻が [現在-5分, 現在+150分]
//   の未発走・結果なしレース。
// --all: その日の未発走・結果なしレースを全て対象にする (朝の生成用)。
// --final: 結果確定済みレースを対象に、確定オッズで埋める/上書きする
//   (過去日のバックフィル用)。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKeibaOdds } from './odds-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 800;
const TIMEOUT_MS = 20000;
const CONCURRENCY = 2;
const BASE = 'https://race.netkeiba.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.httpStatus = res.status;
        throw err;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (e.httpStatus && e.httpStatus < 500) break;
      if (attempt === 0) await sleep(1500);
    }
  }
  throw lastErr;
}

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const now = jstNow();
  const dateStr = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || now.date;
  const venueFilter = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const all = args.includes('--all');
  const finalMode = args.includes('--final');
  const dataPath = path.join(ROOT, 'data', `${dateStr}.json`);
  if (!fs.existsSync(dataPath)) throw new Error(`data/${dateStr}.json がありません。先に出走表を取得してください。`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const tasks = [];
  let skipped = 0;
  for (const v of data.venues) {
    if (venueFilter && v.id !== venueFilter.padStart(2, '0')) continue;
    for (const r of v.races) {
      if (!r.raceId || !r.prediction) { skipped++; continue; }
      if (finalMode) {
        if (!r.result) { skipped++; continue; }
      } else {
        if (r.result) { skipped++; continue; }
        if (!all) {
          if (dateStr !== now.date || !r.startTime) { skipped++; continue; }
          const st = toMin(r.startTime);
          if (st < now.minutes - 5 || st > now.minutes + 150) { skipped++; continue; }
        }
      }
      tasks.push({ v, r });
    }
  }

  let updated = 0, empty = 0, failed = 0;
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const { v, r } = tasks[idx++];
      try {
        const { odds, oddsTan } = await fetchKeibaOdds(fetchText, BASE, r);
        if (Object.keys(odds).length > 0 || Object.keys(oddsTan).length > 0) {
          r.odds = odds;
          r.oddsTan = oddsTan;
          r.oddsAt = new Date().toISOString();
          updated++;
        } else { empty++; }
      } catch (e) {
        failed++;
        console.log(`[odds] ${v.name} ${r.no}R 取得失敗: ${e.message || e}`);
      }
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));

  if (updated > 0) {
    data.oddsUpdatedAt = new Date().toISOString();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  }
  console.log(`[done] オッズを記録: ${updated}レース / データなし: ${empty} / 失敗: ${failed} / 対象外: ${skipped}`);
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
