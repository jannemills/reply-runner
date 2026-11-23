// The sell phase. The numbers (prices, waiting times, the price guide) come from the Worker with each job as `rules`.

const DAY_MS = 24 * 3600_000;
// Chat review, 14 Nov 2026: free photos in a row with no paid offer between them sold nothing (28 free in 10 minutes, 0 sales).
const FREE_STREAK_HOURS = 12;
// Owner, 24 Nov 2026: "you are free to send more free photos, more in the moment photos" (was 2, VIP 3).
export const MAX_FREE_STREAK = 4;
export const VIP_MAX_FREE_STREAK = 6;
// Chat review, 24 Nov 2026 (2 of 26 paid offers sold; one fan got 5 locked photos in 33 minutes after asking for a free one, none bought):
// after this many paid offers in a row that he has not bought, no new paid offer for UNBOUGHT_PAUSE_HOURS. Free photos and talk go on.
// Supersedes the 19 Nov "no open-offer limit". A purchase resets the run.
export const MAX_UNBOUGHT_PAID_RUN = 2;
export const UNBOUGHT_PAUSE_HOURS = 12;

const isAiRefurbished = (m) => /ai image/i.test(m.name ?? "");

/** Ready images from a vault folder, minus AI-refurbished files, posted media and media held for scheduled mass messages. */
export function poolFrom(media, skip) {
  return media
    .filter((m) => m.status === "ready" && m.mediaType === "image" && !isAiRefurbished(m) && !skip.has(m.uuid))
    .map((m) => ({
      uuid: m.uuid,
      createdAt: Date.parse(m.createdAt ?? "") || 0,
      nude: [...(m.tags?.tags ?? []), ...(m.tags?.nsfwCategory ?? [])].some((t) => t.toLowerCase() === "nudes"),
    }));
}

/**
 * Owner, 11 Nov 2026: vivid-prawn-53 (the top spender) only gets photos added to the vault from 10 Nov 2026 on; nothing older,
 * free or paid. Photos with no readable date are left out for him too.
 */
export const PHOTO_FROM_BY_FAN = {
  "94ca4ee5-48c5-47ef-94a3-28b2ee170af6": Date.parse("2026-11-10T00:00:00Z"),
  // Martin28 (owner, 18 Nov 2026): same cut-off as vivid-prawn-53.
  "d3fb9c02-f878-4d89-b9df-5031c1d4c989": Date.parse("2026-11-10T00:00:00Z"),
};

/** The pool for one fan: his photo cut-off date applied to every list, if he has one. */
export function poolForFan(pool, fanUuid) {
  const from = PHOTO_FROM_BY_FAN[fanUuid];
  if (!pool || !from) return pool;
  const keep = (list) => (list ?? []).filter((p) => p.createdAt >= from);
  return { ...pool, free: keep(pool.free), ppv: keep(pool.ppv), preview: keep(pool.preview), vipExtra: keep(pool.vipExtra) };
}

/** Media of every vault folder named "free <something>" (owner, 24 Nov 2026), newest folder first. Never throws. */
export async function freshFolderMedia(api) {
  const folders = await Promise.resolve().then(() => api.listFolders()).catch(() => []);
  const names = (folders ?? []).filter((f) => /^free\s+\S/i.test(String(f.name ?? "").trim())).sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  return Promise.all(names.map((f) => Promise.resolve().then(() => api.listFolderMedia(f.name)).catch(() => [])));
}

