// ============================================================
// 競馬 (JRA) 出走表 自動取得 + GAUDICODE競馬AI予想 生成スクリプト
// ------------------------------------------------------------
// 使い方:
//   node scripts/fetch-and-build.mjs [YYYY-MM-DD] [--venue=05]
//   例) node scripts/fetch-and-build.mjs 2026-11-14
//       node scripts/fetch-and-build.mjs 2026-11-08 --venue=03  (福島だけ試す)
//
// 処理の流れ:
//   1. netkeiba のレース一覧 (race_list_sub) から当日の開催場と
//      全レース (race_id・レース名・発走時刻・コース) を集める
//   2. 各レースの出馬表 (race/shutuba.html) から出走馬を抽出する
//   3. 過去成績付き出馬表 (race/shutuba_past.html) から各馬の近5走を抽出する
//   4. スコア方式の予想エンジンで 印・本命・穴・買い目プランを生成
//   5. サイト用データ data/YYYY-MM-DD.json を書き出す
//
// 注意:
//   - 開催が無い日はデータを作らず正常終了する (JRAは土日中心)。
//   - ページ形式が変わると抽出が失敗します。失敗したレースは
//     status:"error" として記録され、他は続行します。
//   - 取得間隔を空け、短時間に大量アクセスしないでください。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { validateDay } from './validate-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 600;
const BASE = 'https://race.netkeiba.com';

// JRA 競馬場コード (race_id 内の2桁) -> 日本語名
const JYO_NAMES = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
};

function jstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}
const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// ------------------------------------------------------------
// レース一覧 (race_list_sub) -> 開催場とレースの索引
// ------------------------------------------------------------
function parseRaceList(html) {
  const doc = new JSDOM(html).window.document;
  const venues = [];
  for (const dl of doc.querySelectorAll('.RaceList_DataList')) {
    const titleEl = dl.querySelector('.RaceList_DataTitle');
    const titleText = txt(titleEl); // 例: "5回 東京 2日目"
    const tm = titleText.match(/(\d+)回\s*(\S+?)\s*(\d+)日目/);
    if (!tm) continue;
    const name = tm[2];
    // kaisai_id=YYYY(開催場2桁)(回2桁)(日目2桁) から開催場コードを取る
    let jyo = null;
    const link = dl.querySelector('a[href*="kaisai_id="]');
    if (link) {
      const km = (link.getAttribute('href') || '').match(/kaisai_id=\d{4}(\d{2})\d{4}/);
      if (km) jyo = km[1];
    }
    if (!jyo) { // コード表から逆引き (保険)
      jyo = Object.keys(JYO_NAMES).find((k) => JYO_NAMES[k] === name) || null;
    }
    if (!jyo) continue;
    const desc = txt(dl.querySelector('.RaceList_DataDesc'));
    const races = [];
    for (const item of dl.querySelectorAll('.RaceList_DataItem')) {
      const a = item.querySelector('a[href*="race_id="]');
      if (!a) continue;
      const rm = (a.getAttribute('href') || '').match(/race_id=(\d{12})/);
      if (!rm) continue;
      const noM = txt(item.querySelector('.Race_Num')).match(/(\d+)R/);
      const course = txt(item.querySelector('.RaceList_ItemLong'));
      const timeM = txt(item.querySelector('.RaceList_Itemtime')).match(/(\d{1,2}:\d{2})/);
      const fieldM = txt(item.querySelector('.RaceList_Itemnumber')).match(/(\d+)頭/);
      races.push({
        raceId: rm[1],
        no: noM ? Number(noM[1]) : races.length + 1,
        name: txt(item.querySelector('.ItemTitle')),
        startTime: timeM ? timeM[1] : null,
        course,
        fieldDeclared: fieldM ? Number(fieldM[1]) : null,
      });
    }
    races.sort((a, b) => a.no - b.no);
    if (races.length) venues.push({ id: jyo, name, title: `${tm[1]}回 ${tm[3]}日目`, desc, races });
  }
  return venues;
}

