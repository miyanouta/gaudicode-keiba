// ============================================================
// GAUDICODE 競馬サイト オッズ解析ライブラリ
// ------------------------------------------------------------
// netkeiba のオッズAPI (api_get_jra_odds.html) を使う。
//   type=7: 三連複 (キーはソート済み3頭の2桁連結 "070912")
//   type=8: 三連単 (キーは着順どおり3頭の2桁連結 "071209")
// 値は [オッズ文字列, 変動, 人気] の配列で、オッズはカンマ区切り。
// 全組み合わせは三連単で最大4896通りと多いため、保存はプランの
// 買い目分だけに絞る (表示に必要なのは買い目のオッズと区分平均)。
//
// APIの呼び出し方 (2026-11-22 実測で確定):
//   race_id と type だけの呼び出しでは、未発走レースに
//   {"status":"middle","data":"","reason":"result odds empty"} が返り、
//   発売中のオッズは取得できない (2026-11-21 はこのため popana が
//   live では一度も成功しなかった)。
//   オッズページの更新プラグイン (jquery.odds_update.js) と同じ
//   パラメータ群 (pid/input/output/action/sort/compress) を付けると、
//   発売中 (status:"middle") のオッズが data.odds に返る。
//   compress=0 で平文JSONが返る。compress=1 だと data は
//   zlib+base64圧縮のため本ライブラリでは使わない。
// ============================================================

// オッズAPIのURLを作る (上記の実測パラメータ群つき)。
export function oddsApiUrl(base, raceId, type) {
  const q = new URLSearchParams({
    pid: 'api_get_jra_odds', input: 'UTF-8', output: 'json',
    race_id: String(raceId), type: String(type),
    action: 'init', sort: 'odds', compress: '0',
  });
  return `${base}/api/api_get_jra_odds.html?${q.toString()}`;
}

// APIレスポンス本文をパースする。JSONP形式 (output=jsonp) にも対応。
// 返値 { json, status, reason }。data が空文字の場合は status/reason
// (例: middle / "result odds empty") が理由として残る。
export function parseOddsResponse(txt) {
  let s = String(txt || '').trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  const json = JSON.parse(s);
  const status = json && json.status ? String(json.status) : 'unknown';
  const reason = json && json.reason ? String(json.reason) : '';
  return { json, status, reason };
}

// レースの予想から、オッズが必要な買い目集合を作る
export function planCombos(race) {
  const fuku = new Set();
  const tan = new Set();
  const p = race && race.prediction;
  if (!p) return { fuku, tan };
  const normF = (c) => String(c).split('-').map(Number).sort((a, b) => a - b).join('-');
  const normT = (c) => String(c).replace(/→/g, '-').split('-').map(Number).join('-');
  for (const k of ['teppan', 'balance', 'shoubu']) {
    for (const c of (p.plans && p.plans[k]) || []) fuku.add(normF(c));
    for (const c of (p.plansTan && p.plansTan[k]) || []) tan.add(normT(c));
  }
  for (const c of p.sanrenpuku || []) fuku.add(normF(c));
  for (const c of p.sanrentan || []) tan.add(normT(c));
  return { fuku, tan };
}

// APIレスポンスから wanted の買い目だけを { "7-9-12": 25.3 } で取り出す
export function extractOdds(apiJson, type, wanted) {
  const out = {};
  const map = apiJson && apiJson.data && apiJson.data.odds && apiJson.data.odds[String(type)];
  if (!map) return out;
  for (const [key, val] of Object.entries(map)) {
    if (!/^\d{6}$/.test(key) || !Array.isArray(val)) continue;
    const combo = [key.slice(0, 2), key.slice(2, 4), key.slice(4, 6)].map((s) => parseInt(s, 10)).join('-');
    if (!wanted.has(combo)) continue;
    const v = parseFloat(String(val[0]).replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) out[combo] = v;
  }
  return out;
}