/** The photos the sell phase may use: ready images in the vault folders "free" and "ppv", minus the "AI Images" folder. */
export async function buildPool(api) {
  const [free, ppv, preview, ai, posted, scheduled, ...warmUp] = await Promise.all([
    api.listFolderMedia("free"),
    api.listFolderMedia("ppv"),
    // Owner may delete or rename optional folders (6 Nov 2026: "AI Images" and "preview" were gone and a 404 there
    // broke the whole pool, so no fan got any photo for hours). Only "free" and "ppv" are required.
    api.listFolderMedia("preview").catch(() => []),
    api.listFolderMedia("AI Images").catch(() => []),
    api.listPostedMedia(),
    api.listScheduledMassMedia(),
    ...VIP_EXTRA_FOLDERS.map((f) => api.listFolderMedia(f).catch(() => [])),
  ]);
  const skip = new Set([...ai.map((m) => m.uuid), ...posted, ...scheduled]);
  // Owner, 24 Nov 2026: a vault folder named "free <date>" (e.g. "free 23.11") holds new, fresh photos for free sends; they go out
  // before the older "free" folder (pickPhoto prefers `fresh`). Optional: a missing or unreadable folder changes nothing.
  const fresh = poolFrom((await freshFolderMedia(api)).flat(), skip).map((p) => ({ ...p, fresh: true }));
  const freshIds = new Set(fresh.map((p) => p.uuid));
  const ppvPool = poolFrom(ppv, skip);
  const inPpv = new Set(ppvPool.map((p) => p.uuid));
  const vipExtra = [...new Map(poolFrom([...free, ...warmUp.flat()], skip).filter((p) => !inPpv.has(p.uuid)).map((p) => [p.uuid, p])).values()];
  return { free: [...fresh, ...poolFrom(free, skip).filter((p) => !freshIds.has(p.uuid))], ppv: ppvPool, preview: poolFrom(preview, skip), vipExtra };
}

/**
 * Owner, 6 Nov 2026: "we should sell to VIP a lot". When a VIP has had every paid photo, paid offers to him may use photos he
 * has never seen from the free and warm-up folders. Only for VIPs and only after "ppv" is used up for him.
 */
export const VIP_EXTRA_FOLDERS = ["thong", "zapoznavanje 1", "zagrevanje 1", "miksanje 1"];

/** The paid photos he can still be sold: "ppv", and for a VIP whose "ppv" is used up, the unseen free and warm-up photos. */
export function paidCandidates(pool, h, vip) {
  const ppv = pool.ppv.filter((p) => !h.seen.has(p.uuid));
  if (ppv.length || !vip) return ppv;
  return (pool.vipExtra ?? []).filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid));
}

/** A pack for one paid message: one random unseen free preview from "preview" (or "free" when "preview" is empty) plus `count` random unseen photos from "ppv". Null when too few are left. */
export function pickPack(pool, h, count, nude, random, vip = false) {
  const unseen = (list) => list.filter((p) => !h.seen.has(p.uuid));
  let rest = unseen(pool.ppv);
  // Owner deleted the "preview" folder (6 Nov 2026) and every pack was refused for every fan: an unseen free photo is the preview then.
  const inRest = new Set(rest.map((p) => p.uuid));
  const previews = unseen(pool.preview ?? []).length ? unseen(pool.preview) : unseen(pool.free ?? []).filter((p) => !h.offeredBefore.has(p.uuid) && !inRest.has(p.uuid));
  // A VIP with too few paid photos left gets the pack topped up from the unseen free and warm-up photos.
  if (vip && rest.length < count) rest = [...rest, ...(pool.vipExtra ?? []).filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid))];
  if (!previews.length || rest.length < count) return null;
  if (nude && rest.filter((p) => p.nude).length >= count) rest = rest.filter((p) => p.nude);
  const preview = previews[Math.floor(random() * previews.length)].uuid;
  const left = [...rest];
  const photos = [];
  while (photos.length < count) photos.push(left.splice(Math.floor(random() * left.length), 1)[0].uuid);
  return { preview, photos };
}

