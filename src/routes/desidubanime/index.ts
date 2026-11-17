import { Hono } from "hono";
import * as cheerio from "cheerio";
import { cache } from "../../config/cache.js";
import { log } from "../../config/logger.js";
import type { ServerContext } from "../../config/context.js";

const desidubanimeRouter = new Hono<ServerContext>();

const BASE_URL = "https://www.desidubanime.me";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchHtml(url: string): Promise<string> {
    // 🎯 FIX: Removed encodeURI() here to prevent double-encoding of already-encoded URLs
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
        const error = new Error(`Failed to fetch ${url} (Status: ${response.status})`);
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

// ... (HOME route একই থাকবে, কোনো পরিবর্তন নেই)

// ========== SEARCH ==========
desidubanimeRouter.get("/search/:query", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const query = c.req.param("query");

    try {
        const data = await cache.getOrSet(async () => {
            // 🎯 FIX: encodeURIComponent is correct here, fetchHtml won't double-encode anymore
            const searchUrl = `${BASE_URL}/wp-json/kiranime/v1/anime/search?query=${encodeURIComponent(query)}`;
            const raw = await fetchHtml(searchUrl);
            
            let htmlFragment = "";
            try {
                const parsed = JSON.parse(raw);
                htmlFragment = parsed?.result || "";
            } catch {
                htmlFragment = raw;
            }

            const $ = cheerio.load(htmlFragment);
            const results: any[] = [];

            $("a[href*='/anime/']").each((_, link) => {
                const href = $(link).attr("href") || "";
                const slugMatch = href.match(/\/anime\/([^/]+)\//);
                if (!slugMatch) return;

                const slug = slugMatch[1];
                if (!slug) return;

                if (results.find((r) => r.id === slug)) return;

                const img = $(link).find("img").first();
                const poster = img.attr("src") || img.attr("data-src") || "";
                const title =
                    $(link).find("h3 span").first().text().trim() ||
                    img.attr("alt") ||
                    slug;

                let type = "TV";
                $(link).find("span").each((_, el) => {
                    const t = $(el).text().trim();
                    if (["TV", "MOVIE", "OVA", "ONA", "SPECIAL"].includes(t)) {
                        type = t;
                        return false;
                    }
                });

                results.push({ id: slug, title, poster, type, url: href });
            });

            return { results, query, totalFound: results.length };
        }, cacheConfig.key, cacheConfig.duration);

        return c.json({ provider: "Desidubanime", status: 200, data });
    } catch (e: any) {
        log.error(`Error in Desidubanime search: ${e.message}`);
        const status = e.status || 500;
        return c.json({ provider: "Desidubanime", status, message: e.message }, status);
    }
});

// ========== ANIME INFO ==========
desidubanimeRouter.get("/anime/:id", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const id = c.req.param("id"); 

    const data = await cache.getOrSet(async () => {
        // 🎯 FIX: Encode only the ID part to handle unicode
        const url = `${BASE_URL}/anime/${encodeURI(id)}/`;
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
            $(".entry-content img").first().attr("src") || "";

        const epMap = new Map<number, any>();
        
        $("a[href*='/watch/']").each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            
            const match = href.match(/(?:-episode-|\/episode-)(\d+)\/?$/i);
            if (!match) return;
            
            const num = parseInt(match[1], 10);
            const epSlug = href.split("/watch/")[1]?.replace(/\/$/, "");
            
            if (epSlug && !epMap.has(num)) {
                epMap.set(num, { number: num, title: `Episode ${num}`, url: href, id: epSlug });
            }
        });

        if (epMap.size === 0) {
            const watchLink = $(`a[href*='/watch/']`).first().attr("href");
            if (watchLink) {
                const slug = watchLink.split("/watch/")[1]?.replace(/\/$/, "");
                if (slug) epMap.set(1, { number: 1, title: "Full Movie", url: watchLink, id: slug });
            }
        }

        const episodes = Array.from(epMap.values()).sort((a, b) => a.number - b.number);
        return { id, realBaseName: id, title, description, poster, episodes };
    }, cacheConfig.key, cacheConfig.duration);

    return c.json({ provider: "Desidubanime", status: 200, data });
});

// ========== WATCH ==========
desidubanimeRouter.get("/watch/:id", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const id = c.req.param("id");

    try {
        const data = await cache.getOrSet(async () => {
            // 🎯 FIX: Encode only the ID part to handle unicode (e.g. ½ -> %C2%BD)
            const url = `${BASE_URL}/watch/${encodeURI(id)}/`;
            log.info(`Fetching watch page: ${url}`);

            const html = await fetchHtml(url);
            const $ = cheerio.load(html);

            let title = $("h1").first().text().trim();
            if (!title) {
                title = $("title").text().replace(" - Desi Dub Anime", "").trim();
            }

            const sources: any[] = [];
            const seen = new Set<string>();

            $("[data-embed-id]").each((_, el) => {
                const raw = $(el).attr("data-embed-id");
                if (!raw || seen.has(raw)) return;
                seen.add(raw);
                const decoded = decodeEmbedId(raw);
                if (decoded && decoded.url) {
                    sources.push({ server: decoded.server, url: decoded.url, type: "embed", referer: BASE_URL });
                }
            });

            if (sources.length === 0) {
                $("iframe").each((_, iframe) => {
                    const src = $(iframe).attr("src");
                    if (src && !src.includes("google") && !src.includes("disqus")) {
                        sources.push({ server: "Iframe", url: src, type: "embed", referer: BASE_URL });
                    }
                });
            }

            return { id, title, sources };
        }, cacheConfig.key, cacheConfig.duration);

        return c.json({ provider: "Desidubanime", status: 200, data });
    } catch (e: any) {
        log.error(`Error in Desidubanime watch handler: ${e.message}`);
        const status = e.status || 500;
        return c.json({ provider: "Desidubanime", status, message: e.message }, status);
    }
});

export { desidubanimeRouter };
