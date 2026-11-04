// The sell phase. The numbers (prices, waiting times, the price guide) come from the Worker with each job as `rules`.

const DAY_MS = 24 * 3600_000;

const isAiRefurbished = (m) => /ai image/i.test(m.name ?? "");

/** Ready images from a vault folder, minus AI-refurbished files, posted media and media held for scheduled mass messages. */
export function poolFrom(media, skip) {
  return media
    .filter((m) => m.status === "ready" && m.mediaType === "image" && !isAiRefurbished(m) && !skip.has(m.uuid))
    .map((m) => ({
      uuid: m.uuid,
      nude: [...(m.tags?.tags ?? []), ...(m.tags?.nsfwCategory ?? [])].some((t) => t.toLowerCase() === "nudes"),
    }));
}

/** The photos the sell phase may use: ready images in the vault folders "free" and "ppv", minus the "AI Images" folder. */
export async function buildPool(api) {
  const [free, ppv, preview, ai, posted, scheduled] = await Promise.all([
    api.listFolderMedia("free"),
    api.listFolderMedia("ppv"),
    api.listFolderMedia("preview").catch(() => []),
    api.listFolderMedia("AI Images"),
    api.listPostedMedia(),
    api.listScheduledMassMedia(),
  ]);
  const skip = new Set([...ai.map((m) => m.uuid), ...posted, ...scheduled]);
  return { free: poolFrom(free, skip), ppv: poolFrom(ppv, skip), preview: poolFrom(preview, skip) };
}

/** A pack for one paid message: one random unseen free preview from "preview" plus `count` random unseen photos from "ppv". Null when too few are left. */
export function pickPack(pool, h, count, nude, random) {
  const unseen = (list) => list.filter((p) => !h.seen.has(p.uuid));
  const previews = unseen(pool.preview ?? []);
  let rest = unseen(pool.ppv);
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
  const h = { seen: new Set(), offeredBefore: new Set(), freePhotos: 0, paidPhotos: 0, bought: 0, lastFreeAt: null, lastPaidAt: null, openPaid: false };
  for (const m of messages) {
    if (m.sender.uuid === fanUuid || !m.mediaUuids?.length) continue;
    const at = Date.parse(m.sentAt) || 0;
    const recent = now - at < rules.openPpvDays * DAY_MS;
    const oneToOne = m.type === "SINGLE_RECIPIENT";
    if (m.pricing) {
      if (oneToOne) {
        h.paidPhotos++;
        h.lastPaidAt = Math.max(h.lastPaidAt ?? 0, at);
      }
      if (m.purchasedAt) {
        h.bought++;
        m.mediaUuids.forEach((u) => h.seen.add(u));
      } else {
        if (oneToOne && recent) h.openPaid = true;
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
export function photoRefusal(kind, h, now, priceUsd, rules) {
  if (kind === "free") {
    if (h.lastFreeAt && now - h.lastFreeAt < rules.freePhotoDays * DAY_MS)
      return `He got a free photo in the last ${rules.freePhotoDays} days. No new one yet.`;
    return null;
  }
  if (!Number.isInteger(priceUsd) || priceUsd < rules.minPriceUsd || priceUsd > rules.maxPriceUsd)
    return `Choose a whole-dollar price from ${rules.minPriceUsd} to ${rules.maxPriceUsd}.`;
  if (h.openPaid) return `He has a paid photo from the last ${rules.openPpvDays} days that he has not opened. No new one: you may tease about that one instead.`;
  if (h.lastPaidAt && now - h.lastPaidAt < rules.paidPhotoHours * 3600_000) return `He got a paid photo in the last ${rules.paidPhotoHours} hours. No new one yet.`;
  return null;
}

/** A random photo he has not seen. A paid photo he never opened may be offered again as a paid one. */
export function pickPhoto(pool, kind, h, nude, random) {
  const candidates = (kind === "free" ? pool.free : pool.ppv).filter(
    (p) => !h.seen.has(p.uuid) && (kind === "paid" || !h.offeredBefore.has(p.uuid)),
  );
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
    `Photos in this chat: ${h.freePhotos} free (last ${day(h.lastFreeAt)}), ${h.paidPhotos} paid (last ${day(h.lastPaidAt)}), ${h.bought} bought, ${h.openPaid ? `one paid photo from the last ${rules.openPpvDays} days still unopened` : `no unopened paid photo from the last ${rules.openPpvDays} days`}`,
    rules.priceGuide,
  ].join("\n");
}