// ------------------------------------------------------------
// 出馬表 (shutuba.html) -> 出走馬
// テーブル行のセルは class で識別する (Waku*=枠番, Umaban*=馬番,
// HorseInfo=馬名, Barei=性齢, 次のセル=斤量, Jockey=騎手,
// Trainer=厩舎, Weight=馬体重)。
// ------------------------------------------------------------
function parseEntries(doc) {
  const table = doc.querySelector('table.Shutuba_Table');
  if (!table) return [];
  const horses = [];
  for (const tr of table.querySelectorAll('tr')) {
    const umabanTd = [...tr.children].find((c) => /^Umaban/.test(c.className || ''));
    if (!umabanTd) continue;
    const rowText = txt(tr);
    if (/取消|除外/.test(rowText)) continue; // 出走取消・競走除外は出走馬に含めない
    const wakuTd = [...tr.children].find((c) => /^Waku/.test(c.className || ''));
    const bareiTd = tr.querySelector('td.Barei');
    const num = Number(txt(umabanTd));
    if (!(num >= 1 && num <= 18)) continue;
    const weightTd = bareiTd ? bareiTd.nextElementSibling : null;
    const bwM = txt(tr.querySelector('td.Weight')).match(/(\d+)\(([+-]?\d+)\)/);
    horses.push({
      num,
      waku: wakuTd ? Number(txt(wakuTd)) || null : null,
      name: txt(tr.querySelector('td.HorseInfo')),
      sexAge: txt(bareiTd),
      weight: weightTd ? Number(txt(weightTd)) || null : null,
      jockey: txt(tr.querySelector('td.Jockey')),
      trainer: txt(tr.querySelector('td.Trainer')),
      bodyWeight: bwM ? Number(bwM[1]) : null,
      bodyWeightDiff: bwM ? Number(bwM[2]) : null,
    });
  }
  return horses.sort((a, b) => a.num - b.num);
}

// ------------------------------------------------------------
// 過去成績 (shutuba_past.html) -> 馬番 -> 近5走
// 各 Past セルの構造 (実ページで確認):
//   .Data01: 日付+開催 と .Num (着順)
//   .Data02: レース名 + クラス (OP/L/G1/3勝 等)
//   .Data05: "芝1200 1:09.4 良" (馬場種別・距離・タイム・馬場状態)
//   .Data03: "16頭 9番 6人 横山和生 57.0" (頭数・馬番・人気・騎手・斤量)
//   .Data07: "ナムラクララ(1.0)" (1着馬名と着差=秒。1着時は2着馬名)
// 着順 (.Num) は結果ページと照合して正しいことを確認済み
// (2026-08-09 UHB賞 カンティーユ 14着)。
// ------------------------------------------------------------
function parsePastRun(cell) {
  const item = cell.querySelector('.Data_Item');
  if (!item) return null;
  const cellText = txt(cell);
  const d01 = item.querySelector('.Data01');
  const dateM = txt(d01).match(/(\d{4})\.(\d{2})\.(\d{2})/);
  const numEl = item.querySelector('.Data01 .Num, .Num');
  const pos = numEl ? Number(txt(numEl)) : NaN;
  const d02a = item.querySelector('.Data02 a');
  const d05 = txt(item.querySelector('.Data05'));
  const surfM = d05.match(/^([芝ダ障])\s*(\d+)/);
  const d03 = txt(item.querySelector('.Data03'));
  const fM = d03.match(/(\d+)頭\s*(\d+)番\s*(\d+)人/);
  const d07 = txt(item.querySelector('.Data07'));
  const marginM = d07.match(/\(([\d.]+)\)\s*$/);
  const valid = Number.isFinite(pos) && pos >= 1 && !!fM && !/中止|取消|除外/.test(cellText);
  return {
    date: dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : null,
    raceName: txt(d02a) || null,
    surface: surfM ? surfM[1] : null,
    distance: surfM ? Number(surfM[2]) : null,
    pos: valid ? pos : null,
    field: fM ? Number(fM[1]) : null,
    popularity: fM ? Number(fM[3]) : null,
    // 勝ち馬との着差 (秒)。自分が1着のときは 0 として扱う
    margin: valid && pos === 1 ? 0 : (marginM ? Number(marginM[1]) : null),
    valid,
  };
}

function parsePastForm(doc) {
  const table = doc.querySelector('table.Shutuba_Past5_Table');
  const map = new Map();
  if (!table) return map;
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [...tr.children];
    if (cells.length < 7) continue;
    const num = Number(txt(cells[1]));
    if (!(num >= 1 && num <= 18)) continue;
    const runs = [];
    for (const cell of cells.slice(6, 11)) {
      const run = parsePastRun(cell);
      if (run) runs.push(run);
    }
    map.set(num, runs);
  }
  return map;
}

