import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import type maplibregl from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';

/*
 * ThreeDTilesLayer — MapLibre GL JS v5 custom layer for 3D Tiles
 * ══════════════════════════════════════════════════════════════════
 *
 * WHY STANDARD SSE LOGIC IS INSUFFICIENT
 * ───────────────────────────────────────
 * The 3d-tiles-renderer library computes Screen-Space Error (SSE) as:
 *
 *   SSE = tile.geometricError / (distance × sseDenominator)
 *
 * where distance is measured from the REGISTERED camera to the tile's
 * bounding volume.  If the visual camera (MapLibre) is zoomed out, distance
 * is large → SSE is small → traversal stops at coarse LODs.  This means
 * the user never sees full-detail tiles unless they zoom in.
 *
 * The reference system (CesiumJS) decouples *what to load* from *what to
 * draw*.  We replicate this with two cameras:
 *
 *   • lodCamera  — fixed 500 m above the tileset, registered with
 *     TilesRenderer.  Its permanent closeness keeps SSE artificially high
 *     so traversal descends to leaf tiles regardless of actual map zoom.
 *     A 90° FOV ensures the entire tileset fits inside the frustum.
 *
 *   • renderCamera — carries MapLibre's MVP × ECEF→Mercator matrix.  This
 *     is what the user actually sees.  Three.js renders with this camera,
 *     but TilesRenderer never knows about it.
 *
 * Additionally, we inflate the reported screen resolution by 4× via
 * setResolution(), which makes sseDenominator smaller and further amplifies
 * SSE, guaranteeing that even mid-depth tiles exceed errorTarget.
 *
 *
 * WHY Z-FIGHTING HAPPENS & HOW WE MITIGATE IT
 * ─────────────────────────────────────────────
 * When displayActiveTiles = true, BOTH parent tiles (coarse LOD) and their
 * children (fine LOD) can be in the scene simultaneously.  They occupy
 * nearly the same 3D space.  Their triangles interleave in depth, producing
 * a noisy/fragmented appearance — especially from side angles where thin
 * skirt geometry overlaps.
 *
 * Mitigations applied here:
 *   1. TilesFadePlugin — cross-fades parent opacity to 0 as children fade
 *      to 1, preventing both at full opacity simultaneously.
 *   2. polygonOffset(true, 1, 1) — biases each fragment's depth by a small
 *      slope-scaled amount, separating coplanar triangles.
 *   3. gl.clear(DEPTH_BUFFER_BIT) before render — gives 3D tiles a clean
 *      depth slate so MapLibre's raster depth doesn't interfere.
 *   4. FrontSide only — hides inward-facing skirt back-faces that would
 *      otherwise z-fight with outward-facing surfaces.
 *
 *
 * WHY FRAGMENTATION HAPPENS FROM SIDE ANGLES
 * ───────────────────────────────────────────
 * Photogrammetry tilesets (b3dm) are 2.5D surface meshes, not solid volumes.
 * Each tile has "skirt" geometry — thin vertical walls at tile boundaries
 * that fill gaps when viewed from above.  From the side, these skirts
 * become visible and overlap with adjacent tiles' skirts, creating a
 * shattered/layered appearance.  This is a fundamental limitation of 2.5D
 * photogrammetry data and cannot be fully eliminated — only reduced by:
 *   • Hiding back-faces (FrontSide)
 *   • Polygon offset to separate overlapping depth values
 *   • Vertex welding (mergeVertices) to close cracks at tile boundaries
 *
 *
 * WHERE TO PATCH 3D-TILES-RENDERER FOR FORCED TRAVERSAL (reference only)
 * ──────────────────────────────────────────────────────────────────────────
 * File: node_modules/3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js
 * Function: canTraverse() at line ~153
 *
 *   // ORIGINAL — stops traversal when SSE satisfies errorTarget:
 *   if ( tile.traversal.error <= renderer.errorTarget
 *        && ! canUnconditionallyRefine( tile ) ) {
 *       return false;
 *   }
 *
 *   // PATCHED — always traverse children (ignores SSE entirely):
 *   // WARNING: this forces ALL tiles to load, which can explode memory and
 *   // bandwidth for large tilesets.  Use maxDepth to cap depth instead.
 *   // if ( false && tile.traversal.error <= renderer.errorTarget ... ) {
 *   //     return false;
 *   // }
 *
 * In practice, the decoupled lodCamera approach achieves the same result
 * without modifying library source.  The patch above is documented for
 * cases where SSE bypass is truly needed (e.g., sparse tilesets where
 * geometricError metadata is incorrect).
 *
 *
 * REPLACE vs ADD REFINE MODE
 * ──────────────────────────
 * Photogrammetry tilesets use refine: "REPLACE" — each child fully replaces
 * its parent's geometry.  This is correct for textured meshes.  The
 * "ADD" mode is for point clouds and instanced features where children
 * provide additional geometry, not replacement geometry.
 *
 * With REPLACE + displayActiveTiles, the parent stays visible until ALL
 * children are ready, then the parent fades out.  This prevents holes.
 *
 *
 * PERFORMANCE / MEMORY IMPLICATIONS OF FORCING LEAF LOADING
 * ─────────────────────────────────────────────────────────
 * Forcing errorTarget = 0 loads the ENTIRE tileset to leaf detail.  For
 * a single-block photogrammetry tileset (tens to hundreds of tiles, a few
 * hundred MB) this is fine and matches CesiumJS behaviour.
 *
 * For city-scale tilesets (thousands of tiles, many GB), constrain with:
 *   • maxDepth — cap traversal depth (e.g., 10)
 *   • errorTarget > 0 — stop at "good enough" LOD
 *   • SELECTION_HEIGHT_M ↑ — move lodCamera further up so only central
 *     tiles get high SSE
 *   • downloadQueue.maxJobs ↓ — limit concurrent fetches
 *
 * Practical throttles already in place:
 *   • downloadQueue.maxJobs = 25 (library default)
 *   • parseQueue.maxJobs = 5 (library default; Draco decode is CPU-heavy)
 *   • LRU cache eviction (library default)
 */