/** What photos this fan already got, from his chat (newest first). Mass messages that reached him count too. */
export function salesHistory(messages, fanUuid, now, rules) {
  // freeStreak: free photo messages to him since the newest paid one, within FREE_STREAK_HOURS (chat review, 14 Nov 2026).
  // lastBoughtSingleUsd: the price of the newest single paid photo he bought.
  const h = { seen: new Set(), offeredBefore: new Set(), freePhotos: 0, paidPhotos: 0, paidPacks: 0, bought: 0, lastFreeAt: null, lastPaidAt: null, firstPaidAt: null, openPaid: 0, freeStreak: 0, lastBoughtSingleUsd: null, unboughtRun: 0, lastUnboughtSingleUsd: null };
  let streakOpen = true;
  let unboughtOpen = true; // counting his newest paid offers until the first one he bought
  for (const m of messages) {
    if (m.sender.uuid === fanUuid || !m.mediaUuids?.length) continue;
    const at = Date.parse(m.sentAt) || 0;
    const recent = now - at < rules.openPpvDays * DAY_MS;
    const oneToOne = m.type === "SINGLE_RECIPIENT";
    if (oneToOne && streakOpen) {
      if (m.pricing || now - at > FREE_STREAK_HOURS * 3600_000) streakOpen = false;
      else h.freeStreak++;
    }
    if (m.pricing) {
      const cents = m.pricing?.USD?.price;
      if (oneToOne && m.purchasedAt && m.mediaUuids.length === 1 && h.lastBoughtSingleUsd == null && cents != null) h.lastBoughtSingleUsd = cents / 100;
      if (oneToOne && unboughtOpen) {
        if (m.purchasedAt || !recent) unboughtOpen = false;
        else {
          if (h.unboughtRun === 0 && m.mediaUuids.length === 1 && cents != null) h.lastUnboughtSingleUsd = cents / 100;
          h.unboughtRun++;
        }
      }
      if (oneToOne) {
        h.paidPhotos++;
        if (m.mediaUuids.length > 1) h.paidPacks++; // owner, 13 Nov 2026: a paid message with several photos is a pack
        h.lastPaidAt = Math.max(h.lastPaidAt ?? 0, at);
        h.firstPaidAt = Math.min(h.firstPaidAt ?? at, at);
      }
      if (m.purchasedAt) {
        h.bought++;
        m.mediaUuids.forEach((u) => h.seen.add(u));
      } else {
        if (oneToOne && recent) h.openPaid++;
        m.mediaUuids.forEach((u) => (recent ? h.seen : h.offeredBefore).add(u));
      }
    } else {
      if (oneToOne) {
        h.freePhotos++;
        h.lastFreeAt = Math.max(h.lastFreeAt ?? 0, at);
      }
      m.mediaUuids.forEach((u) => h.seen.add(u));
    }
  }
  for (const u of h.seen) h.offeredBefore.delete(u);
  return h;
}

/**
 * His own price level in whole dollars: the higher of his average tip and his average paid message (subscriptions do not count).
 * 19 Nov 2026 review: a fan with $90 spent, mostly tips of about $7, was offered $3-6 singles because only his last bought single counted.
 */
export function priceAnchorUsd(insights) {
  const src = insights?.spending?.sources ?? {};
  const avg = (k) => ((src[k]?.netCount ?? 0) > 0 ? (src[k].netAverage ?? 0) / 100 : 0);
  return Math.round(Math.max(avg("tip"), avg("message")));
}

