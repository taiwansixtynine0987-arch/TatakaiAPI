import { Hono } from "hono";
import * as cheerio from "cheerio";
import { cache } from "../../config/cache.js";
import { log } from "../../config/logger.js";
import type { ServerContext } from "../../config/context.js";

const desidubanimeRouter = new Hono<ServerContext>();

const BASE_URL = "https://www.desidubanime.me";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchHtml(url: string): Promise<string> {
    log.info(`Fetching: ${url}`);
    const response = await fetch(url, {
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Referer": BASE_URL,
        },
    });
    if (!response.ok) {
        log.error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        const error = new Error(`Failed to fetch ${url}`);
        (error as any).status = response.status;
        throw error;
    }
    return response.text();
}

// Decode "base64(serverName):base64(embedUrl)" format
function decodeEmbedId(raw: string): { server: string; url: string } | null {
    try {
        const [nameB64, urlB64] = raw.split(":");
        if (!nameB64 || !urlB64) return null;
        const server = Buffer.from(nameB64, "base64").toString("utf-8");
        const url = Buffer.from(urlB64, "base64").toString("utf-8");
        return { server, url };
    } catch (e: any) {
        log.warn(`Failed to decode embed-id: ${raw} — ${e.message}`);
        return null;
    }
}

// ========== HOME ==========
// (unchanged — keep as-is from your existing code)
desidubanimeRouter.get("/home", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const data = await cache.getOrSet(async () => {
        const html = await fetchHtml(BASE_URL);
        const $ = cheerio.load(html);

        const spotlight: any[] = [];
        const trending: any[] = [];
        const latest: any[] = [];

        $(".swiper-slide").each((_, slide) => {
            const title = $(slide).find("h2 span[data-nt-title], h2 span[data-en-title]").first().text().trim();
            const description = $(slide).find(".text-\\[13px\\].line-clamp-2").text().trim();
            const poster = $(slide).find("img").attr("data-src") || $(slide).find("img").attr("src");
            const link = $(slide).find("a[href*='/anime/']").attr("href");
            const id = link?.split("/anime/")[1]?.replace(/\/$/, "");

            if (title && id) {
                spotlight.push({ id, title, description, poster, url: link, isDub: true });
            }
        });

        $(".swiper-trending .swiper-slide").each((_, slide) => {
            const title = $(slide).find("span[data-nt-title], span[data-en-title]").first().text().trim();
            const poster = $(slide).find("img").attr("data-src") || $(slide).find("img").attr("src");
            const link = $(slide).find("a").attr("href");
            const id = link?.split("/anime/")[1]?.replace(/\/$/, "");
            const rank = $(slide).find("span.absolute").text().trim();

            if (title && id) {
                trending.push({ id, title, poster, url: link, rank: parseInt(rank) || undefined });
            }
        });

        $("section").each((_, section) => {
            const sectionTitle = $(section).find("h2").text().trim();
            if (sectionTitle.includes("Trending") || sectionTitle.includes("Spotlight")) return;

            const items: any[] = [];
            $(section).find("li.odd\\:bg-tertiary, .grid div").each((_, item) => {
                const link = $(item).find("a").attr("href");
                const title = $(item).find("h3, .dynamic-name").text().trim();
                const poster = $(item).find("img").attr("data-src") || $(item).find("img").attr("src");
                const id = link?.split("/anime/")[1]?.replace(/\/$/, "");
                const ep = $(item).find("span:contains('E ')").text().trim().replace("E ", "");

                if (title && id) {
                    items.push({ id, title, poster, url: link, latestEpisode: ep ? parseInt(ep) : undefined });
                }
            });

            if (items.length > 0) {
                latest.push({ title: sectionTitle, items });
            }
        });

        return { spotlight, trending, latest };
    }, cacheConfig.key, cacheConfig.duration);

    return c.json({ provider: "Desidubanime", status: 200, data });
});

