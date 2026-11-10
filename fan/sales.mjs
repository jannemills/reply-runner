// The sell phase. The numbers (prices, waiting times, the price guide) come from the Worker with each job as `rules`.

const DAY_MS = 24 * 3600_000;

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
export const PHOTO_FROM_BY_FAN = { "94ca4ee5-48c5-47ef-94a3-28b2ee170af6": Date.parse("2026-11-10T00:00:00Z") };

/** The pool for one fan: his photo cut-off date applied to every list, if he has one. */
export function poolForFan(pool, fanUuid) {
  const from = PHOTO_FROM_BY_FAN[fanUuid];
  if (!pool || !from) return pool;
  const keep = (list) => (list ?? []).filter((p) => p.createdAt >= from);
  return { ...pool, free: keep(pool.free), ppv: keep(pool.ppv), preview: keep(pool.preview), vipExtra: keep(pool.vipExtra) };
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
  const ppvPool = poolFrom(ppv, skip);
  const inPpv = new Set(ppvPool.map((p) => p.uuid));
  const vipExtra = [...new Map(poolFrom([...free, ...warmUp.flat()], skip).filter((p) => !inPpv.has(p.uuid)).map((p) => [p.uuid, p])).values()];
  return { free: poolFrom(free, skip), ppv: ppvPool, preview: poolFrom(preview, skip), vipExtra };
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
  const h = { seen: new Set(), offeredBefore: new Set(), freePhotos: 0, paidPhotos: 0, bought: 0, lastFreeAt: null, lastPaidAt: null, firstPaidAt: null, openPaid: 0 };
  for (const m of messages) {
    if (m.sender.uuid === fanUuid || !m.mediaUuids?.length) continue;
    const at = Date.parse(m.sentAt) || 0;
    const recent = now - at < rules.openPpvDays * DAY_MS;
    const oneToOne = m.type === "SINGLE_RECIPIENT";
    if (m.pricing) {
      if (oneToOne) {
        h.paidPhotos++;
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

/** Why this photo may not go out now, or null when it may. */
export function photoRefusal(kind, h, now, priceUsd, rules, firstBuyer = false) {
  // Owner, 10 Nov 2026: a fan who never paid gets a few free photos, then a small first unlock instead of more free ones.
  if (firstBuyer && rules.firstBuyMaxUsd != null) {
    const range = `$${rules.minPriceUsd} to $${rules.firstBuyMaxUsd}`;
    if (kind === "free" && rules.freeBeforeFirstBuy != null && h.freePhotos >= rules.freeBeforeFirstBuy)
      return `He has had ${h.freePhotos} free photos and never paid. No more free ones: his next photo is one small paid photo (${range}), his first unlock.`;
    if (kind === "paid" && Number(priceUsd) > rules.firstBuyMaxUsd)
      return `He has never paid anything: his first unlock costs ${range}. Choose a price in that range.`;
    if (kind === "pack")
      return `He has never paid anything: his first offer is one single paid photo with send_photo at ${range}, not a pack.`;
  }
  if (kind === "pack") kind = "paid";
  if (kind === "free") {
    if (h.lastFreeAt && now - h.lastFreeAt < rules.freePhotoDays * DAY_MS)
      return `He got a free photo in the last ${rules.freePhotoDays} days. No new one yet.`;
    return null;
  }
  if (!Number.isInteger(priceUsd) || priceUsd < rules.minPriceUsd || priceUsd > rules.maxPriceUsd)
    return `Choose a whole-dollar price from ${rules.minPriceUsd} to ${rules.maxPriceUsd}.`;
  // Owner, 5 Nov 2026: a hot chat is not left waiting on one locked photo. Up to maxOpenPaid unopened paid messages at once.
  const maxOpen = rules.maxOpenPaid ?? 1;
  if (h.openPaid >= maxOpen)
    return `He already has ${h.openPaid} paid ${h.openPaid === 1 ? "message" : "messages"} from the last ${rules.openPpvDays} days that he has not opened. No new one: tease about those instead.`;
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
  const spent = insights.spending?.total?.netTotal ?? 0;
  if (spent > 0 || h.bought > 0) return "He has paid before: never stop answering a fan who has spent money.";
  const minOffers = rules.giveUpMinOffers ?? 3;
  if (h.paidPhotos < minOffers)
    return `He has had only ${h.paidPhotos} paid ${h.paidPhotos === 1 ? "offer" : "offers"} in this chat; at least ${minOffers} first. Keep going.`;
  const minDays = rules.giveUpMinDays ?? 3;
  if (!h.firstPaidAt || now - h.firstPaidAt < minDays * DAY_MS)
    return `His first paid offer is less than ${minDays} days old. Give him more time.`;
  return null;
}

/** A random photo he has not seen. A paid photo he never opened may be offered again as a paid one. */
export function pickPhoto(pool, kind, h, nude, random, vip = false) {
  const candidates =
    kind === "paid" ? paidCandidates(pool, h, vip) : pool.free.filter((p) => !h.seen.has(p.uuid) && !h.offeredBefore.has(p.uuid));
  const preferred = nude ? candidates.filter((p) => p.nude) : candidates;
  const from = preferred.length ? preferred : candidates;
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
    `Photos in this chat: ${h.freePhotos} free (last ${day(h.lastFreeAt)}), ${h.paidPhotos} paid (last ${day(h.lastPaidAt)}), ${h.bought} bought, ${h.openPaid ? `${h.openPaid} paid ${h.openPaid === 1 ? "message" : "messages"} from the last ${rules.openPpvDays} days still unopened (at most ${rules.maxOpenPaid ?? 1} open at once)` : `no unopened paid photo from the last ${rules.openPpvDays} days`}`,
    rules.priceGuide,
  ].join("\n");
}

/** Owner, 10 Nov 2026: true when he has never paid anything (no purchase in the chat, $0 spent). Unknown spend or a VIP is not a first buyer. */
export function isFirstBuyer(insights, h, vip) {
  if (vip || !insights || h.bought > 0) return false;
  return (insights.spending?.total?.netTotal ?? 0) <= 0;
}
