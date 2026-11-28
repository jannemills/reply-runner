// The sell phase. The numbers (prices, waiting times, the price guide) come from the Worker with each job as `rules`.

const DAY_MS = 24 * 3600_000;
// Chat review, 14 Nov 2026: free photos in a row with no paid offer between them sold nothing (28 free in 10 minutes, 0 sales).
const FREE_STREAK_HOURS = 12;
// Owner, 24 Nov 2026: "you are free to send more free photos, more in the moment photos" (was 2, VIP 3).
// Owner, 26 Nov 2026 (superseding it): "this should never happen again - we should always sell": after 2 free photos the next one is paid.
export const MAX_FREE_STREAK = 2;
export const VIP_MAX_FREE_STREAK = 3;
// Chat review, 24 Nov 2026 (2 of 26 paid offers sold; one fan got 5 locked photos in 33 minutes after asking for a free one, none bought):
// after this many paid offers in a row that he has not bought, no new paid offer for UNBOUGHT_PAUSE_HOURS. Free photos and talk go on.
// Supersedes the 19 Nov "no open-offer limit". A purchase resets the run.
export const MAX_UNBOUGHT_PAID_RUN = 2;
// Review, 25 Nov 2026 ("we sell very less even to hot fans"): 12 h blocked hot buyers for a whole evening; 3 h, then a different format.
export const UNBOUGHT_PAUSE_HOURS = 3;
// Review, 24 Nov 2026 (evening): a second paid offer within minutes of an unbought first one sold nothing. Minimum gap after an unbought paid offer.
export const UNBOUGHT_GAP_MINUTES = 20;
// Owner, 25 Nov 2026 (superior-flamingo-529): hot and writing every minute, but 3 unbought offers meant a 3 h pause and, with the free cap used up, nothing at all to send. The pause only holds a fan who has gone quiet; a fan who wrote in the last LIVE_FAN_MINUTES is still sold to (the 20-minute gap after an unbought offer stays).
export const LIVE_FAN_MINUTES = 15;
// Review, 26 Nov 2026: hot fans got 3-4 free photos within an hour and no priced step (one for 4 hours), and free photos kept coming
// right after an unbought offer. Within FREE_HOUR_MS at most this many free photo messages with no paid offer after them; the next photo is priced.
// The owner's longer streak (MAX_FREE_STREAK, 24 Nov) still applies over the day.
export const FREE_PER_HOUR = 2;
export const VIP_FREE_PER_HOUR = 3;
const FREE_HOUR_MS = 60 * 60_000;
export const FORMAT_SWITCH_HOURS = 6;
// Owner, 26 Nov 2026: "we should be able to send same ppv photos if they were not bought before": an unbought paid photo can be offered again after this.
export const REOFFER_COOLDOWN_HOURS = 24;
// Review after the 27 Nov fixes (11:14-18:05 UTC): a fan got 2 free photos within 12 minutes of a locked $5 pack he had not opened,
// which teaches him to wait for free ones. No free photo while a paid offer from the last FREE_AFTER_UNBOUGHT_MINUTES is unopened.
export const FREE_AFTER_UNBOUGHT_MINUTES = 30;
// Same review: non-VIP low spenders left $5-7 packs of 4 locked (one got 4 packs in 3 h and bought only a $4 single, twice tipping
// instead of unlocking); packs sold to the VIP. A non-VIP gets singles until he has bought in this chat, and a pack then costs at most
// PACK_OVER_SINGLE_USD above his last bought single.
export const PACK_OVER_SINGLE_USD = 2;
export const MIN_PACK_USD = 5;

/** Packs need a VIP or a fan who bought in this chat. */
export const packsAllowed = (h) => Boolean(h.vip) || (h.bought ?? 0) > 0;

