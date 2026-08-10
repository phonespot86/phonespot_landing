/**
 * 폰스팟 랜딩 ↔ 씨티몰 시세 연동 Worker (v8)
 * 배포: Cloudflare 대시보드 → Workers & Pages → 워커 → Edit code → 전체 교체 → Deploy
 *
 * v8: 캐시 30분으로 조정 + 캐시키를 /v8로 올려 기존 캐시를 즉시 무효화.
 * v7: citymarket 폐쇄 대응 — 씨티몰(citymall.co.kr)의 새 API(qwe123.co.kr)로 전면 교체.
 *     기준: 폰스팟 채널(sellChannelIdx=1), 번호이동 + 공시지원금(calcPublicPort), 모델별 최저가.
 *     상세 딥링크는 새 시스템에서 미지원(내부 상태 방식) → 링크는 citymall.co.kr/pb 목록으로.
 */

const API_BASE = 'https://qwe123.co.kr';
const SELL_CHANNEL_IDX = 1;                    // 폰스팟
const CARRIERS = { 1: 'KT', 2: 'SKT', 3: 'LG' };
// 캐시 유지 시간(초) — 30분.
// 이 값 하나가 두 곳을 동시에 정함:
//   ① 워커가 씨티몰(qwe123)을 다시 조회하는 주기
//   ② 방문자 브라우저가 워커에 다시 요청하는 주기(Cache-Control) ← 워커 호출 수를 줄이는 건 이쪽
// 값을 바꿀 때는 아래 cacheKey의 버전(/v8)도 같이 올려야 즉시 반영됨.
const CACHE_SECONDS = 1800;

function won(n) {
  n = Math.round(Number(n));
  return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('ko-KR') + '원';
}

function linkFor(carrier) {
  return 'https://citymall.co.kr/pb?utm_source=landing&utm_medium=price_card&utm_campaign=' + encodeURIComponent(carrier);
}

export default {
  async fetch(request, env, ctx) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
    };

    const cache = caches.default;
    const cacheKey = new Request('https://phonespot-prices.cache/v8');
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(await hit.text(), { headers });

    const byModel = {};   // petName → { name, deals: {carrier: deal} }

    try {
      for (const idx of Object.keys(CARRIERS)) {
        const carrier = CARRIERS[idx];
        const r = await fetch(API_BASE + '/phone-price-lookup/products?carrierIdx=' + idx + '&sellChannelIdx=' + SELL_CHANNEL_IDX, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhonespotLanding/7.0)', 'Origin': 'https://citymall.co.kr', 'Referer': 'https://citymall.co.kr/pb' },
        });
        if (!r.ok) throw new Error('source ' + r.status + ' (carrier ' + carrier + ')');
        const products = await r.json();
        for (const p of products) {
          if (!p || p.modelDisplayIsVisible != 1 || p.productDisplayIsVisiblePort != 1) continue;
          const c = p.calcPublicPort;               // 번호이동 + 공시지원금
          if (!c || c.purchasePrice == null) continue;
          const pet = p.modelPetName || p.modelName;
          if (!pet) continue;
          if (!byModel[pet]) byModel[pet] = { name: pet.replace(/_/g, ' '), deals: {} };
          const cur = byModel[pet].deals[carrier];
          if (!cur || c.purchasePrice < cur._buy) {
            byModel[pet].deals[carrier] = {
              _buy: c.purchasePrice,
              carrier,
              route: '번호이동',
              pct: p.modelPrice > 0 ? Math.round((1 - c.purchasePrice / p.modelPrice) * 100) + '%' : '',
              price: won(c.purchasePrice),
              original: p.modelPrice > 0 ? won(p.modelPrice) : '',
              plan: p.pricePlanName || '',
              link: linkFor(carrier),
            };
          }
        }
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers });
    }

    const models = Object.values(byModel).map(function (m) {
      return {
        name: m.name,
        deals: Object.values(m.deals).map(function (d) { delete d._buy; return d; }),
      };
    }).filter(function (m) { return m.deals.length > 0; });

    const payload = JSON.stringify({
      updated: new Date().toISOString(),
      source: 'citymall.co.kr (qwe123 phone-price-lookup)',
      count: models.length,
      models,
    });

    if (models.length > 0) {
      ctx.waitUntil(cache.put(cacheKey, new Response(payload, { headers })));
    }
    return new Response(payload, { headers });
  },
};