// ========== SEARCH ==========
// (unchanged)
desidubanimeRouter.get("/search/:query", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const query = c.req.param("query");
    const page = c.req.query("page") || "1";

    const data = await cache.getOrSet(async () => {
        const searchUrl = `${BASE_URL}/page/${page}/?s=${encodeURIComponent(query)}`;
        const html = await fetchHtml(searchUrl);
        const $ = cheerio.load(html);

        const results: any[] = [];

        $("div#archive-content article").each((_, article) => {
            const title = $(article).find("h3, .entry-title").text().trim();
            const link = $(article).find("a").attr("href");
            const poster = $(article).find("img").attr("src") || $(article).find("img").attr("data-src");
            const id = link?.split("/anime/")[1]?.replace(/\/$/, "");

            if (title && link) {
                const finalId = id || link.split("/").filter(Boolean).pop();
                results.push({ id: finalId, title, poster, url: link });
            }
        });

        return { results, page: parseInt(page), hasNextPage: $(".pagination .next").length > 0 };
    }, cacheConfig.key, cacheConfig.duration);

    return c.json({ provider: "Desidubanime", status: 200, data });
});

// ========== ANIME INFO (FIXED) ==========
desidubanimeRouter.get("/anime/:id", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const id = c.req.param("id");

    const data = await cache.getOrSet(async () => {
        const url = `${BASE_URL}/anime/${id}/`;
        const html = await fetchHtml(url);
        const $ = cheerio.load(html);

        const title =
            $("h1.entry-title").text().trim() ||
            $("meta[property='og:title']").attr("content")?.trim() ||
            id;

        const description =
            $("meta[name='description']").attr("content")?.trim() ||
            $(".entry-content p").first().text().trim();

        const poster =
            $("meta[property='og:image']").attr("content") ||
            $(".entry-content img").first().attr("src") ||
            "";

        // Extract all episode links matching /watch/{id}-episode-N/
        const epMap = new Map<number, any>();
        $(`a[href*='/watch/${id}-episode-']`).each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            const match = href.match(/episode-(\d+)/);
            if (!match) return;
            const num = parseInt(match[1]);
            const epSlug = href.split("/watch/")[1]?.replace(/\/$/, "");
            if (!epMap.has(num)) {
                epMap.set(num, {
                    number: num,
                    title: `Episode ${num}`,
                    url: href,
                    id: epSlug,
                });
            }
        });

        const episodes = Array.from(epMap.values()).sort((a, b) => a.number - b.number);

        return { id, title, description, poster, episodes };
    }, cacheConfig.key, cacheConfig.duration);

    return c.json({ provider: "Desidubanime", status: 200, data });
});

// ========== WATCH (FIXED) ==========
desidubanimeRouter.get("/watch/:id", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const id = c.req.param("id");

    try {
        const data = await cache.getOrSet(async () => {
            const url = `${BASE_URL}/watch/${id}/`;
            log.info(`Fetching watch page: ${url}`);

            const html = await fetchHtml(url);
            const $ = cheerio.load(html);

            let title = $("h1").first().text().trim();
            if (!title) {
                title = $("title").text().replace(" - Desi Dub Anime", "").trim();
            }

            // Parse data-embed-id attributes → base64 decode
            const sources: any[] = [];
            const seen = new Set<string>();

            $("[data-embed-id]").each((_, el) => {
                const raw = $(el).attr("data-embed-id");
                if (!raw || seen.has(raw)) return;
                seen.add(raw);
                const decoded = decodeEmbedId(raw);
                if (decoded && decoded.url) {
                    sources.push({
                        server: decoded.server,
                        url: decoded.url,
                        type: "embed",
                        referer: BASE_URL,
                    });
                }
            });

            // Fallback: direct iframes (in case site structure changes again)
            if (sources.length === 0) {
                log.debug("No data-embed-id found, falling back to iframes");
                $("iframe").each((_, iframe) => {
                    const src = $(iframe).attr("src");
                    if (src && !src.includes("google") && !src.includes("disqus")) {
                        sources.push({
                            server: "Iframe",
                            url: src,
                            type: "embed",
                            referer: BASE_URL,
                        });
                    }
                });
            }

            return { id, title, sources };
        }, cacheConfig.key, cacheConfig.duration);

        return c.json({ provider: "Desidubanime", status: 200, data });
    } catch (e: any) {
        log.error(`Error in Desidubanime watch handler: ${e.message}`);
        const status = e.status || 500;
        return c.json(
            { provider: "Desidubanime", status, message: e.message || "Internal Server Error" },
            status
        );
    }
});

export { desidubanimeRouter };