// ============================================================
// 予想エンジン (スコア方式・決定的) v1
// ------------------------------------------------------------
// 各馬の近5走 (有効なもの) から算出する。
//   1走の評価 perf = (頭数 - 着順) / (頭数 - 1)   (1着=1.0, 最下位=0)
//     1着は 1.05 に引き上げ、2着 +0.04 / 3着 +0.02 の入着ボーナス。
//     敗れた場合は勝ち馬との着差1秒あたり -0.03 (最大 -0.12) し、
//     「大敗の3着」と「接戦の3着」を区別する。
//   formScore = perf の加重平均 (重み: 前走0.36, 2走前0.27, 3走前0.18,
//     4走前0.11, 5走前0.08。有効な走だけに正規化)
//   有効な過去走が無い馬 (デビュー等) は formScore = 0.40 (低めの仮置き)
//   馬場適性: 今日と同じ馬場種別 (芝/ダ) の走が2走以上あれば
//     (同馬場perf平均 - formScore) × 0.30 を加減
//   距離適性: 今日の距離±200m の走が2走以上あれば
//     (近距離perf平均 - formScore) × 0.20 を加減 (適性補正は合計±0.07まで)
//   斤量: 場平均との差 × -0.008 (上限±0.03)。斤量が軽い馬を僅かに優遇
//     (ハンデ戦では斤量は実力の裏返しでもあるため影響は小さく抑える)
//   枠順: 14頭以上のレースで 1-2枠 +0.012 / 7-8枠 -0.012 (僅かな補正)
// 騎手の勝率は出馬表から取得できないため v1 では使わない。
// 印はスコア順に ◎○▲△△△ (6頭まで)。
// 穴候補はスコア5〜9位の中から「近3走以内のベスト着順が最も良い馬」
// (同着順なら着差が小さい方、それも同じならスコア上位)。
// ============================================================
const RUN_W = [0.36, 0.27, 0.18, 0.11, 0.08];

function runPerf(run) {
  if (!run.valid || !run.field || run.field < 2) return null;
  let p = (run.field - run.pos) / (run.field - 1);
  if (run.pos === 1) p = 1.05;
  else {
    if (run.pos === 2) p += 0.04;
    else if (run.pos === 3) p += 0.02;
    if (run.margin != null) p -= Math.min(0.12, run.margin * 0.03);
  }
  return Math.max(0, Math.min(1.05, p));
}

