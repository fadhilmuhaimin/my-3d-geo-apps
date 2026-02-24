import * as THREE from 'three';
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
 *   2. gl.clear(DEPTH_BUFFER_BIT) before render — gives 3D tiles a clean
 *      depth slate so MapLibre's raster depth doesn't interfere.
 *   3. FrontSide only — hides inward-facing skirt back-faces that would
 *      otherwise z-fight with outward-facing surfaces.
 *
 * NOTE: polygonOffset is intentionally NOT used.  Applying depth bias
 * (especially double — material-level + GL-level) causes geometry layers
 * to visually separate when viewed from oblique angles, which is worse
 * than the z-fighting it aims to fix.  TilesFadePlugin's opacity
 * cross-fade is sufficient.
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
 *   • TilesFadePlugin cross-fade (prevents dual full-opacity overlap)
 *
 * NOTE: vertex welding (mergeVertices) was removed because it corrupts
 * photogrammetry geometry — collapsing vertices with different UVs/normals
 * creates T-junctions and texture seam artifacts.  Render raw tile data.
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

const SELECTION_HEIGHT_M     = 500;
const SELECTION_FOV_DEG      = 90;
const RESOLUTION_MULTIPLIER  = 4;
const FADE_DURATION_MS       = 500;
const MAX_FADE_OUT_TILES     = 100;
const REPAINT_INTERVAL_MS    = 50;

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

/**
 * Build a 4×4 matrix that transforms ECEF coordinates into the coordinate
 * system expected by MapLibre's `modelViewProjectionMatrix` (which is the
 * internal `_viewProjMatrix` — see mercator_transform.ts:640).
 *
 * MapLibre's _viewProjMatrix expects:
 *   X, Y → worldSize-scaled Mercator coordinates  (range [0, worldSize])
 *   Z    → altitude in **metres**                  (the matrix internally
 *          multiplies Z by pixelsPerMeter = worldSize / circumference(lat)
 *          to bring it into the same worldSize-scaled space as X/Y)
 *
 * See mercator_transform.ts lines 626, 630, 633:
 *   mat4.translate(m, m, [-x, -y, 0]);          // x,y in worldSize-scaled
 *   _mercatorMatrix = m × scale(worldSize);      // separate copy for [0,1]
 *   mat4.scale(m, m, [1, 1, pixelsPerMeter]);    // Z metres → worldSize
 *
 * Therefore:
 *   • Rows 0 & 1 (X, Y) scale by sH = worldSize / (circumference × cosφ)
 *     to convert ECEF metre offsets to worldSize-scaled Mercator.
 *   • Row 2 (Z) uses scale = 1.0 to output metres directly, because the
 *     MVP already applies the pixelsPerMeter Z-scaling internally.
 *
 * PRIOR BUG:  Row 2 used sV = worldSize / circumference, which meant Z
 * was in worldSize-scaled units.  The MVP then multiplied Z *again* by
 * pixelsPerMeter (≈ worldSize / circumference), giving an effective Z scale
 * of worldSize² / circumference² — growing quadratically with zoom.
 * This caused vertical "stretching upward" that worsened as the user
 * zoomed in.
 */
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

    // ENU (East-North-Up) basis vectors at the tangent point on WGS84
    const Ex = -sinλ,        Ey =  cosλ,        Ez = 0;
    const Nx = -sinφ * cosλ, Ny = -sinφ * sinλ, Nz = cosφ;
    const Ux =  cosφ * cosλ, Uy =  cosφ * sinλ, Uz = sinφ;

    // Horizontal scale: ECEF metres → worldSize-scaled Mercator.
    // The Mercator projection is conformal, so the E and N directions
    // share the same scale factor = 1 / (circumference × cosφ) × worldSize.
    const sH = worldSize / (EARTH_CIRCUMFERENCE * cosφ);

    // Z scale: 1.0 (output metres directly; the MVP handles the rest).
    // Do NOT multiply by worldSize here — the MVP already applies
    // pixelsPerMeter = worldSize / circumference(lat) to Z internally.

    const [Cx, Cy, Cz] = lngLatToECEF(lng0, lat0, 0);

    // Mercator position of the tangent point (worldSize-scaled)
    const mx0 = (lng0 + 180) / 360;
    const my0 =
        (1 - Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360)) / Math.PI) / 2;

    // Translation: the matrix maps the ECEF centre C to (mx0*ws, my0*ws, 0+offset)
    const tx =  mx0 * worldSize - sH * (Ex * Cx + Ey * Cy + Ez * Cz);
    const ty =  my0 * worldSize + sH * (Nx * Cx + Ny * Cy + Nz * Cz);
    const tz = -(Ux * Cx + Uy * Cy + Uz * Cz) + altitudeOffset;

    return new THREE.Matrix4().set(
         sH * Ex,  sH * Ey,  sH * Ez,  tx,
        -sH * Nx, -sH * Ny, -sH * Nz,  ty,
              Ux,       Uy,       Uz,   tz,
              0,        0,        0,    1
    );
}

