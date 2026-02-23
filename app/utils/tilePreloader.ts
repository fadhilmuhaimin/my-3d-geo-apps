    /**
     * tilePreloader.ts
     *
     * Recursively walks a 3D Tiles tileset tree (including sub-tileset .json references),
     * collects every .b3dm URL, and pre-fetches them into an in-memory ArrayBuffer cache.
     *
     * The cache is passed to Deck.gl's Tile3DLayer via loadOptions.fetch, so every tile
     * is served instantly from memory — eliminating network latency and preventing eviction.
     */

    interface TilesetNode {
        content?: { uri: string };
        children?: TilesetNode[];
    }

    interface TilesetDocument {
        root: TilesetNode;
    }

    export type TileCache = Map<string, ArrayBuffer>;

    export interface TilePreloadProgress {
        loaded: number;
        total: number;
        percentage: number;
    }

    /**
     * Recursively fetches and walks tileset JSON files, collecting all .b3dm URLs.
     * Handles any depth of sub-tileset nesting.
     */
    async function collectAllB3dmUrls(
        jsonUrl: string,
        visited: Set<string> = new Set()
    ): Promise<string[]> {
        // Guard against circular references or duplicate traversal
        const normalizedUrl = new URL(jsonUrl).href;
        if (visited.has(normalizedUrl)) return [];
        visited.add(normalizedUrl);

        let doc: TilesetDocument;
        try {
            const res = await fetch(jsonUrl);
            if (!res.ok) return [];
            doc = await res.json();
        } catch {
            console.warn('[TilePreloader] Could not fetch tileset JSON:', jsonUrl);
            return [];
        }

        const baseUrl = normalizedUrl.substring(0, normalizedUrl.lastIndexOf('/'));
        const b3dmUrls: string[] = [];
        const subJsonUrls: string[] = [];

        function walk(node: TilesetNode): void {
            if (!node) return;

            if (node.content?.uri) {
                const uri = node.content.uri;
                // Skip absolute URLs from external sources
                if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
                    const fullUrl = `${baseUrl}/${uri}`;
                    if (uri.endsWith('.b3dm')) {
                        b3dmUrls.push(fullUrl);
                    } else if (uri.endsWith('.json')) {
                        subJsonUrls.push(fullUrl);
                    }
                }
            }

            node.children?.forEach(walk);
        }

        walk(doc.root);

        // Recursively process sub-tilesets (these are loaded serially to avoid
        // hammering the server with too many JSON fetches simultaneously)
        for (const subUrl of subJsonUrls) {
            const subB3dms = await collectAllB3dmUrls(subUrl, visited);
            b3dmUrls.push(...subB3dms);
        }

        return b3dmUrls;
    }

    /**
     * Pre-fetches all .b3dm tiles referenced by the given tileset URL into an
     * in-memory ArrayBuffer cache.
     *
     * @param tilesetUrl   - URL to the root tileset.json
     * @param onProgress   - Called after every completed fetch (success or failure)
     * @param concurrency  - Number of parallel b3dm fetches (default: 12)
     * @returns            - Map from normalized URL → ArrayBuffer
     */
    export async function preloadAllTiles(
        tilesetUrl: string,
        onProgress: (progress: TilePreloadProgress) => void,
        concurrency = 12
    ): Promise<TileCache> {
        const cache: TileCache = new Map();

        let allUrls: string[];
        try {
            const rawUrls = await collectAllB3dmUrls(tilesetUrl);
            // Deduplicate and normalize
            allUrls = [...new Set(rawUrls.map(u => new URL(u).href))];
        } catch (err) {
            console.error('[TilePreloader] Failed to collect tile URLs:', err);
            onProgress({ loaded: 0, total: 0, percentage: 100 });
            return cache;
        }

        const total = allUrls.length;
        let loaded = 0;

        if (total === 0) {
            onProgress({ loaded: 0, total: 0, percentage: 100 });
            return cache;
        }

        console.log(`[TilePreloader] Starting pre-load of ${total} tiles…`);

        // Process in batches to control concurrency and avoid browser connection limits
        for (let i = 0; i < allUrls.length; i += concurrency) {
            const batch = allUrls.slice(i, i + concurrency);

            await Promise.allSettled(
                batch.map(async (url) => {
                    try {
                        const res = await fetch(url);
                        if (res.ok) {
                            const buffer = await res.arrayBuffer();
                            cache.set(url, buffer);
                        } else {
                            console.warn(`[TilePreloader] HTTP ${res.status} for: ${url}`);
                        }
                    } catch (err) {
                        console.warn('[TilePreloader] Fetch failed for:', url, err);
                    } finally {
                        loaded++;
                        onProgress({
                            loaded,
                            total,
                            percentage: Math.round((loaded / total) * 100),
                        });
                    }
                })
            );
        }

        console.log(`[TilePreloader] Done. ${cache.size}/${total} tiles cached in memory.`);
        return cache;
    }

    /**
     * Returns a custom fetch function for Deck.gl's loadOptions that serves
     * tiles from the pre-populated in-memory cache, falling back to a live
     * network request for any cache miss.
     */
    export function createCachedFetch(
        cache: TileCache
    ): (url: string, options?: RequestInit) => Promise<Response> {
        return async (url: string, options?: RequestInit): Promise<Response> => {
            const normalized = (() => {
                try { return new URL(url).href; }
                catch { return url; }
            })();

            const cached = cache.get(normalized);
            if (cached) {
                return new Response(cached, {
                    status: 200,
                    headers: { 'Content-Type': 'application/octet-stream' },
                });
            }

            // Cache miss — forward to the network (handles tileset.json, sub-JSON, etc.)
            return fetch(url, options);
        };
    }