// ══════════════════════════════════════════════════════════════════════════════
// TUNING CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════
//
// | Parameter              | Default | Lower →                | Higher →                |
// |------------------------|---------|------------------------|-------------------------|
// | SELECTION_HEIGHT_M     | 500     | More SSE, edge culling | Safer frustum, less SSE |
// | SELECTION_FOV_DEG      | 90      | Narrower frustum       | Wider coverage          |
// | RESOLUTION_MULTIPLIER  | 4       | Real resolution        | More refinement pressure|
// | FADE_DURATION_MS       | 500     | Snappier transitions   | Smoother cross-fade     |
// | MAX_FADE_OUT_TILES     | 100     | Less overdraw          | Smoother fading         |
// | REPAINT_INTERVAL_MS    | 50      | Higher CPU             | Choppier loading        |
// | POLYGON_OFFSET_FACTOR  | 1       | Less bias              | More z-fight reduction  |
// | POLYGON_OFFSET_UNITS   | 1       | Less bias              | More z-fight reduction  |
// | ENABLE_VERTEX_WELDING  | true    | Skip for speed         | Close cracks at seams   |
// | WELD_TOLERANCE         | 1e-4    | Tighter welds          | Looser welds            |

const SELECTION_HEIGHT_M     = 500;
const SELECTION_FOV_DEG      = 90;
const RESOLUTION_MULTIPLIER  = 4;
const FADE_DURATION_MS       = 500;
const MAX_FADE_OUT_TILES     = 100;
const REPAINT_INTERVAL_MS    = 50;
const POLYGON_OFFSET_FACTOR  = 1;
const POLYGON_OFFSET_UNITS   = 1;
const ENABLE_VERTEX_WELDING  = true;
const WELD_TOLERANCE         = 1e-4;

