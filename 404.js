(() => {
  const API_MAP_URL = "https://api.buk1t.com/json/buk1t.json";
  const DEFAULT_DOMAIN = "buk1t.com";
  const DEFAULT_ROOT_SUBDOMAIN = "www";

  // When the JSON can't load, still provide something useful.
  const FALLBACK = [
    {
      name: "Home",
      subdomain: "www",
      page: "/",
      keywords: ["home", "main", "start", "buk1t"],
      _kind: "service",
      _serviceName: "Home",
      _serviceId: "www"
    }
  ];

  const $ = (id) => document.getElementById(id);

  const tokenize = (s) =>
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean);

  const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

  /* -----------------------------
     Debug toggle: show only if ?debug=1
  ------------------------------ */
  function debugEnabled() {
    const q = new URLSearchParams(location.search);
    return q.get("debug") === "1";
  }

  /* -----------------------------
     Helper 1: original URL (?from)
  ------------------------------ */
  function getOriginalUrl() {
    const from = new URLSearchParams(location.search).get("from");
    if (!from) return null;
    try {
      return new URL(decodeURIComponent(from));
    } catch {
      return null;
    }
  }

  /* -----------------------------
     Helper 2: tokens from URL
  ------------------------------ */
  function getQueryTokens() {
    const original = getOriginalUrl();
    const url = original || new URL(location.href);

    const hostParts = url.hostname.split(".");
    const subdomain = hostParts.length > 2 ? hostParts[0] : "";
    const pathParts = url.pathname.split("/").filter(Boolean);

    return uniq([...tokenize(subdomain), ...pathParts.flatMap(tokenize)]);
  }

  /* -----------------------------
     Folder normalization
  ------------------------------ */
  function normalizeLikelyFolderPath(path) {
    const p = String(path || "/").trim() || "/";
    if (p === "/") return "/";
    if (p.endsWith("/")) return p;

    const last = p.split("/").pop() || "";
    const looksLikeFile = last.includes(".");
    return looksLikeFile ? p : p + "/";
  }

  function normalizeLikelyFolderUrl(raw) {
    try {
      const u = new URL(raw);
      u.pathname = normalizeLikelyFolderPath(u.pathname);
      return u.toString();
    } catch {
      return raw;
    }
  }

  /* -----------------------------
     Levenshtein distance (small strings)
  ------------------------------ */
  function levenshtein(a, b) {
    a = String(a || "");
    b = String(b || "");
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;

    const m = a.length;
    const n = b.length;

    // dp row
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);

    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(
          prev[j] + 1, // deletion
          cur[j - 1] + 1, // insertion
          prev[j - 1] + cost // substitution
        );
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  function fuzzyBonus(token, word) {
    // Returns points for "close enough" typos.
    // Tuned for short tokens common in routes/subdomains.
    const t = String(token || "");
    const w = String(word || "");
    if (!t || !w) return 0;

    if (t === w) return 10;

    // Quick bail for wildly different lengths
    const dl = Math.abs(t.length - w.length);
    if (dl >= 4) return 0;

    const d = levenshtein(t, w);
    const maxLen = Math.max(t.length, w.length);

    // Accept distance up to ~30% of length (capped)
    const ok = d <= Math.min(3, Math.floor(maxLen * 0.34));
    if (!ok) return 0;

    // Stronger bonus for closer matches
    if (d === 1) return 6;
    if (d === 2) return 4;
    if (d === 3) return 2;
    return 0;
  }

  /* -----------------------------
     Normalize sitemap item into:
     { name, subdomain, page, keywords, _kind, _serviceId, _serviceName }
  ------------------------------ */
  function normalizeItem(it, rootSub) {
    const sub = String(it.subdomain ?? rootSub ?? DEFAULT_ROOT_SUBDOMAIN)
      .trim()
      .toLowerCase();

    let page = String(it.page ?? "/").trim();
    if (!page.startsWith("/")) page = "/" + page;
    page = normalizeLikelyFolderPath(page);

    const name = String(it.name ?? it.label ?? it.key ?? "untitled").trim();

    const keywords = Array.isArray(it.keywords)
      ? it.keywords
      : Array.isArray(it.tags)
        ? it.tags
        : [];

    // Preserve metadata for smart labels/boosting
    return {
      name,
      subdomain: sub,
      page,
      keywords: keywords.map((k) => String(k).toLowerCase()),
      _kind: it._kind || null, // "service" | "page" | null
      _serviceId: it._serviceId || null,
      _serviceName: it._serviceName || null
    };
  }

  function makeUrl(domain, it) {
    return `https://${it.subdomain}.${domain}${it.page}`;
  }

  function makeBtn(url, label) {
    const a = document.createElement("a");
    a.className = "btn";
    a.href = normalizeLikelyFolderUrl(url);
    a.textContent = label;
    return a;
  }

  /* -----------------------------
     NEW FORMAT SUPPORT
  ------------------------------ */
  function pickKeywordsFromNew(it) {
    const out = [];

    if (Array.isArray(it.keywords)) out.push(...it.keywords);
    if (Array.isArray(it.tags)) out.push(...it.tags);

    if (it.card) {
      if (Array.isArray(it.card.pill_tags)) out.push(...it.card.pill_tags);
      if (typeof it.card.title === "string") out.push(it.card.title);
      if (typeof it.card.desc === "string") out.push(it.card.desc);
      if (typeof it.card.glyph === "string") out.push(it.card.glyph);
    }

    if (typeof it.id === "string") out.push(it.id);
    if (typeof it.name === "string") out.push(it.name);
    if (typeof it.subdomain === "string") out.push(it.subdomain);

    return uniq(out.map((x) => String(x).toLowerCase()));
  }

  function itemsFromNewFormat(data, rootSub) {
    const services = Array.isArray(data.services) ? data.services : [];
    const pages = Array.isArray(data.pages) ? data.pages : [];

    const svcById = new Map(
      services
        .filter((s) => s && (s.id || s.subdomain))
        .map((s) => [String(s.id || s.subdomain).toLowerCase(), s])
    );

    const items = [];

    // services => root entries
    for (const s of services) {
      if (!s) continue;

      const subdomain = String(s.subdomain || rootSub || DEFAULT_ROOT_SUBDOMAIN)
        .trim()
        .toLowerCase();

      const serviceName = String(s.name || s.id || subdomain || "untitled").trim();
      const serviceId = String(s.id || subdomain).trim().toLowerCase();

      items.push(
        normalizeItem(
          {
            name: serviceName,
            subdomain,
            page: "/",
            keywords: pickKeywordsFromNew(s),
            _kind: "service",
            _serviceId: serviceId,
            _serviceName: serviceName
          },
          rootSub
        )
      );
    }

    // pages => service subdomain + path
    for (const p of pages) {
      if (!p) continue;

      const svcKey = String(p.service || "").toLowerCase();
      const svc = svcById.get(svcKey);

      const subdomain = String(p.subdomain || (svc && svc.subdomain) || rootSub || DEFAULT_ROOT_SUBDOMAIN)
        .trim()
        .toLowerCase();

      const serviceName = String((svc && svc.name) || p.service || subdomain).trim();
      const serviceId = String((svc && svc.id) || p.service || subdomain).trim().toLowerCase();

      const page = String(p.path || p.page || "/").trim();
      const name = String(p.name || p.id || "untitled").trim();

      // Add service name into keywords so "labs soundscapes" hits hard
      const kws = uniq([...pickKeywordsFromNew(p), ...tokenize(serviceName)]);

      items.push(
        normalizeItem(
          {
            name,
            subdomain,
            page,
            keywords: kws,
            _kind: "page",
            _serviceId: serviceId,
            _serviceName: serviceName
          },
          rootSub
        )
      );
    }

    return items;
  }

  async function loadMap() {
    const res = await fetch(API_MAP_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("map fetch failed");

    const data = await res.json();

    const domain = String(data.domain || DEFAULT_DOMAIN).trim();
    const rootSub = String(data.root_subdomain || DEFAULT_ROOT_SUBDOMAIN)
      .trim()
      .toLowerCase();

    let items = [];

    // Backwards compatibility
    if (Array.isArray(data.items)) {
      items = data.items.map((it) => normalizeItem(it, rootSub));
    } else {
      items = itemsFromNewFormat(data, rootSub);
    }

    return { domain, rootSub, items };
  }

  /* -----------------------------
     Smart label: "Labs → Soundscapes"
  ------------------------------ */
  function displayLabel(it) {
    const service = String(it._serviceName || "").trim();
    const isPage = it._kind === "page" && it.page !== "/";
    if (isPage && service) return `${service} → ${it.name}`;
    return it.name;
  }

  /* -----------------------------
     Wildcard / unknown subdomain detection
  ------------------------------ */
  function extractAttempt(url) {
    const hostParts = url.hostname.split(".");
    const subdomain = hostParts.length > 2 ? hostParts[0] : "";
    const path = normalizeLikelyFolderPath(url.pathname || "/");
    return { subdomain: String(subdomain || "").toLowerCase(), path };
  }

  function getKnownServices(items) {
    const services = items
      .filter((it) => it && it._kind === "service")
      .map((it) => ({
        subdomain: it.subdomain,
        name: it._serviceName || it.name || it.subdomain
      }));

    // uniq by subdomain
    const seen = new Set();
    return services.filter((s) => {
      if (!s.subdomain) return false;
      if (seen.has(s.subdomain)) return false;
      seen.add(s.subdomain);
      return true;
    });
  }

  function closestServiceSubdomain(unknownSub, knownServices) {
    if (!unknownSub) return null;
    let best = null;
    let bestD = Infinity;

    for (const s of knownServices) {
      const d = levenshtein(unknownSub, s.subdomain);
      if (d < bestD) {
        bestD = d;
        best = s.subdomain;
      }
    }

    // Only treat it as "closest" if it's plausibly a typo
    const ok = best && bestD <= Math.min(3, Math.floor(Math.max(unknownSub.length, best.length) * 0.34));
    return ok ? best : null;
  }

  /* -----------------------------
     Scoring (genius mode)
  ------------------------------ */
  function score(tokens, it, ctx) {
    const { currentSub, attemptSub, attemptPath, knownServices, closestService } = ctx;

    const hay = uniq([
      ...tokenize(it.name),
      ...tokenize(it.subdomain),
      ...tokenize(it.page),
      ...(it.keywords || []).flatMap(tokenize),
      ...(it._serviceName ? tokenize(it._serviceName) : [])
    ]);

    let s = 0;

    // Token matching + fuzzy matching
    for (const t of tokens) {
      for (const h of hay) {
        if (t === h) s += 8;
        else if (h.includes(t) || t.includes(h)) s += 3;
        else if (t[0] && h[0] && t[0] === h[0]) s += 1;

        // typo tolerance
        s += fuzzyBonus(t, h);
      }
    }

    // Boost if the (attempted) subdomain matches the item’s subdomain
    if (attemptSub && attemptSub === it.subdomain) s += 5;

    // Boost if currentSub matches item subdomain (helps when 404 is hosted on same subdomain)
    if (currentSub && currentSub === it.subdomain) s += 2;

    // If user tried an unknown subdomain, boost items in the closest known service
    if (closestService && it.subdomain === closestService) s += 4;

    // Service-level boost: if tokens indicate the service, make the service root ("/") rise
    if (it._kind === "service" && it.page === "/") {
      for (const t of tokens) {
        if (t === it.subdomain) s += 6;
        if (it._serviceName) s += fuzzyBonus(t, String(it._serviceName).toLowerCase());
        s += fuzzyBonus(t, it.subdomain);
      }
    }

    // If the attempted path matches an item page, big boost
    if (attemptPath && it.page) {
      if (attemptPath === it.page) s += 10;

      // If they hit "/soundscapes" but it’s missing slash, your normalization fixes it.
      // Also boost partial path matches.
      const ap = attemptPath.replace(/\/+$/g, "");
      const ip = String(it.page).replace(/\/+$/g, "");
      if (ap && ip && (ap === ip || ip.endsWith(ap) || ap.endsWith(ip))) s += 6;
    }

    // Wildcard mistake pattern:
    // e.g. soundscapes.buk1t.com (subdomain is actually a page name)
    // If attemptSub equals a page-ish token, boost pages whose name/page keywords match it.
    if (attemptSub && it._kind === "page") {
      const bonus = Math.max(
        fuzzyBonus(attemptSub, String(it.name).toLowerCase()),
        fuzzyBonus(attemptSub, String(it.page).replace(/\//g, "")),
        ...((it.keywords || []).map((k) => fuzzyBonus(attemptSub, String(k).toLowerCase())))
      );
      if (bonus > 0) s += bonus + 4; // extra push because this is a strong “wrong subdomain” signal
    }

    return s;
  }

  function render(tokens, domain, rootSub, items) {
    const summary = $("summary");
    const options = $("options");
    const debug = $("debug");
    const tried = $("tried");

    if (!options || !summary) return;

    const original = getOriginalUrl();
    const attemptedUrl = original || new URL(location.href);

    const attempt = extractAttempt(attemptedUrl);
    const attemptSub = attempt.subdomain;
    const attemptPath = attempt.path;

    const currentSub = original
      ? (original.hostname.split(".")[0] || "")
      : (location.hostname.split(".")[0] || "");
    const currentSubNorm = String(currentSub || "").toLowerCase();

    if (tried) {
      tried.textContent = original
        ? `You tried: ${original.hostname}${original.pathname}`
        : `You tried: ${location.hostname}${location.pathname}`;
    }

    const knownServices = getKnownServices(items);
    const closestService = !knownServices.some((s) => s.subdomain === attemptSub)
      ? closestServiceSubdomain(attemptSub, knownServices)
      : null;

    const ctx = {
      currentSub: currentSubNorm,
      attemptSub,
      attemptPath,
      knownServices,
      closestService
    };

    // Rank and choose
    const ranked = items
      .map((it) => ({ it, s: score(tokens, it, ctx) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 7);

    options.innerHTML = "";

    const best = ranked[0] && ranked[0].s > 0 ? ranked[0].it : null;

    summary.textContent = best
      ? `Did you mean “${displayLabel(best)}”?`
      : `Couldn’t find an exact match — here are some good places to go:`;

    const used = new Set();

    // Best guess
    if (best) {
      const u = makeUrl(domain, best);
      used.add(u);
      options.appendChild(makeBtn(u, `Best guess: ${displayLabel(best)}`));
    }

    // Other strong guesses
    for (const r of ranked) {
      if (r.s <= 0) continue;
      const u = makeUrl(domain, r.it);
      if (used.has(u)) continue;
      used.add(u);
      options.appendChild(makeBtn(u, displayLabel(r.it)));
    }

    // Always include only ONE exit: Home
    const home = normalizeItem(
      { name: "Home", subdomain: rootSub, page: "/", keywords: ["home", "main", "start"] },
      rootSub
    );
    const homeUrl = makeUrl(domain, home);
    if (!used.has(homeUrl)) options.appendChild(makeBtn(homeUrl, "Home"));

    // Debug (only if ?debug=1)
    if (debug) {
      if (debugEnabled()) {
        debug.style.display = "block";
        debug.textContent =
          `Tokens: ${tokens.join(", ") || "(none)"}\n` +
          `Original: ${original ? original.href : "none"}\n` +
          `Attempt subdomain: ${attemptSub || "(none)"}\n` +
          `Attempt path: ${attemptPath}\n` +
          `Closest service: ${closestService || "(none)"}\n` +
          `Domain: ${domain}\n` +
          `Root subdomain: ${rootSub}`;
      } else {
        debug.style.display = "none";
      }
    }
  }

  async function init() {
    const tokens = getQueryTokens();

    let domain = DEFAULT_DOMAIN;
    let rootSub = DEFAULT_ROOT_SUBDOMAIN;
    let items = FALLBACK.map((it) => normalizeItem(it, rootSub));

    try {
      const loaded = await loadMap();
      domain = loaded.domain;
      rootSub = loaded.rootSub;
      items = loaded.items;
    } catch {
      // fallback only
    }

    render(tokens, domain, rootSub, items);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();