function buildPrediction(horses, race) {
  if (!horses || horses.length < 5) return null;
  const surfM = (race.course || '').match(/^([芝ダ障])\s*(\d+)/);
  const todaySurface = surfM ? surfM[1] : null;
  const todayDist = surfM ? Number(surfM[2]) : null;
  const weights = horses.map((h) => h.weight).filter((w) => Number.isFinite(w));
  const meanWeight = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;

  for (const h of horses) {
    const runs = (h.pastRuns || []).filter((r) => r.valid);
    const perfs = runs.map(runPerf).filter((p) => p != null);
    let form;
    if (!perfs.length) form = 0.40;
    else {
      let sw = 0, sp = 0;
      perfs.forEach((p, i) => { const w = RUN_W[i] ?? 0.05; sw += w; sp += w * p; });
      form = sp / sw;
    }
    let apt = 0;
    const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
    const surfPerfs = runs.filter((r) => todaySurface && r.surface === todaySurface).map(runPerf).filter((p) => p != null);
    if (surfPerfs.length >= 2) apt += (avg(surfPerfs) - form) * 0.30;
    const distPerfs = runs.filter((r) => todayDist && r.distance && Math.abs(r.distance - todayDist) <= 200).map(runPerf).filter((p) => p != null);
    if (distPerfs.length >= 2) apt += (avg(distPerfs) - form) * 0.20;
    apt = Math.max(-0.07, Math.min(0.07, apt));
    let wAdj = 0;
    if (Number.isFinite(h.weight) && meanWeight) wAdj = Math.max(-0.03, Math.min(0.03, -(h.weight - meanWeight) * 0.008));
    let drawAdj = 0;
    if (horses.length >= 14 && h.waku) drawAdj = h.waku <= 2 ? 0.012 : h.waku >= 7 ? -0.012 : 0;
    h.score = Math.round((form + apt + wAdj + drawAdj) * 1000) / 1000;
    h._form = form;
  }

  const ranked = [...horses].sort((a, b) => b.score - a.score || a.num - b.num);
  const MARKS = ['◎', '○', '▲', '△', '△', '△'];
  horses.forEach((h) => { h.mark = ''; });
  ranked.forEach((h, i) => { if (i < MARKS.length) h.mark = MARKS[i]; });
  const [hon, tai, san, bestD] = ranked;

  // 穴候補: スコア5〜9位から、近3走以内のベスト走が最も良い馬
  const bestRecent = (h) => {
    const runs = (h.pastRuns || []).filter((r) => r.valid).slice(0, 3);
    if (!runs.length) return null;
    let best = null;
    for (const r of runs) {
      const key = { pos: r.pos, margin: r.margin == null ? 9 : r.margin, run: r, idx: runs.indexOf(r) };
      if (!best || key.pos < best.pos || (key.pos === best.pos && key.margin < best.margin)) best = key;
    }
    return best;
  };
  const anaPool = ranked.slice(4, 9);
  let ana = null, anaBest = null;
  for (const h of anaPool) {
    const b = bestRecent(h);
    if (!b) continue;
    if (!anaBest || b.pos < anaBest.pos || (b.pos === anaBest.pos && b.margin < anaBest.margin)) { ana = h; anaBest = b; }
  }
  if (!ana) { ana = anaPool[0] || ranked[ranked.length - 1]; anaBest = bestRecent(ana); }
  const whenLabel = ['前走', '2走前', '3走前'];
  let anaReason;
  if (anaBest) {
    const r = anaBest.run;
    anaReason = `${whenLabel[anaBest.idx] || '近走'}${r.pos}着（${r.field}頭）`
      + (r.pos > 1 && r.margin != null && r.margin <= 0.3 ? `・勝ち馬と${r.margin}秒差の接戦` : '')
      + `がありながらスコア${ranked.indexOf(ana) + 1}位の一発候補`;
  } else {
    anaReason = `スコア${ranked.indexOf(ana) + 1}位・近走実績が薄い分の一発候補`;
  }
  // 次点E: 中核 (本命・対抗・▲・D・穴) を除いた最高スコア
  const coreSet = new Set([hon.num, tai.num, san.num, bestD.num, ana.num]);
  const bestE = ranked.find((h) => !coreSet.has(h.num)) || null;

  // ---- 買い目プラン (競輪・競艇と同じ構成) ----
  const combo = (...ns) => {
    const u = [...new Set(ns.filter((n) => n != null))];
    return u.length === 3 ? u.sort((a, b) => a - b).join('-') : null;
  };
  const add = (list, c) => { if (c && !list.includes(c)) list.push(c); };
  // 三連複・鉄板: 全点に穴候補を含む4点
  const teppan = [];
  add(teppan, combo(ana.num, hon.num, tai.num));
  add(teppan, combo(ana.num, hon.num, san.num));
  add(teppan, combo(ana.num, hon.num, bestD.num));
  add(teppan, combo(ana.num, tai.num, san.num));
  // バランス = 鉄板 + スコア純正
  const purePuku = [];
  add(purePuku, combo(hon.num, tai.num, san.num));
  add(purePuku, combo(hon.num, tai.num, bestD.num));
  add(purePuku, combo(hon.num, san.num, bestD.num));
  const balance = [...teppan];
  for (const c of purePuku) add(balance, c);
  // 勝負 = バランス + 中核5頭ボックス (2026-11-15 変更: 6頭20点は多いため
  // 5頭10点に。108レース測定で 的中 32.4% / 回収 89.2%、回収は前後半とも安定)
  const core5 = [hon.num, tai.num, san.num, bestD.num, ana.num];
  const shoubu = [...balance];
  for (let i = 0; i < core5.length; i++)
    for (let j = i + 1; j < core5.length; j++)
      for (let k = j + 1; k < core5.length; k++)
        add(shoubu, combo(core5[i], core5[j], core5[k]));
  // 三連単
  const T = (...ns) => {
    const u = ns.filter((n) => n != null);
    return u.length === 3 && new Set(u).size === 3 ? u.join('→') : null;
  };
  const addT = (list, c) => { if (c && !list.includes(c)) list.push(c); };
  const tanTeppan = [];
  addT(tanTeppan, T(hon.num, tai.num, ana.num));
  addT(tanTeppan, T(hon.num, ana.num, tai.num));
  addT(tanTeppan, T(ana.num, hon.num, tai.num));
  addT(tanTeppan, T(tai.num, hon.num, ana.num));
  const pureTan = [];
  addT(pureTan, T(hon.num, tai.num, san.num));
  addT(pureTan, T(hon.num, san.num, tai.num));
  const tanBalance = [...tanTeppan];
  for (const c of pureTan) addT(tanBalance, c);
  addT(tanBalance, T(ana.num, tai.num, hon.num)); // 穴頭
  // 勝負 = バランス + 本命頭フォーメーション (競輪のA案と同構成)
  const tanShoubu = [...tanBalance];
  const fSeconds = [tai.num, san.num, ana.num];
  const fThirds = [hon.num, tai.num, san.num, ana.num, bestD.num];
  for (const b of fSeconds) for (const c of fThirds) addT(tanShoubu, T(hon.num, b, c));

  const honForm = (hon.pastRuns || []).filter((r) => r.valid).slice(0, 5).map((r) => r.pos).join('-');
  const comment = [
    `◎${hon.num}番 ${hon.name}（スコア${hon.score.toFixed(3)}）。近走は${honForm ? honForm + '着' : '実績なし'}で評価最上位。`,
    `対抗は○${tai.num}番 ${tai.name}、▲は${san.num}番 ${san.name}。`,
    `穴候補は${ana.num}番 ${ana.name}（${anaReason}）。`,
  ].join('\n');

  horses.forEach((h) => { delete h._form; });
  return {
    honmei: { num: hon.num, name: hon.name },
    sanrenpuku: purePuku,
    sanrentan: pureTan,
    plans: { teppan, balance, shoubu },
    plansTan: { teppan: tanTeppan, balance: tanBalance, shoubu: tanShoubu },
    ana: { num: ana.num, name: ana.name, reason: anaReason },
    comment,
  };
}

