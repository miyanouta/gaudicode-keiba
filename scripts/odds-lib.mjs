// ============================================================
// GAUDICODE 競馬サイト オッズ解析ライブラリ
// ------------------------------------------------------------
// netkeiba のオッズAPI (api_get_jra_odds.html) を使う。
//   type=7: 三連複 (キーはソート済み3頭の2桁連結 "070912")
//   type=8: 三連単 (キーは着順どおり3頭の2桁連結 "071209")
// 値は [オッズ文字列, 変動, 人気] の配列で、オッズはカンマ区切り。
// 全組み合わせは三連単で最大4896通りと多いため、保存はプランの
// 買い目分だけに絞る (表示に必要なのは買い目のオッズと区分平均)。
// ============================================================

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
export async function fetchKeibaOdds(fetchText, base, race) {
  const { fuku, tan } = planCombos(race);
  const [fTxt, tTxt] = await Promise.all([
    fetchText(`${base}/api/api_get_jra_odds.html?race_id=${race.raceId}&type=7`),
    fetchText(`${base}/api/api_get_jra_odds.html?race_id=${race.raceId}&type=8`),
  ]);
  return {
    odds: extractOdds(JSON.parse(fTxt), 7, fuku),
    oddsTan: extractOdds(JSON.parse(tTxt), 8, tan),
  };
}