/** Why this photo may not go out now, or null when it may. */
export function photoRefusal(kind, h, now, priceUsd, rules, firstBuyer = false) {
  // Owner, 10 Nov 2026: a fan who never paid gets a few free photos, then a small first unlock instead of more free ones.
  // Owner, 17 Nov 2026: no fixed price or format for the first unlock any more; the model decides it per fan (small and easy).
  if (firstBuyer && kind === "free" && rules.freeBeforeFirstBuy != null && h.freePhotos >= rules.freeBeforeFirstBuy)
    return `He has had ${h.freePhotos} free photos and never paid. No more free ones: his next photo is his small, easy paid first unlock (a single or a small pack, priced for him).`;
  const isPack = kind === "pack";
  if (kind === "pack") kind = "paid";
  if (kind === "free" && h.freeStreak >= (h.freeStreakLimit ?? MAX_FREE_STREAK))
    return `He has had ${h.freeStreak} free photo messages in a row with no paid offer after them. No more free ones now: send a small paid single of what he asked for (at or below his last price), then a free bonus when he buys.`;
  if (kind === "free") {
    if (h.lastFreeAt && now - h.lastFreeAt < rules.freePhotoDays * DAY_MS)
      return `He got a free photo in the last ${rules.freePhotoDays} days. No new one yet.`;
    return null;
  }
  if (!Number.isInteger(priceUsd) || priceUsd < rules.minPriceUsd || priceUsd > rules.maxPriceUsd)
    return `Choose a whole-dollar price from ${rules.minPriceUsd} to ${rules.maxPriceUsd}.`;
  // Chat review, 14 Nov 2026: jumps of 20-50% right after a purchase sold 0 of 4. A single goes at most $5 (or 15%) above his last bought single.
  if (!isPack && h.lastBoughtSingleUsd != null) {
    const anchor = h.priceAnchorUsd ?? 0;
    const ceiling = Math.max(h.lastBoughtSingleUsd + 5, Math.round(h.lastBoughtSingleUsd * 1.15), anchor + 5, Math.round(anchor * 1.15));
    if (priceUsd > ceiling)
      return `His last single photo sold at $${h.lastBoughtSingleUsd}. Price this one at most $${ceiling}: bigger jumps did not sell. For more money offer a pack instead.`;
  }
  // Chat review, 24 Nov 2026: a price went $10 -> $12 -> $15 on offers he never bought. A single never costs more than his newest unbought single.
  if (!isPack && h.lastUnboughtSingleUsd != null && priceUsd > h.lastUnboughtSingleUsd)
    return `He has not bought your last single at $${h.lastUnboughtSingleUsd}. A new single costs at most that: raising the price on an unbought offer does not sell.`;
  if ((h.unboughtRun ?? 0) >= MAX_UNBOUGHT_PAID_RUN && h.lastPaidAt && now - h.lastPaidAt < UNBOUGHT_PAUSE_HOURS * 3600_000)
    return `He has ${h.unboughtRun} paid offers in a row that he has not bought. No new paid offer for now: talk with him, or give a free photo or an "in the moment" set, and mention the locked one only if he brings it up.`;
  // Owner, 19 Nov 2026 (superseded 24 Nov by the unbought run above): "we shouldn't have any open-offer limit ... if he doesn't open the previous we send new ones". No limit on unopened paid messages.
  if (h.lastPaidAt && now - h.lastPaidAt < rules.paidPhotoHours * 3600_000) return `He got a paid photo in the last ${rules.paidPhotoHours} hours. No new one yet.`;
  return null;
}

/**
 * Owner, 6 Nov 2026: the replier may stop answering a fan it judges will never buy, but only after it really tried.
 * Why he may not be dropped yet, or null when he may. Hard limits only; whether he is a lost cause is the model's call.
 */
export function notBuyingRefusal(insights, h, now, rules, { vip, noSale }) {
  if (vip) return "He is a VIP: never stop answering him.";
  if (noSale) return "He may not be sold to right now, so you cannot judge whether he would buy. Keep answering.";
  if (!insights) return "Could not read what he has spent. Keep answering.";
  // Owner, 19 Nov 2026: "if the client refuses and we decide it's not a spender, we move him to ignore". A subscription (or its renewal) is not
  // buying content: only a fan who bought something else (a paid message, a tip) is protected from being stopped.
  const sources = Object.entries(insights.spending?.sources ?? {});
  const spent = sources.filter(([k]) => k !== "subscription" && k !== "renewal").reduce((n, [, v]) => n + (v.netTotal ?? 0), 0);
  if (spent > 0 || h.bought > 0) return "He has bought content or tipped before: never stop answering a fan who has spent money on you.";
  const minOffers = rules.giveUpMinOffers ?? 3;
  if (h.paidPhotos < minOffers)
    return `He has had only ${h.paidPhotos} paid ${h.paidPhotos === 1 ? "offer" : "offers"} in this chat; at least ${minOffers} first. Keep going.`;
  const minDays = rules.giveUpMinDays ?? 3;
  if (!h.firstPaidAt || now - h.firstPaidAt < minDays * DAY_MS)
    return `His first paid offer is less than ${minDays} days old. Give him more time.`;
  // Owner, 13 Nov 2026: sell more extensively to likely non-spenders so the ignore decision is easy. Before he is dropped he must have
  // seen both formats (a single photo and a pack with a free preview), unless he already had four offers.
  const singles = h.paidPhotos - (h.paidPacks ?? 0);
  if (h.paidPhotos < 4 && (singles < 1 || (h.paidPacks ?? 0) < 1))
    return `He has not yet been offered both a single paid photo and a pack with a free preview (${singles} single, ${h.paidPacks ?? 0} pack). Offer the missing kind first, then judge.`;
  return null;
}