// 1レース分のオッズ (三連複+三連単、プランの買い目分) を取得する。
// fetchText は呼び出し側の取得関数 (UA付きで本文テキストを返す)。
// 返値に API の status/reason を含める (空応答の理由をログに残すため)。
export async function fetchKeibaOdds(fetchText, base, race) {
  const { fuku, tan } = planCombos(race);
  const [fTxt, tTxt] = await Promise.all([
    fetchText(oddsApiUrl(base, race.raceId, 7)),
    fetchText(oddsApiUrl(base, race.raceId, 8)),
  ]);
  const f = parseOddsResponse(fTxt);
  const t = parseOddsResponse(tTxt);
  return {
    odds: extractOdds(f.json, 7, fuku),
    oddsTan: extractOdds(t.json, 8, tan),
    status: f.status,
    reason: f.reason || t.reason,
  };
}

// ============================================================
// 人気ベース再構成 (2026-11-15 採用: 108レース測定で現行エンジン比
// 三連複・勝負 的中 21.3%→44.4% / 回収 46.7%→76.3%、点数同じ。
// 測定は確定人気ベースのため本番値はやや下がる見込み)
// 方式: 印と買い目は人気順を基本に組み直し、穴候補だけは
// 人気5〜9位の中からエンジンスコア最上位の馬を選ぶ。
// 発走前のみ適用し、発走後は凍結する (呼び出し側で制御)。
// ============================================================

// 単勝オッズ (type=1) から人気順マップ {馬番: 人気} を作る。
// 人気フィールドが無い馬は単勝オッズ順で補完する。
// カバー率が低ければ pop=null (再構成しない)。
// 返値は { pop, status, reason }。pop が null のとき reason に
// 空応答の理由が入る (無言失敗にしないため)。
export async function fetchPopularity(fetchText, base, race) {
  const txt = await fetchText(oddsApiUrl(base, race.raceId, 1));
  const { json: j, status, reason } = parseOddsResponse(txt);
  const map = j && j.data && j.data.odds && j.data.odds['1'];
  if (!map) return { pop: null, status, reason: reason || 'odds empty (dataなし)' };
  const entries = Object.entries(map).map(([k, val]) => ({
    num: parseInt(k, 10),
    odds: parseFloat(String(val[0]).replace(/,/g, '')),
    pop: parseInt(val[2], 10) || null,
  })).filter((e) => Number.isFinite(e.num) && Number.isFinite(e.odds) && e.odds > 0);
  if (!entries.length) return { pop: null, status, reason: reason || 'odds empty (有効な単勝オッズなし)' };
  entries.sort((a, b) => (a.odds - b.odds) || (a.num - b.num));
  const pop = {};
  entries.forEach((e, i) => { pop[e.num] = e.pop && e.pop > 0 ? e.pop : i + 1; });
  const field = (race.horses || []).length;
  if (field && Object.keys(pop).length < field * 0.8) {
    return { pop: null, status, reason: `coverage low (${Object.keys(pop).length}/${field}頭)` };
  }
  return { pop, status, reason };
}