// ── Geo constants ────────────────────────────────────────────────────────────
const EARTH_CIRCUMFERENCE = 40_075_016.686;
const WGS84_A             = 6_378_137.0;
const WGS84_E2            = 0.006_694_379_990_14;

// ── Coordinate helpers ───────────────────────────────────────────────────────

function lngLatToECEF(
    lng: number, lat: number, alt = 0
): [number, number, number] {
    const λ    = (lng * Math.PI) / 180;
    const φ    = (lat * Math.PI) / 180;
    const sinφ = Math.sin(φ);
    const cosφ = Math.cos(φ);
    const N    = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinφ * sinφ);
    return [
        (N + alt) * cosφ * Math.cos(λ),
        (N + alt) * cosφ * Math.sin(λ),
        (N * (1 - WGS84_E2) + alt) * sinφ,
    ];
}

function buildEcefToMercatorMatrix(
    lng0: number,
    lat0: number,
    altitudeOffset = 0,
    worldSize = 1
): THREE.Matrix4 {
    const λ    = (lng0 * Math.PI) / 180;
    const φ    = (lat0 * Math.PI) / 180;
    const sinλ = Math.sin(λ), cosλ = Math.cos(λ);
    const sinφ = Math.sin(φ), cosφ = Math.cos(φ);

    const Ex = -sinλ,        Ey =  cosλ,        Ez = 0;
    const Nx = -sinφ * cosλ, Ny = -sinφ * sinλ, Nz = cosφ;
    const Ux =  cosφ * cosλ, Uy =  cosφ * sinλ, Uz = sinφ;

    const sH = worldSize / (EARTH_CIRCUMFERENCE * cosφ);
    const sV = worldSize / EARTH_CIRCUMFERENCE;

    const [Cx, Cy, Cz] = lngLatToECEF(lng0, lat0, 0);

    const mx0 = (lng0 + 180) / 360;
    const my0 =
        (1 - Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360)) / Math.PI) / 2;

    const tx =  mx0 * worldSize - sH * (Ex * Cx + Ey * Cy + Ez * Cz);
    const ty =  my0 * worldSize + sH * (Nx * Cx + Ny * Cy + Nz * Cz);
    const tz = -sV * (Ux * Cx + Uy * Cy + Uz * Cz) + altitudeOffset * sV;

    return new THREE.Matrix4().set(
         sH * Ex,  sH * Ey,  sH * Ez,  tx,
        -sH * Nx, -sH * Ny, -sH * Nz,  ty,
         sV * Ux,  sV * Uy,  sV * Uz,  tz,
         0,        0,        0,         1
    );
}

// ══════════════════════════════════════════════════════════════════════════════
// MESH POST-PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Process a loaded tile's scene graph:
 *
 * 1. Vertex welding (mergeVertices) — photogrammetry tiles are cut from a
 *    continuous surface.  Where the cut happens, vertices that SHOULD be
 *    shared are duplicated with slightly different positions.  This creates
 *    hairline cracks visible as dark lines.  mergeVertices snaps vertices
 *    within WELD_TOLERANCE to the same position and builds a shared index,
 *    closing these cracks.
 *
 * 2. Normal recomputation — after welding, normals are recomputed from the
 *    merged geometry so that shared vertices get averaged normals, producing
 *    a smoother surface instead of per-face flat shading.  This doesn't
 *    affect MeshBasicMaterial rendering (which ignores normals) but is
 *    stored in case materials are later changed for debugging.
 *
 * 3. Material replacement — creates an unlit MeshBasicMaterial with:
 *    • map/color preserved from the original material
 *    • FrontSide — hides skirt back-faces (see header comment)
 *    • polygonOffset — biases depth by (FACTOR, UNITS) to reduce z-fighting
 *      between overlapping parent/child tiles during LOD transitions
 *    • depthWrite = true — ensures this tile's fragments contribute to the
 *      depth buffer so subsequent tiles respect occlusion
 */