/** Why a pack at this price may not go out (on top of photoRefusal), or null when it may. */
export function packRefusal(h, priceUsd) {
  if (h.vip) return null;
  if (!packsAllowed(h))
    return "He has not bought anything in this chat yet. No pack: packs of locked photos stay unopened for fans like him. Send one paid single instead (send_photo kind paid, small and easy, his own words as the caption).";
  if (h.lastBoughtSingleUsd != null) {
    const cap = Math.max(MIN_PACK_USD, h.lastBoughtSingleUsd + PACK_OVER_SINGLE_USD);
    if (priceUsd > cap)
      return `His last single sold at $${h.lastBoughtSingleUsd}. A pack for him costs at most $${cap}: bigger jumps stayed locked. Price it lower, or send a single at his price.`;
  }
  return null;
}

// Owner, 27 Nov 2026 ("this should never happen again", "our most important part is selling"): a fan asked what he gets if he pays for
// 1-3 months and heard "you don't need to pay anything"; hot fans were told to go to sleep. These checks run on every reply, in code.
const flat = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "dj").replace(/ß/g, "ss").replace(/[’`]/g, "'");
const PAY_WORDS = "(?:uplac|uplat|plat|plac|kupi|kupuj|otkljuc|trosi|pretplat|pay|spend|subscrib|buy|unlock|tip|zahl|bezahl|kauf|freischalt|abonn|pagar|spender|abbonar|sblocc|comprar|cumper|abonez|debloch|gastar|suscrib|desbloq)";
const TURNS_AWAY = [
  `\\bne (?:moras|treba|mora)\\b[^.?!]{0,25}\\b${PAY_WORDS}`,
  `\\b(?:no need|(?:do not|don'?t) (?:need|have) to|needn'?t)\\b[^.?!]{0,25}\\b${PAY_WORDS}`,
  `\\b(?:musst|brauchst) (?:du )?(?:nichts?|nicht|kein\\w*)\\b[^.?!]{0,25}${PAY_WORDS}`,
  `\\bnon (?:devi|serve|c'e bisogno(?: di)?)\\b[^.?!]{0,25}\\b${PAY_WORDS}`,
  `\\bnu (?:trebuie|e nevoie)\\b[^.?!]{0,25}\\b${PAY_WORDS}`,
  `\\bno (?:tienes que|hace falta|necesitas)\\b[^.?!]{0,25}\\b${PAY_WORDS}`,
  "\\bne treba mi (?:tvoj novac|tvoje pare)\\b",
].map((r) => new RegExp(r));
/** Her line tells him he does not need to pay, spend or subscribe. */
export const turnsAwayMoney = (line) => TURNS_AWAY.some((r) => r.test(flat(line)));

const SENDS_AWAY = /\b(idi (na )?spava(j|nje|ti)|lezi da spavas|odi spavaj|spavaj sad|odmori se|sacuvaj (malo )?energij|(lep|lijep) dan van|go (to )?(sleep|bed)|get (some )?(sleep|rest)|go (and )?rest|enjoy your (day|night|evening)|outside this chat|geh (jetzt )?(schlafen|ins bett)|vai a (dormire|letto|riposare)|du-?te (la culcare|si te odihnesti|sa dormi)|(vete|ve) a (dormir|descansar))\b/;
/** Her line sends him away from the chat. */
export const sendsHimAway = (line) => SENDS_AWAY.test(flat(line));

const GOODBYE = /\b(laku noc|odoh|idem (sad|da|na|spavat)|spavam|spava mi se|bye|good ?night|gn|going to (bed|sleep)|gotta go|have to go|noapte buna|gute nacht|buona ?notte|vado a|buenas noches|me voy|na posao|radim sad|cujemo se|vidimo se)\b/;
export const saysGoodbye = (fanText) => GOODBYE.test(flat(fanText));

const RAISES_PAYING = /\b(uplati\w*|uplacu\w*|platic\w*|platio bih|da platim|pretplat\w*|koliko (kosta|ce me|para|da platim)|cijena|cena|how much (is|for|do|does|would)|what('?s| is) the price|i('?ll| will) pay|can i pay|want to pay|if i (pay|subscribe)|tip you|send you (a )?(tip|money)|was kostet|ich (be)?zahle|quanto costa|quanto vuoi|cat costa|cuanto (cuesta|vale))\b/;
const CANNOT_PAY = /\b(nemam|ne mogu|necu|ne placam|skupo|preskupo|can'?t|cannot|won'?t|don'?t have|no money|too expensive|broke|not paying|kein geld|zu teuer|non posso|troppo caro|nu am bani|prea scump|no puedo|muy caro|blokiran\w*|blocked|declined)\b/;
/** He brought up paying, a price, subscribing or tipping, and not to say he cannot or will not. */
export const raisesPaying = (fanText) => RAISES_PAYING.test(flat(fanText)) && !CANNOT_PAY.test(flat(fanText));
export const saysCannotPay = (fanText) => CANNOT_PAY.test(flat(fanText));

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
  const [freshMedia, selfies] = await Promise.all([freshFolderMedia(api), selfieFolderMedia(api)]);
  // Owner, 28 Nov 2026 ("we should only send the ppv as ppv - never free"): a photo that sits in "ppv" never goes out free: not as a
  // free photo, gift, selfie, set or pack preview.
  const ppvIds = new Set(ppv.map((m) => m.uuid));
  const freeFrom = (media) => poolFrom(media, skip).filter((p) => !ppvIds.has(p.uuid));
  const fresh = freeFrom(freshMedia.flat()).map((p) => ({ ...p, fresh: true }));
  const freshIds = new Set(fresh.map((p) => p.uuid));
  // Owner, 28 Nov 2026 ("we shouldn't send free photos as ppv"): a photo that sits in a free folder ("free", "free <date>", selfie) is
  // never priced, whatever other folder it is also in (one that is also in "ppv" so goes out neither way). Supersedes the 6 Nov VIP
  // fallback to free photos.
  const givenFree = new Set([...free, ...freshMedia.flat(), ...selfies.flat()].map((m) => m.uuid));
  const paidOnly = (list) => poolFrom(list, skip).filter((p) => !givenFree.has(p.uuid));
  const ppvPool = paidOnly(ppv);
  const inPpv = new Set(ppvPool.map((p) => p.uuid));
  const vipExtra = [...new Map(paidOnly(warmUp.flat()).filter((p) => !inPpv.has(p.uuid)).map((p) => [p.uuid, p])).values()];
  return { free: [...fresh, ...freeFrom(free).filter((p) => !freshIds.has(p.uuid))], ppv: ppvPool, preview: freeFrom(preview), vipExtra, ppvIds };
}

/** The plain selfie folder(s), spelling of the owner's folder included. */
export const isSelfieFolder = (name) => /^(selfies?|selife)$/i.test(String(name ?? "").trim());

async function selfieFolderMedia(api) {
  const folders = await Promise.resolve().then(() => api.listFolders()).catch(() => []);
  const named = (folders ?? []).filter((f) => isSelfieFolder(f.name));
  return Promise.all(named.map((f) => Promise.resolve().then(() => api.listFolderMedia(f.name)).catch(() => [])));
}

/**
 * Owner, 6 Nov 2026: "we should sell to VIP a lot". When a VIP has had every paid photo, paid offers to him may use photos he
 * has never seen from the warm-up folders, only after "ppv" is used up for him. Photos that are also in a free folder are left
 * out (owner, 28 Nov 2026: free photos are never sold).
 * Owner, 26 Nov 2026 ("we should always sell"; a buyer had every "ppv" photo and could be sold nothing): the same for every fan who
 * has bought in this chat (the callers pass vip || bought).
 */
export const VIP_EXTRA_FOLDERS = ["thong", "zapoznavanje 1", "zagrevanje 1", "miksanje 1"];

/** The paid photos he can still be sold: "ppv", and for a buyer or VIP whose "ppv" is used up, the unseen non-free warm-up photos. */
export function paidCandidates(pool, h, vip) {
  // Never offered first; then (VIPs and buyers) unseen extra photos; then paid photos he was offered before and never bought (owner, 26 Nov 2026).
  const ppv = pool.ppv.filter((p) => !h.seen.has(p.uuid));
  const neverOffered = ppv.filter((p) => !h.offeredBefore.has(p.uuid));
  if (neverOffered.length) return neverOffered;
  const extra = vip ? (pool.vipExtra ?? []).filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid)) : [];
  return extra.length ? extra : ppv;
}

/** A pack for one paid message: one random unseen free preview from "preview" (or "free" when "preview" is empty) plus `count` random unseen photos from "ppv". Null when too few are left. */
export function pickPack(pool, h, count, nude, random, vip = false) {
  const unseen = (list) => list.filter((p) => !h.seen.has(p.uuid));
  let rest = unseen(pool.ppv);
  // Owner deleted the "preview" folder (6 Nov 2026) and every pack was refused for every fan: an unseen free photo is the preview then.
  const inRest = new Set(rest.map((p) => p.uuid));
  const previews = unseen(pool.preview ?? []).length ? unseen(pool.preview) : unseen(pool.free ?? []).filter((p) => !h.offeredBefore.has(p.uuid) && !inRest.has(p.uuid));
  // A buyer or VIP with too few paid photos left gets the pack topped up from unseen warm-up photos that are in no free folder.
  if (vip && rest.length < count) rest = [...rest, ...(pool.vipExtra ?? []).filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid))];
  if (!previews.length || rest.length < count) return null;
  // Never offered first; photos offered before and never bought only to fill the pack (owner, 26 Nov 2026).
  const neverOffered = rest.filter((p) => !h.offeredBefore.has(p.uuid));
  if (neverOffered.length >= count) rest = neverOffered;
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
  const h = { seen: new Set(), offeredBefore: new Set(), freePhotos: 0, paidPhotos: 0, paidPacks: 0, bought: 0, lastFreeAt: null, lastPaidAt: null, firstPaidAt: null, openPaid: 0, freeStreak: 0, lastBoughtSingleUsd: null, unboughtRun: 0, lastUnboughtSingleUsd: null, unboughtPacks: 0, freeLastHour: 0, lastBoughtAt: null, recentSeen: new Set(), lastFanAt: null };
  let streakOpen = true;
  let unboughtOpen = true; // counting his newest paid offers until the first one he bought
  for (const m of messages) {
    if (m.sender.uuid === fanUuid) h.lastFanAt = Math.max(h.lastFanAt ?? 0, Date.parse(m.sentAt) || 0);
    if (m.sender.uuid === fanUuid || !m.mediaUuids?.length) continue;
    const at = Date.parse(m.sentAt) || 0;
    const recent = now - at < rules.openPpvDays * DAY_MS;
    const oneToOne = m.type === "SINGLE_RECIPIENT";
    if (now - at < FREE_STREAK_HOURS * 3600_000) m.mediaUuids.forEach((u) => h.recentSeen.add(u));
    if (oneToOne && streakOpen) {
      if (m.pricing || now - at > FREE_STREAK_HOURS * 3600_000) streakOpen = false;
      else {
        h.freeStreak++;
        if (now - at < FREE_HOUR_MS) h.freeLastHour++;
      }
    }
    if (m.pricing) {
      const cents = m.pricing?.USD?.price;
      if (oneToOne && m.purchasedAt && m.mediaUuids.length === 1 && h.lastBoughtSingleUsd == null && cents != null) h.lastBoughtSingleUsd = cents / 100;
      if (oneToOne && unboughtOpen) {
        if (m.purchasedAt || !recent) unboughtOpen = false;
        else {
          if (h.unboughtRun === 0 && m.mediaUuids.length === 1 && cents != null) h.lastUnboughtSingleUsd = cents / 100;
          if (m.mediaUuids.length > 1) h.unboughtPacks++;
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
        h.lastBoughtAt = Math.max(h.lastBoughtAt ?? 0, Date.parse(m.purchasedAt) || at);
        m.mediaUuids.forEach((u) => h.seen.add(u));
      } else {
        if (oneToOne && recent) h.openPaid++;
        // Owner, 26 Nov 2026: a paid photo he never bought was never unlocked, so he has not seen it: after REOFFER_COOLDOWN_HOURS it may
        // be offered again (paid only). A pack's free preview he did see. Was: blocked for openPpvDays (7 days).
        const fresh = now - at < REOFFER_COOLDOWN_HOURS * 3600_000;
        m.mediaUuids.forEach((u) => (u === m.mediaPreviewUuid || fresh ? h.seen : h.offeredBefore).add(u));
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
  // Review, 24 Nov 2026 (12 hours): offers kept going to fans who had said they could not pay. A purchase after the hold ends it.
  const hold = h.paymentHold && !(h.lastBoughtAt && h.lastBoughtAt > h.paymentHold.setAt) ? h.paymentHold : null;
  if (hold && kind !== "free")
    return "He told you he cannot pay right now, so no new paid offer: help him with the one concrete step that fits, keep it warm and short, and wait. When he says it works again, call payment_trouble with works_again, then make one small easy offer.";
  if (hold && kind === "free" && h.lastFreeAt && h.lastFreeAt > hold.setAt)
    return "He told you he cannot pay right now and already got a free photo since then. No more photos for now: keep the chat warm in words.";
  // Owner, 10 Nov 2026: a fan who never paid gets a few free photos, then a small first unlock instead of more free ones.
  // Owner, 17 Nov 2026: no fixed price or format for the first unlock any more; the model decides it per fan (small and easy).
  if (firstBuyer && kind === "free" && rules.freeBeforeFirstBuy != null && h.freePhotos >= rules.freeBeforeFirstBuy)
    return `He has had ${h.freePhotos} free photos and never paid. No more free ones: his next photo is his small, easy paid first unlock (one paid single, priced for him).`;
  const isPack = kind === "pack";
  if (kind === "pack") kind = "paid";
  if (kind === "free" && h.freeStreak >= (h.freeStreakLimit ?? MAX_FREE_STREAK))
    return `He has had ${h.freeStreak} free photo messages in a row with no paid offer after them. No more free ones now: send a small paid single of what he asked for (at or below his last price), then a free bonus when he buys.`;
  if (kind === "free" && h.freeLastHour >= (h.freeHourLimit ?? FREE_PER_HOUR))
    return `He has had ${h.freeLastHour} free photos in the last hour with no paid offer after them. No more free ones now: if he is warm, this photo is the priced step (send_photo kind paid or send_ppv_pack, his own words as the caption). If a paid offer is refused too, answer in words only.`;
  if (kind === "free" && !h.thanks && (h.unboughtRun ?? 0) >= 1 && h.lastPaidAt && now - h.lastPaidAt < FREE_AFTER_UNBOUGHT_MINUTES * 60_000)
    return `Your paid offer from ${Math.max(1, Math.round((now - h.lastPaidAt) / 60_000))} min ago is still locked. No free photo now: a free one next to it teaches him to wait. Answer him in words and tease what is in the locked one, without describing it.`;
  if (kind === "free") {
    if (h.lastFreeAt && now - h.lastFreeAt < rules.freePhotoDays * DAY_MS)
      return `He got a free photo in the last ${rules.freePhotoDays} days. No new one yet.`;
    return null;
  }
  // Owner, 28 Nov 2026: no minimum chat age before the first paid offer (was 10 minutes, 26 Nov). Whether he is ready is the model's call.
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
  // Review, 24 Nov 2026 (evening): $5 then $4 six minutes apart, $4 then $3 in three, $8 then $7 in four, none bought. A paid offer he has not bought
  // blocks the next one for UNBOUGHT_GAP_MINUTES: he has to look at it first.
  if (!h.payIntent && (h.unboughtRun ?? 0) >= 1 && h.lastPaidAt && now - h.lastPaidAt < UNBOUGHT_GAP_MINUTES * 60_000)
    return `Your last paid offer went out ${Math.max(1, Math.round((now - h.lastPaidAt) / 60_000))} min ago and he has not bought it. No second paid offer within ${UNBOUGHT_GAP_MINUTES} minutes: let him look at it. Answer him in words and mention the locked one only if he brings it up.`;
  if (!h.payIntent && (h.unboughtRun ?? 0) >= MAX_UNBOUGHT_PAID_RUN && h.lastPaidAt && now - h.lastPaidAt < UNBOUGHT_PAUSE_HOURS * 3600_000 && !(h.lastFanAt && now - h.lastFanAt < LIVE_FAN_MINUTES * 60_000))
    return `He has ${h.unboughtRun} paid offers in a row that he has not bought. No new paid offer for now: talk with him, or give a free photo or an "in the moment" set, and mention the locked one only if he brings it up. When the pause ends, change the format (a pack with a free preview instead of a single, or a smaller price), not more of the same.`;
  // Review, 26 Nov 2026 (superior-flamingo-529): 7 unbought singles at $5-7 in four hours, and he said twice the photos only showed her back.
  // After MAX_UNBOUGHT_PAID_RUN unbought offers of one kind, the next one must be the other kind.
  // Only within FORMAT_SWITCH_HOURS of the last offer, and never a dead end: once both kinds went unbought, either may go.
  const unboughtSingles = (h.unboughtRun ?? 0) - (h.unboughtPacks ?? 0);
  const fresh = h.lastPaidAt && now - h.lastPaidAt < FORMAT_SWITCH_HOURS * 3600_000;
  // A fan who may not get packs yet (packRefusal) is never told to send one: his next single is cheaper instead, or the lowest price.
  if (fresh && !isPack && unboughtSingles >= MAX_UNBOUGHT_PAID_RUN && (h.unboughtPacks ?? 0) < MAX_UNBOUGHT_PAID_RUN && !packsAllowed(h)) {
    const last = h.lastUnboughtSingleUsd;
    if (last != null && last > rules.minPriceUsd && priceUsd >= last)
      return `He has not bought your last ${unboughtSingles} paid singles. Not the same again: ask him what he wants to see and match it with one cheaper single (below $${last}; nude: true if he wants more skin).`;
  } else if (fresh && !isPack && unboughtSingles >= MAX_UNBOUGHT_PAID_RUN && (h.unboughtPacks ?? 0) < MAX_UNBOUGHT_PAID_RUN)
    return `He has not bought your last ${unboughtSingles} paid singles. Not another single: change the format (send_ppv_pack with a free preview), or ask him what he wants to see and match it (nude: true if he wants more skin). Never more of the same.`;
  if (fresh && isPack && (h.unboughtPacks ?? 0) >= MAX_UNBOUGHT_PAID_RUN && unboughtSingles < MAX_UNBOUGHT_PAID_RUN)
    return `He has not bought your last ${h.unboughtPacks} packs. Not another pack: try one small single of exactly what he asked for, at a lower price.`;
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

// Review, 24 Nov 2026: three near-identical car selfies (one shoot, uploaded the same minute as three files) went to one fan in
// 33 minutes, and he said "you just sent me this one". Photos uploaded within this long of one he got lately count as the same scene.
export const SAME_SCENE_MS = 3 * 60_000;

/** The candidates not from the same upload batch as a photo he got in the last hours; all of them if none is left. */
export function apartFromRecent(candidates, pool, h) {
  const byId = new Map([...(pool.free ?? []), ...(pool.ppv ?? []), ...(pool.preview ?? []), ...(pool.vipExtra ?? [])].map((p) => [p.uuid, p.createdAt]));
  const times = [...(h.recentSeen ?? [])].map((u) => byId.get(u)).filter(Boolean);
  if (!times.length) return candidates;
  const apart = candidates.filter((p) => !p.createdAt || times.every((t) => Math.abs(t - p.createdAt) > SAME_SCENE_MS));
  return apart.length ? apart : candidates;
}

/** A random photo he has not seen. A paid photo he never opened may be offered again as a paid one. */
export function pickPhoto(pool, kind, h, nude, random, vip = false) {
  const candidates = apartFromRecent(
    kind === "paid" ? paidCandidates(pool, h, vip) : pool.free.filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid)),
    pool,
    h,
  );
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

/**
 * Review, 24 Nov 2026 (12 hours): a past tipper chatted about 80 messages and a spender about 35 with no priced offer. Counts her
 * one-to-one messages (text and free photos) since her newest paid message, newest first in; the whole window if there is none.
 */
export function sincePaidRun(messagesNewestFirst, fanUuid) {
  let n = 0;
  for (const m of messagesNewestFirst) {
    if (m.sender.uuid === fanUuid || m.type !== "SINGLE_RECIPIENT") continue;
    if (m.pricing) break;
    n++;
  }
  return n;
}