// 人気順ランキング + 穴エンジンで予想を組み直す。
// fetch-and-build.mjs の buildPrediction のプラン部と同一構成。
export function rebuildWithPopularity(race, pop) {
  const horses = race.horses || [];
  if (horses.length < 5 || !race.prediction) return false;
  const scoreRanked = [...horses].sort((a, b) => b.score - a.score || a.num - b.num);
  const scoreRank = new Map(scoreRanked.map((h, i) => [h.num, i + 1]));
  const ranked = [...horses].sort((a, b) =>
    ((pop[a.num] ?? 99) - (pop[b.num] ?? 99)) || (b.score - a.score) || (a.num - b.num));
  const [hon, tai, san, bestD] = ranked;
  // 穴: 人気5〜9位 (ランキング5〜9番目) の中でエンジンスコア最上位
  const anaPool = ranked.slice(4, 9);
  const ana = [...anaPool].sort((a, b) => (b.score - a.score) || (a.num - b.num))[0]
    || ranked[ranked.length - 1];
  const coreSet = new Set([hon.num, tai.num, san.num, bestD.num, ana.num]);
  const bestE = ranked.find((h) => !coreSet.has(h.num)) || null;

  const combo = (...ns) => { const u = [...new Set(ns.filter((n) => n != null))]; return u.length === 3 ? u.sort((a, b) => a - b).join('-') : null; };
  const add = (list, c) => { if (c && !list.includes(c)) list.push(c); };
  const teppan = [];
  add(teppan, combo(ana.num, hon.num, tai.num)); add(teppan, combo(ana.num, hon.num, san.num));
  add(teppan, combo(ana.num, hon.num, bestD.num)); add(teppan, combo(ana.num, tai.num, san.num));
  const purePuku = [];
  add(purePuku, combo(hon.num, tai.num, san.num)); add(purePuku, combo(hon.num, tai.num, bestD.num)); add(purePuku, combo(hon.num, san.num, bestD.num));
  const balance = [...teppan]; for (const c of purePuku) add(balance, c);
  const core5 = [hon.num, tai.num, san.num, bestD.num, ana.num];
  const shoubu = [...balance];
  for (let i = 0; i < core5.length; i++) for (let j = i + 1; j < core5.length; j++) for (let k = j + 1; k < core5.length; k++) add(shoubu, combo(core5[i], core5[j], core5[k]));
  const T = (...ns) => { const u = ns.filter((n) => n != null); return u.length === 3 && new Set(u).size === 3 ? u.join('→') : null; };
  const addT = (list, c) => { if (c && !list.includes(c)) list.push(c); };
  const tanTeppan = [];
  addT(tanTeppan, T(hon.num, tai.num, ana.num)); addT(tanTeppan, T(hon.num, ana.num, tai.num));
  addT(tanTeppan, T(ana.num, hon.num, tai.num)); addT(tanTeppan, T(tai.num, hon.num, ana.num));
  const pureTan = []; addT(pureTan, T(hon.num, tai.num, san.num)); addT(pureTan, T(hon.num, san.num, tai.num));
  const tanBalance = [...tanTeppan]; for (const c of pureTan) addT(tanBalance, c);
  addT(tanBalance, T(ana.num, tai.num, hon.num));
  const tanShoubu = [...tanBalance];
  const fSeconds = [tai.num, san.num, ana.num];
  const fThirds = [hon.num, tai.num, san.num, ana.num, bestD.num];
  for (const b of fSeconds) for (const c of fThirds) addT(tanShoubu, T(hon.num, b, c));

  const MARKS = ['◎', '○', '▲', '△', '△', '△'];
  horses.forEach((h) => { h.mark = ''; });
  ranked.forEach((h, i) => { if (i < MARKS.length) h.mark = MARKS[i]; });

  const anaReason = `人気${pop[ana.num] ?? '-'}位ながらエンジンスコア${scoreRank.get(ana.num)}位の一発候補`;
  race.prediction = {
    honmei: { num: hon.num, name: hon.name },
    sanrenpuku: purePuku,
    sanrentan: pureTan,
    plans: { teppan, balance, shoubu },
    plansTan: { teppan: tanTeppan, balance: tanBalance, shoubu: tanShoubu },
    ana: { num: ana.num, name: ana.name, reason: anaReason },
    comment: [
      `【人気ベース再構成】◎${hon.num}番 ${hon.name}（1番人気）。`,
      `対抗は○${tai.num}番 ${tai.name}、▲は${san.num}番 ${san.name}。`,
      `穴候補は${ana.num}番 ${ana.name}（${anaReason}）。`,
    ].join('\n'),
    basis: 'popana',
    popAt: new Date().toISOString(),
  };
  return true;
}