function processLoadedScene(root: THREE.Object3D): void {
    root.traverse((obj: any) => {
        if (!obj.isMesh) return;

        let geo = obj.geometry as THREE.BufferGeometry | undefined;
        if (!geo) return;

        // ── Step 1: Vertex welding ───────────────────────────────────────
        // mergeVertices returns a NEW geometry; the original is untouched.
        // On indexed geometry it deduplicates by attribute values within
        // tolerance.  On non-indexed geometry it creates an index.
        // Either way, coincident vertices at tile boundaries get merged,
        // closing hairline cracks.
        if (ENABLE_VERTEX_WELDING) {
            try {
                const merged = mergeVertices(geo, WELD_TOLERANCE);
                if (merged && merged !== geo) {
                    obj.geometry = merged;
                    geo = merged;
                }
            } catch {
                // mergeVertices can fail on unusual attribute layouts;
                // proceed with the original geometry.
            }
        }

        // ── Step 2: Normals ──────────────────────────────────────────────
        // Compute normals AFTER welding so shared vertices get averaged
        // face normals → smoother surface.  If normals already exist they
        // are overwritten with the welded version.
        try {
            geo.computeVertexNormals();
        } catch {
            // Non-critical; MeshBasicMaterial doesn't use normals.
        }

        // ── Step 3: Material replacement ─────────────────────────────────
        const src = obj.material;
        if (!src) return;

        obj.material = new THREE.MeshBasicMaterial({
            map:         src.map         ?? null,
            color:       src.color       ?? 0xffffff,
            transparent: src.transparent ?? false,
            side:        THREE.FrontSide,
            depthWrite:  true,
            depthTest:   true,

            // polygonOffset: pushes each fragment's depth value by
            //   offset = factor × DZ + units × minResolvable
            // where DZ is the maximum depth slope across the polygon.
            // A positive factor pushes fragments AWAY from the camera,
            // which means earlier-drawn (parent) tiles are pushed back and
            // later-drawn (child) tiles win the depth test.  This reduces
            // the noisy interleaving between parent and child geometry.
            polygonOffset:       true,
            polygonOffsetFactor: POLYGON_OFFSET_FACTOR,
            polygonOffsetUnits:  POLYGON_OFFSET_UNITS,
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYER CLASS
// ══════════════════════════════════════════════════════════════════════════════

export class ThreeDTilesLayer implements maplibregl.CustomLayerInterface {
    readonly id: string;
    readonly type          = 'custom' as const;
    readonly renderingMode = '3d'     as const;

    private readonly tilesetUrl:     string;
    private readonly lng0:           number;
    private readonly lat0:           number;
    private readonly altitudeOffset: number;

    private map:          maplibregl.Map          | null = null;
    private renderer:     THREE.WebGLRenderer     | null = null;
    private scene:        THREE.Scene             | null = null;

    private lodCamera:    THREE.PerspectiveCamera | null = null;
    private renderCamera: THREE.Camera            | null = null;

    private tilesRenderer: TilesRenderer | null = null;
    private dracoLoader:   DRACOLoader   | null = null;

    private repaintTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        id: string,
        tilesetUrl: string,
        lng0: number,
        lat0: number,
        altitudeOffset = 0
    ) {
        this.id             = id;
        this.tilesetUrl     = tilesetUrl;
        this.lng0           = lng0;
        this.lat0           = lat0;
        this.altitudeOffset = altitudeOffset;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private hasActiveWork(): boolean {
        if (!this.tilesRenderer) return false;
        const s = (this.tilesRenderer as any).stats;
        if (s && (s.downloading > 0 || s.parsing > 0 || s.queued > 0)) return true;
        const dq = (this.tilesRenderer as any).downloadQueue;
        const pq = (this.tilesRenderer as any).parseQueue;
        if (dq?.running || pq?.running) return true;
        try {
            const fp = (this.tilesRenderer as any).getPluginByName?.('FADE_TILES_PLUGIN');
            if (fp && fp.fadingTiles > 0) return true;
        } catch { /* ignore */ }
        return false;
    }

    private startRepaintLoop(): void {
        if (this.repaintTimer || !this.map) return;
        this.repaintTimer = setInterval(() => {
            if (!this.map) { this.stopRepaintLoop(); return; }
            this.map.triggerRepaint();
            if (!this.hasActiveWork()) this.stopRepaintLoop();
        }, REPAINT_INTERVAL_MS);
    }

    private stopRepaintLoop(): void {
        if (this.repaintTimer) {
            clearInterval(this.repaintTimer);
            this.repaintTimer = null;
        }
    }

    // ── MapLibre lifecycle ───────────────────────────────────────────────────

    onAdd(
        map: maplibregl.Map,
        gl: WebGLRenderingContext | WebGL2RenderingContext
    ): void {
        this.map = map;

        // ── Renderer ─────────────────────────────────────────────────────────
        this.renderer = new THREE.WebGLRenderer({
            canvas:    map.getCanvas() as HTMLCanvasElement,
            context:   gl,
            antialias: false,
        });
        this.renderer.autoClear        = false;
        this.renderer.autoClearColor   = false;
        this.renderer.autoClearDepth   = false;
        this.renderer.autoClearStencil = false;
        this.renderer.shadowMap.enabled = false;

        // ── Cameras ──────────────────────────────────────────────────────────

        // LOD CAMERA: fixed above tileset centre, never moves.
        // SSE = geometricError / (distance × sseDenominator)
        //
        // At 500 m altitude with 4× resolution inflation, a tile with
        // geometricError = 0.1 m gets SSE ≈ 0.1 × 4320 / (500 × 2 × 1)
        // ≈ 0.43 px.  Since errorTarget = 0, 0.43 > 0, so traversal
        // continues.  Every non-leaf tile (geometricError > 0) will be
        // refined.
        this.lodCamera = new THREE.PerspectiveCamera(
            SELECTION_FOV_DEG, 1, 1, 1e9
        );
        const [lx, ly, lz] = lngLatToECEF(
            this.lng0, this.lat0, SELECTION_HEIGHT_M
        );
        this.lodCamera.position.set(lx, ly, lz);
        const [cx, cy, cz] = lngLatToECEF(this.lng0, this.lat0, 0);
        this.lodCamera.lookAt(cx, cy, cz);
        this.lodCamera.updateProjectionMatrix();
        this.lodCamera.updateMatrixWorld(true);

        // RENDER CAMERA: projectionMatrix overwritten per-frame.
        this.renderCamera = new THREE.Camera();
        this.renderCamera.matrixWorld.identity();
        this.renderCamera.matrixWorldInverse.identity();

        // ── Scene ────────────────────────────────────────────────────────────
        // Lights are harmless on MeshBasicMaterial; useful if materials are
        // later swapped to PBR for debugging.
        this.scene = new THREE.Scene();
        this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
        const dir = new THREE.DirectionalLight(0xffffff, 1.5);
        dir.position.set(1, 1, 1).normalize();
        this.scene.add(dir);

        // ── TilesRenderer ────────────────────────────────────────────────────
        this.tilesRenderer = new TilesRenderer(this.tilesetUrl);
        const tr = this.tilesRenderer as unknown as Record<string, unknown>;

        // errorTarget = 0 means the traversal condition
        //   tile.traversal.error <= 0
        // is only true when error is exactly 0, which only happens for leaf
        // tiles (geometricError = 0).  So ALL non-leaf tiles are refined.
        if ('errorTarget'           in tr) tr.errorTarget           = 0;

        // displayActiveTiles: keep parent tiles visible until ALL children
        // are loaded.  Without this, the parent disappears as soon as ONE
        // child starts loading, creating holes.
        if ('displayActiveTiles'    in tr) tr.displayActiveTiles    = true;

        // optimizedLoadStrategy: loads only the tiles satisfying the current
        // SSE threshold rather than the full parent→child hierarchy.
        if ('optimizedLoadStrategy' in tr) tr.optimizedLoadStrategy = true;

        // loadSiblings: when one child of a parent loads, all its siblings
        // must also load before the parent can be removed.  Prevents
        // partial display of a tile set's children.
        if ('loadSiblings'          in tr) tr.loadSiblings          = true;

        // ── Mesh post-processing (BEFORE fade plugin) ────────────────────────
        // This listener MUST be registered before TilesFadePlugin so the
        // fade shader wraps our MeshBasicMaterial, not the original PBR.
        //
        // Event ordering:
        //   1. Our listener → replaces material + welds vertices
        //   2. TilesFadePlugin listener → wraps our material with fade shader
        //
        // addEventListener preserves registration order for dispatch.
        this.tilesRenderer.addEventListener('load-model', (event: any) => {
            const root = event?.scene;
            if (!root || typeof root.traverse !== 'function') {
                // Guard: some events may fire with undefined scene (e.g.,
                // external tilesets, or tile content that failed to parse
                // but didn't throw).  Log and skip.
                console.warn(
                    '[ThreeDTilesLayer] load-model event has no traversable scene:',
                    event?.url ?? '(unknown url)'
                );
                return;
            }
            processLoadedScene(root);
        });

        // ── Plugins ──────────────────────────────────────────────────────────
        this.dracoLoader = new DRACOLoader();
        this.dracoLoader.setDecoderPath(
            'https://www.gstatic.com/draco/versioned/decoders/1.5.6/'
        );
        this.dracoLoader.preload();
        this.tilesRenderer.registerPlugin(
            new GLTFExtensionsPlugin({ dracoLoader: this.dracoLoader })
        );

        // TilesFadePlugin: cross-fades parent → children during LOD
        // transitions.  Without this, displayActiveTiles causes both parent
        // and children to render at full opacity, producing severe z-fighting.
        // The plugin modifies each material's onBeforeCompile to inject a
        // fade uniform that multiplies output alpha.
        this.tilesRenderer.registerPlugin(
            new TilesFadePlugin({
                fadeDuration:        FADE_DURATION_MS,
                maximumFadeOutTiles: MAX_FADE_OUT_TILES,
            })
        );

        // ── Camera + resolution ──────────────────────────────────────────────
        this.tilesRenderer.setCamera(this.lodCamera);
        const canvas = map.getCanvas();
        this.tilesRenderer.setResolution(
            this.lodCamera,
            canvas.width  * RESOLUTION_MULTIPLIER,
            canvas.height * RESOLUTION_MULTIPLIER
        );

        // ── Repaint triggers ─────────────────────────────────────────────────
        const kick = (): void => {
            map.triggerRepaint();
            this.startRepaintLoop();
        };
        this.tilesRenderer.addEventListener('load-tile-set', kick);
        this.tilesRenderer.addEventListener('load-model',    kick);
        this.tilesRenderer.addEventListener('needs-render',  kick);

        // ── Diagnostics ──────────────────────────────────────────────────────
        // load-error fires when a tile's HTTP fetch or parse fails.
        // Common causes: 404 (wrong content.uri path), CORS, bad MIME type.
        this.tilesRenderer.addEventListener('load-error', (event: any) => {
            const url  = event?.url ?? event?.tile?.content?.uri ?? '(unknown)';
            const err  = event?.error;
            const msg  = err instanceof Error ? err.message : String(err ?? '');
            console.warn(`[ThreeDTilesLayer] tile load failure: ${url}`, msg);
        });

        // Log progress periodically — uses correct stats property names.
        // stats.downloading: tiles currently being fetched
        // stats.parsing:     tiles being decoded (Draco / glTF parse)
        // stats.queued:      tiles waiting in the download queue
        // stats.loaded:      total tiles successfully loaded
        // stats.failed:      total tiles that failed to load
        let lastLogTime = 0;
        this.tilesRenderer.addEventListener('load-model', () => {
            const now = performance.now();
            if (now - lastLogTime < 2000) return; // throttle to every 2s
            lastLogTime = now;
            const s = (this.tilesRenderer as any)?.stats;
            if (s) {
                console.log(
                    `[ThreeDTilesLayer] downloading: ${s.downloading}, ` +
                    `parsing: ${s.parsing}, queued: ${s.queued}, ` +
                    `loaded: ${s.loaded}, failed: ${s.failed}, ` +
                    `visible: ${s.visible}`
                );
            }
        });

        this.scene.add(this.tilesRenderer.group);

        // Seed the render loop.
        map.triggerRepaint();
        this.startRepaintLoop();
    }

    render(
        _gl: WebGLRenderingContext | WebGL2RenderingContext,
        options: CustomRenderMethodInput
    ): void {
        if (
            !this.renderer || !this.scene || !this.map ||
            !this.lodCamera || !this.renderCamera || !this.tilesRenderer
        ) return;

        const gl     = _gl;
        const canvas = this.map.getCanvas();

        // ── 1. Update inflated resolution (handles canvas resize) ────────────
        this.tilesRenderer.setResolution(
            this.lodCamera,
            canvas.width  * RESOLUTION_MULTIPLIER,
            canvas.height * RESOLUTION_MULTIPLIER
        );
        // lodCamera position & orientation stay FIXED from onAdd.

        // ── 2. Build renderCamera from MapLibre MVP ──────────────────────────
        const rawMat = options.modelViewProjectionMatrix;
        const mercatorToClip = new THREE.Matrix4().fromArray(
            rawMat instanceof Float64Array
                ? Array.from(rawMat)
                : rawMat as unknown as number[]
        );

        let worldSize = 512 * Math.pow(2, this.map.getZoom());
        try {
            const t: any = (this.map as any).transform;
            if (t && typeof t.worldSize === 'number') worldSize = t.worldSize;
        } catch { /* fallback */ }

        const ecefToMerc = buildEcefToMercatorMatrix(
            this.lng0, this.lat0, this.altitudeOffset, worldSize
        );
        const combined = new THREE.Matrix4().multiplyMatrices(
            mercatorToClip, ecefToMerc
        );
        this.renderCamera.projectionMatrix       = combined;
        this.renderCamera.projectionMatrixInverse = combined.clone().invert();

        // ── 3. Advance tile streaming ────────────────────────────────────────
        this.tilesRenderer.update();

        // ── 4. Render with clean depth + polygon offset ──────────────────────
        const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

        // Clear ONLY depth — colour buffer retains MapLibre's raster map.
        // This prevents stale depth from MapLibre's vector/raster layers
        // from occluding our 3D tiles.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // Enable polygon offset at the GL level as well (belt-and-suspenders
        // with the material-level polygonOffset).  Three.js respects material
        // settings, but the raw GL call guarantees it's active even if
        // Three.js's state cache is stale.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(POLYGON_OFFSET_FACTOR, POLYGON_OFFSET_UNITS);

        this.renderer.state.reset();
        this.renderer.render(this.scene, this.renderCamera);

        // Restore GL state for MapLibre.
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
        this.renderer.state.reset();

        // ── 5. Keep repaint loop alive while work remains ────────────────────
        if (this.hasActiveWork()) {
            this.startRepaintLoop();
        }
    }

    onRemove(
        _map: maplibregl.Map,
        _gl: WebGLRenderingContext | WebGL2RenderingContext
    ): void {
        this.stopRepaintLoop();
        this.tilesRenderer?.dispose();
        this.dracoLoader?.dispose();
        this.tilesRenderer = null;
        this.dracoLoader   = null;
        this.renderer      = null;
        this.scene         = null;
        this.lodCamera     = null;
        this.renderCamera  = null;
        this.map           = null;
    }
}