// ------------------------------------------------------------
// 1レース分の取得: 出馬表 + 過去成績 -> 予想生成
// ------------------------------------------------------------
async function buildRace(raceMeta) {
  const shutubaHtml = await fetchHtml(`${BASE}/race/shutuba.html?race_id=${raceMeta.raceId}&rf=race_list`);
  const sDoc = new JSDOM(shutubaHtml).window.document;
  const horses = parseEntries(sDoc);
  if (horses.length < 5) throw new Error(`出馬表を抽出できませんでした (${horses.length}頭)`);
  await sleep(DELAY_MS);
  const pastHtml = await fetchHtml(`${BASE}/race/shutuba_past.html?race_id=${raceMeta.raceId}&rf=race_list`);
  const pDoc = new JSDOM(pastHtml).window.document;
  const pastMap = parsePastForm(pDoc);
  for (const h of horses) h.pastRuns = pastMap.get(h.num) || [];
  const prediction = buildPrediction(horses, raceMeta);
  if (!prediction) throw new Error('予想を生成できませんでした');
  return {
    no: raceMeta.no,
    raceId: raceMeta.raceId,
    name: raceMeta.name,
    status: 'ready',
    startTime: raceMeta.startTime,
    course: raceMeta.course,
    horses,
    prediction,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dateStr = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstToday();
  const venueFilter = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const ymd = dateStr.replace(/-/g, '');

  const listHtml = await fetchHtml(`${BASE}/top/race_list_sub.html?kaisai_date=${ymd}`);
  let venues = parseRaceList(listHtml);
  if (venueFilter) venues = venues.filter((v) => v.id === venueFilter.padStart(2, '0'));
  if (!venues.length) {
    console.log(`[fetch] ${dateStr} は開催がありません (JRA非開催日)。データは作成しません。`);
    return;
  }
  console.log(`[fetch] ${dateStr} 対象: ${venues.map((v) => `${v.name}${v.races.length}R`).join(' / ')}`);

  const outVenues = [];
  for (const v of venues) {
    const races = [];
    for (const rm of v.races) {
      process.stdout.write(`[race] ${v.name} ${rm.no}R ... `);
      try {
        const race = await buildRace(rm);
        races.push(race);
        console.log(`OK (${race.horses.length}頭)`);
      } catch (e) {
        races.push({ no: rm.no, raceId: rm.raceId, name: rm.name, status: 'error', error: String(e.message || e) });
        console.log(`NG: ${e.message || e}`);
      }
      await sleep(DELAY_MS);
    }
    outVenues.push({ id: v.id, name: v.name, grade: '', title: v.title, category: null, desc: v.desc, races });
    await sleep(DELAY_MS);
  }

  const out = {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    source: 'netkeiba (JRA)',
    venues: outVenues,
  };
  // 自己監査: 品質チェック結果をデータに刻み、異常はログに残す (黙って公開しない)
  const q = validateDay(out);
  out.quality = { errors: q.errors, warnings: q.warnings.length, checkedAt: new Date().toISOString() };
  if (q.errors.length) {
    console.log(`[品質チェック] エラー ${q.errors.length} 件:`);
    for (const e of q.errors) console.log('  [エラー]', e);
  } else {
    console.log(`[品質チェック] OK (${q.races}レース / 警告 ${q.warnings.length} 件)`);
  }
  const outPath = path.join(ROOT, 'data', `${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  const ready = outVenues.reduce((n, v) => n + v.races.filter((r) => r.status === 'ready').length, 0);
  const total = outVenues.reduce((n, v) => n + v.races.length, 0);
  console.log(`[done] ${outPath}  成功 ${ready}/${total} レース`);
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