// ══════════════════════════════════════════════════════════════════════════════
// MESH POST-PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Process a loaded tile's scene graph:
 *
 * 1. Disable Three.js frustum culling — the combined projection matrix
 *    (mercatorToClip × ecefToMerc) maps from ECEF (coordinates ~10⁶) to
 *    clip space ([-1,1]).  When Three.js extracts frustum planes from this
 *    matrix, numerical precision issues cause valid meshes to be incorrectly
 *    culled.  This produces holes that worsen as the MapLibre camera moves.
 *    We rely on 3d-tiles-renderer's tile-level frustum culling (via lodCamera)
 *    instead — it operates on proper OBB/sphere bounding volumes.
 *
 * 2. Material replacement — creates an unlit MeshBasicMaterial with:
 *    • map/color preserved from the original material
 *    • FrontSide — hides skirt back-faces (see header comment)
 *    • depthWrite = true — ensures this tile's fragments contribute to the
 *      depth buffer so subsequent tiles respect occlusion
 *
 * Photogrammetry tiles are pre-optimized.  We do NOT modify geometry.
 */
function processLoadedScene(root: THREE.Object3D): void {
    root.traverse((obj: any) => {
        // Disable Three.js mesh-level frustum culling for ALL objects
        // (groups, meshes, etc.) in the tile scene graph.
        obj.frustumCulled = false;

        if (!obj.isMesh) return;

        const src = obj.material;
        if (!src) return;

        obj.material = new THREE.MeshBasicMaterial({
            map:         src.map         ?? null,
            color:       src.color       ?? 0xffffff,
            transparent: src.transparent ?? false,
            side:        THREE.FrontSide,
            depthWrite:  true,
            depthTest:   true,
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

        // RENDER CAMERA: matrices set per-frame in render().
        // We override updateMatrixWorld to prevent Three.js from
        // recomputing our manually-set matrixWorld/matrixWorldInverse
        // during renderer.render().  See render() for the GPU precision
        // comment explaining WHY we split projectionMatrix and
        // matrixWorldInverse instead of using a single combined matrix.
        this.renderCamera = new THREE.Camera();
        this.renderCamera.matrixAutoUpdate = false;
        this.renderCamera.updateMatrixWorld = function() {};

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

        // optimizedLoadStrategy: DISABLED for photogrammetry.
        // The optimized traversal ("stop at first ready tile") can show
        // partial sets of children before all siblings have loaded, creating
        // holes with REPLACE refine mode.  The standard traversal waits for
        // ALL children before removing the parent.
        if ('optimizedLoadStrategy' in tr) tr.optimizedLoadStrategy = false;

        // loadSiblings: when one child of a parent loads, all its siblings
        // must also load before the parent can be removed.  Prevents
        // partial display of a tile set's children.
        if ('loadSiblings'          in tr) tr.loadSiblings          = true;

        // ── Mesh post-processing (BEFORE fade plugin) ────────────────────────
        // This listener MUST be registered before TilesFadePlugin so the
        // fade shader wraps our MeshBasicMaterial, not the original PBR.
        //
        // Event ordering:
        //   1. Our listener → disables frustumCulled + replaces material
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

        // ── 2. Build renderCamera — GPU precision fix ────────────────────────
        //
        // GPU PRECISION FIX — Camera-Relative Transform Splitting
        // ────────────────────────────────────────────────────────
        // Problem:  putting the full ECEF→clip pipeline into one matrix
        //   (projectionMatrix = mercatorToClip × ecefToMerc, matrixWorldInverse = I)
        //   means the vertex shader does ALL arithmetic in Float32:
        //
        //   gl_Position = combined × tileMatrixWorld × vec4(position, 1)
        //
        //   tileMatrixWorld × position produces ECEF coords (~6 × 10⁶ m).
        //   combined then subtracts a ~2 × 10⁷ Mercator translation.
        //   Float32 has ~7 significant digits → 22 000 025 − 22 000 000 = 0 or 32.
        //   A 25 m detail is LOST.  This catastrophic cancellation causes
        //   fragmented edges, floating geometry, and depth shimmering.
        //
        // Fix:  split the pipeline into two matrices:
        //
        //   matrixWorldInverse = ecefToMercRel    (ECEF → camera-relative Mercator)
        //   projectionMatrix   = adjustedMVP      (camera-relative Mercator → clip)
        //
        // Three.js computes modelViewMatrix = matrixWorldInverse × object.matrixWorld
        // in JavaScript (Float64, ~16 digits).  The ECEF → Mercator conversion
        // including its large-value cancellation happens here, with full precision.
        // The result is camera-relative Mercator coords (small: ±hundreds of m).
        //
        // The GPU then only does:  gl_Position = adjustedMVP × smallCoords
        //   → no catastrophic cancellation.  Float32 is sufficient.
        //
        // Proof of equivalence:
        //   adjustedMVP × ecefToMercRel
        //   = mercatorToClip × translate(cam) × (ecefToMerc − translate(cam))
        //   = mercatorToClip × ecefToMerc    (the translate pair cancels)     ✓
        //
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

        // Camera center in worldSize-scaled Mercator coordinates
        const center = this.map.getCenter();
        const camMercX = ((center.lng + 180) / 360) * worldSize;
        const camMercY =
            ((1 - Math.log(Math.tan(Math.PI / 4 + (center.lat * Math.PI) / 360)) / Math.PI) / 2) * worldSize;

        // ecefToMercRel: same rotation/scale as ecefToMerc, but
        // translation is camera-relative  (subtract camera Mercator XY).
        const ecefToMercRel = ecefToMerc.clone();
        ecefToMercRel.elements[12] -= camMercX;  // column-major tx
        ecefToMercRel.elements[13] -= camMercY;  // column-major ty

        // adjustedMVP: re-adds the camera position so the net result
        // is mathematically identical to mercatorToClip × ecefToMerc.
        const camTranslate = new THREE.Matrix4().makeTranslation(
            camMercX, camMercY, 0
        );
        const adjustedMVP = new THREE.Matrix4().multiplyMatrices(
            mercatorToClip, camTranslate
        );

        // Set camera matrices for split rendering
        this.renderCamera.projectionMatrix.copy(adjustedMVP);
        this.renderCamera.projectionMatrixInverse.copy(adjustedMVP).invert();
        this.renderCamera.matrixWorldInverse.copy(ecefToMercRel);
        this.renderCamera.matrixWorld.copy(ecefToMercRel).invert();

        // ── 3. Advance tile streaming ────────────────────────────────────────
        this.tilesRenderer.update();

        // ── 4. Render with clean depth ────────────────────────────────────────
        const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

        // Clear ONLY depth — colour buffer retains MapLibre's raster map.
        // This prevents stale depth from MapLibre's vector/raster layers
        // from occluding our 3D tiles.
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        this.renderer.state.reset();
        this.renderer.render(this.scene, this.renderCamera);

        // Restore GL state for MapLibre.
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

// ══════════════════════════════════════════════════════════════════════════════
// DEBUG VALIDATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Validate the ECEF→Mercator transform math.  Call from browser console:
 *
 *     import { debugValidateTransform } from './utils/threeDTilesLayer'
 *     debugValidateTransform(119.41, -5.14)
 *
 * Expected output:
 *   ✓ Center maps to (mx0*ws, my0*ws, offset)
 *   ✓ Z is linear: 100m offset → Z delta = 100
 *   ✓ Horizontal 100m east → X delta ≈ sH*100
 *   ✓ No worldSize in Z
 */
export function debugValidateTransform(
    lng = 119.41,
    lat = -5.14,
    altOffset = 0
): void {
    const ws = 512 * Math.pow(2, 16); // zoom 16

    const M = buildEcefToMercatorMatrix(lng, lat, altOffset, ws);

    // -- Test 1: center ECEF → expected Mercator position --
    const C = new THREE.Vector4(...lngLatToECEF(lng, lat, 0), 1);
    const pCenter = C.clone().applyMatrix4(M);

    const mx0 = (lng + 180) / 360;
    const my0 =
        (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;

    const xErr = Math.abs(pCenter.x - mx0 * ws);
    const yErr = Math.abs(pCenter.y - my0 * ws);
    const zErr = Math.abs(pCenter.z - altOffset);

    console.log('=== Transform Validation ===');
    console.log(`worldSize: ${ws}  (zoom 16)`);
    console.log(`Center ECEF: [${C.x.toFixed(1)}, ${C.y.toFixed(1)}, ${C.z.toFixed(1)}]`);
    console.log(`Mapped to:   [${pCenter.x.toFixed(4)}, ${pCenter.y.toFixed(4)}, ${pCenter.z.toFixed(4)}]`);
    console.log(`Expected:    [${(mx0 * ws).toFixed(4)}, ${(my0 * ws).toFixed(4)}, ${altOffset}]`);
    console.log(xErr < 0.01 ? '  ✓ X correct' : `  ✗ X error: ${xErr}`);
    console.log(yErr < 0.01 ? '  ✓ Y correct' : `  ✗ Y error: ${yErr}`);
    console.log(zErr < 0.01 ? '  ✓ Z correct' : `  ✗ Z error: ${zErr}`);

    // -- Test 2: Z linearity (100m above center) --
    const C100 = new THREE.Vector4(...lngLatToECEF(lng, lat, 100), 1);
    const p100 = C100.clone().applyMatrix4(M);
    const zDelta = p100.z - pCenter.z;

    console.log(`\nZ linearity: 100m altitude → Z delta = ${zDelta.toFixed(4)}`);
    console.log(
        Math.abs(zDelta - 100) < 0.5
            ? '  ✓ Z delta ≈ 100 (metres, not worldSize-scaled)'
            : `  ✗ Z delta should be ~100, got ${zDelta.toFixed(2)} — likely double-scaled`
    );

    // -- Test 3: Z must NOT scale with worldSize --
    const ws2 = 512 * Math.pow(2, 20); // zoom 20
    const M2 = buildEcefToMercatorMatrix(lng, lat, altOffset, ws2);
    const p100z20 = C100.clone().applyMatrix4(M2);
    const pCz20   = C.clone().applyMatrix4(M2);
    const zDelta20 = p100z20.z - pCz20.z;

    console.log(`\nZ at zoom 20: 100m altitude → Z delta = ${zDelta20.toFixed(4)}`);
    console.log(
        Math.abs(zDelta20 - zDelta) < 0.01
            ? '  ✓ Z is zoom-independent (same at zoom 16 and 20)'
            : `  ✗ Z changed with zoom: z16=${zDelta.toFixed(4)}, z20=${zDelta20.toFixed(4)} — BUG`
    );

    // -- Test 4: Horizontal scale check --
    const φ = (lat * Math.PI) / 180;
    const sH = ws / (EARTH_CIRCUMFERENCE * Math.cos(φ));

    // Approximate: 100m east from center
    const eastECEF = lngLatToECEF(lng + 100 / (111320 * Math.cos(φ)), lat, 0);
    const pEast = new THREE.Vector4(...eastECEF, 1).applyMatrix4(M);
    const xDelta = pEast.x - pCenter.x;
    const expectedXDelta = sH * 100;

    console.log(`\nHorizontal: 100m east → X delta = ${xDelta.toFixed(4)}`);
    console.log(`Expected X delta ≈ ${expectedXDelta.toFixed(4)} (sH × 100)`);
    console.log(
        Math.abs(xDelta - expectedXDelta) / expectedXDelta < 0.01
            ? '  ✓ Horizontal scale correct'
            : `  ✗ Horizontal scale mismatch`
    );

    // -- Test 5: Float32 precision — combined vs split matrices --
    console.log('\n=== GPU Precision Test (Float32 simulation) ===');
    debugFloat32Precision(lng, lat, altOffset);
}

/**
 * Simulate GPU Float32 arithmetic to demonstrate the precision difference
 * between the old combined-matrix approach and the new split approach.
 *
 * Call from browser console:
 *   import { debugFloat32Precision } from './utils/threeDTilesLayer'
 *   debugFloat32Precision(119.41, -5.14)
 */
export function debugFloat32Precision(
    lng = 119.41,
    lat = -5.14,
    altOffset = 0
): void {
    const ws = 512 * Math.pow(2, 16); // zoom 16
    const ecefToMerc = buildEcefToMercatorMatrix(lng, lat, altOffset, ws);

    // Mock MVP: a simplified Mercator-to-clip that centers + scales.
    // In production this is MapLibre's _viewProjMatrix.
    const camMercX = ((lng + 180) / 360) * ws;
    const camMercY =
        ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * ws;
    const mockMVP = new THREE.Matrix4().set(
        1, 0, 0, -camMercX,
        0, 1, 0, -camMercY,
        0, 0, 1,  0,
        0, 0, 0,  1
    );

    // Two nearby points: center and 10m east
    const [Cx, Cy, Cz] = lngLatToECEF(lng, lat, 0);
    const phi = (lat * Math.PI) / 180;
    const dLng = 10 / (111320 * Math.cos(phi));
    const [Ex, Ey, Ez] = lngLatToECEF(lng + dLng, lat, 0);

    // ── Approach A: Combined matrix (old — GPU does everything in Float32) ──
    const combined = new THREE.Matrix4().multiplyMatrices(mockMVP, ecefToMerc);
    // Simulate Float32 by truncating matrix elements
    const cElems = new Float32Array(combined.elements);

    // Simulate tile matrixWorld = identity (tile verts already in ECEF)
    // GPU: result = combined_f32 × position_f32
    const cx32 = Math.fround(Cx), cy32 = Math.fround(Cy), cz32 = Math.fround(Cz);
    const ex32 = Math.fround(Ex), ey32 = Math.fround(Ey), ez32 = Math.fround(Ez);

    const outCx_A = Math.fround(Math.fround(cElems[0] * cx32) + Math.fround(cElems[4] * cy32) + Math.fround(cElems[8] * cz32) + cElems[12]);
    const outEx_A = Math.fround(Math.fround(cElems[0] * ex32) + Math.fround(cElems[4] * ey32) + Math.fround(cElems[8] * ez32) + cElems[12]);
    const deltaA = outEx_A - outCx_A;

    // ── Approach B: Split matrix (new — ECEF→Merc in Float64, GPU gets small values) ──
    const ecefToMercRel = ecefToMerc.clone();
    ecefToMercRel.elements[12] -= camMercX;
    ecefToMercRel.elements[13] -= camMercY;

    // CPU (Float64): modelViewMatrix × position
    const mvC_x = ecefToMercRel.elements[0] * Cx + ecefToMercRel.elements[4] * Cy + ecefToMercRel.elements[8] * Cz + ecefToMercRel.elements[12];
    const mvE_x = ecefToMercRel.elements[0] * Ex + ecefToMercRel.elements[4] * Ey + ecefToMercRel.elements[8] * Ez + ecefToMercRel.elements[12];

    // These are camera-relative Mercator → small values → safe for Float32
    const mvC_x32 = Math.fround(mvC_x);
    const mvE_x32 = Math.fround(mvE_x);

    // GPU: adjustedMVP × camera_relative (trivial identity-like in our mock)
    const deltaB = mvE_x32 - mvC_x32;

    // ── Reference (Float64) ──
    const refC_x = ecefToMerc.elements[0] * Cx + ecefToMerc.elements[4] * Cy + ecefToMerc.elements[8] * Cz + ecefToMerc.elements[12];
    const refE_x = ecefToMerc.elements[0] * Ex + ecefToMerc.elements[4] * Ey + ecefToMerc.elements[8] * Ez + ecefToMerc.elements[12];
    const deltaRef = (refE_x - camMercX) - (refC_x - camMercX);

    console.log(`10m east displacement (X axis, worldSize-scaled):`);
    console.log(`  Float64 reference:   ${deltaRef.toFixed(6)}`);
    console.log(`  Combined (Float32):  ${deltaA.toFixed(6)}  error: ${Math.abs(deltaA - deltaRef).toFixed(6)}`);
    console.log(`  Split (Float32):     ${deltaB.toFixed(6)}  error: ${Math.abs(deltaB - deltaRef).toFixed(6)}`);
    console.log(
        Math.abs(deltaB - deltaRef) < Math.abs(deltaA - deltaRef)
            ? '  ✓ Split approach has better precision'
            : '  info: Both approaches have similar precision at this scale'
    );
}