/** A random photo he has not seen. A paid photo he never opened may be offered again as a paid one. */
export function pickPhoto(pool, kind, h, nude, random, vip = false) {
  const candidates =
    kind === "paid" ? paidCandidates(pool, h, vip) : pool.free.filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid));
  // Owner, 24 Nov 2026: the new "free <date>" folder goes first; the older "free" photos only when it has none left for him.
  const fresh = candidates.filter((p) => p.fresh);
  const pool0 = kind !== "paid" && fresh.length ? fresh : candidates;
  const preferred = nude ? pool0.filter((p) => p.nude) : pool0;
  const from = preferred.length ? preferred : pool0;
  return from.length ? from[Math.floor(random() * from.length)].uuid : null;
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

/** The fan profile the reply model reads before deciding on the phase and the offer. Numbers only, no chat text. */
export function profileText(raw, h, rules) {
  const i = raw ?? {};
  const s = i.spending ?? {};
  const total = s.total?.netTotal ?? 0;
  const sources = Object.entries(s.sources ?? {}).filter(([, v]) => (v.netCount ?? 0) > 0);
  const count = sources.reduce((n, [, v]) => n + (v.netCount ?? 0), 0);
  const sub = i.subscription;
  return [
    `Status: ${i.status ?? "unknown"}${sub ? `, subscribed since ${day(Date.parse(sub.createdAt ?? ""))}, ${sub.autoRenewalEnabled ? "auto-renew on" : "auto-renew off"}, renews or ends ${day(Date.parse(sub.renewsAt ?? ""))}` : ""}`,
    `Spent in total: ${usd(total)} over ${count} payments${count ? `, average ${usd(total / count)}` : ""}, largest ${usd(s.maxSinglePayment?.total ?? 0)}, last purchase ${day(Date.parse(s.lastPurchaseAt ?? ""))}`,
    `By source: ${sources.map(([k, v]) => `${k} ${usd(v.netTotal ?? 0)} (${v.netCount})`).join(", ") || "none"}`,
    `Photos in this chat: ${h.freePhotos} free (last ${day(h.lastFreeAt)}), ${h.paidPhotos} paid (last ${day(h.lastPaidAt)}), ${h.bought} bought, ${h.openPaid ? `${h.openPaid} paid ${h.openPaid === 1 ? "message" : "messages"} from the last ${rules.openPpvDays} days still unopened` : `no unopened paid photo from the last ${rules.openPpvDays} days`}`,
    priceAnchorUsd(i) ? `His price level: about $${priceAnchorUsd(i)} (the higher of his average tip and his average paid message). Singles go at or above it; a $3-5 offer to a fan above that level is the weak-pricing mistake.` : "",
    rules.priceGuide,
  ].filter(Boolean).join("\n");
}

/** Owner, 10 Nov 2026: true when he has never paid anything (no purchase in the chat, $0 spent). Unknown spend or a VIP is not a first buyer. */
export function isFirstBuyer(insights, h, vip) {
  if (vip || !insights || h.bought > 0) return false;
  return (insights.spending?.total?.netTotal ?? 0) <= 0;
}

/**
 * Owner, 15 Nov 2026 ("he teases us and we don't sell"): a $0 fan sexted for free for 14 hours, about 150 text replies, one free
 * photo and no purchase. Counts the one-to-one text messages from her side since her newest photo message (newest first in).
 */
export function freeTalkRun(messagesNewestFirst, fanUuid) {
  let n = 0;
  for (const m of messagesNewestFirst) {
    if (m.sender.uuid === fanUuid || m.type !== "SINGLE_RECIPIENT") continue;
    if (m.mediaUuids?.length) break;
    n++;
  }
  return n;
}
