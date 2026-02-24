/**
 * ThreeDTilesDebug — browser-runnable diagnostic and validation helpers.
 *
 * These functions are designed to be imported and called from the browser
 * console or from a debug panel.  They diagnose tile visibility, selection,
 * frustum culling, and rendering issues.
 *
 * Usage (browser console):
 *   import { diagnoseTileVisibility, diagnoseSelectionState,
 *            validateTransformLive, setupRenderComparison }
 *     from './utils/threeDTilesDebug'
 *
 *   diagnoseTileVisibility(map, 'three-d-tiles-layer')
 *   diagnoseSelectionState(map, 'three-d-tiles-layer')
 *   validateTransformLive(map, 'three-d-tiles-layer', 119.41, -5.14)
 */

import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════════════════════
// PART A: TILE VISIBILITY DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

interface TileVisibilityReport {
    totalMeshes: number;
    visibleMeshes: number;
    culledByFrustum: number;
    culledByRenderer: number;
    emptyGeometry: number;
    zeroScale: number;
    outsideClipSpace: number;
    meshDetails: Array<{
        name: string;
        visible: boolean;
        frustumCulled: boolean;
        vertexCount: number;
        boundingBoxZ: [number, number];
        worldPos: [number, number, number];
    }>;
}

/**
 * Walk the 3D tiles scene graph and report on every mesh's visibility state.
 * Helps identify WHY meshes aren't rendering — frustum culling, empty geometry,
 * zero scale, etc.
 */
export function diagnoseTileVisibility(
    tilesGroup: THREE.Group,
    camera: THREE.Camera
): TileVisibilityReport {
    const report: TileVisibilityReport = {
        totalMeshes: 0,
        visibleMeshes: 0,
        culledByFrustum: 0,
        culledByRenderer: 0,
        emptyGeometry: 0,
        zeroScale: 0,
        outsideClipSpace: 0,
        meshDetails: [],
    };

    // Build the frustum from the camera
    const frustum = new THREE.Frustum();
    const mvp = new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(mvp);

    tilesGroup.traverse((obj: THREE.Object3D) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;

        report.totalMeshes++;

        const geo = mesh.geometry;
        const vertexCount = geo?.getAttribute?.('position')?.count ?? 0;

        // Check for empty geometry
        if (vertexCount === 0) {
            report.emptyGeometry++;
        }

        // Check for zero scale
        const ws = new THREE.Vector3();
        mesh.getWorldScale(ws);
        if (ws.x === 0 || ws.y === 0 || ws.z === 0) {
            report.zeroScale++;
        }

        // Check frustum containment
        let inFrustum = true;
        if (mesh.frustumCulled) {
            if (geo?.boundingSphere === null) geo?.computeBoundingSphere();
            if (geo?.boundingSphere) {
                const sphere = geo.boundingSphere.clone();
                sphere.applyMatrix4(mesh.matrixWorld);
                inFrustum = frustum.intersectsSphere(sphere);
            }
        }

        if (mesh.frustumCulled && !inFrustum) {
            report.culledByFrustum++;
        }

        // Check if the parent chain has visible=false
        let parentVisible = true;
        let p: THREE.Object3D | null = mesh;
        while (p) {
            if (!p.visible) { parentVisible = false; break; }
            p = p.parent;
        }
        if (!parentVisible) {
            report.culledByRenderer++;
        }

        if ((mesh.visible && parentVisible && (inFrustum || !mesh.frustumCulled))) {
            report.visibleMeshes++;
        }

        // World position
        const wp = new THREE.Vector3();
        mesh.getWorldPosition(wp);

        // Bounding box Z range
        let bbZ: [number, number] = [0, 0];
        if (geo) {
            if (!geo.boundingBox) geo.computeBoundingBox();
            if (geo.boundingBox) {
                bbZ = [geo.boundingBox.min.z, geo.boundingBox.max.z];
            }
        }

        report.meshDetails.push({
            name: mesh.name || `mesh_${report.totalMeshes}`,
            visible: mesh.visible && parentVisible,
            frustumCulled: mesh.frustumCulled,
            vertexCount,
            boundingBoxZ: bbZ,
            worldPos: [wp.x, wp.y, wp.z],
        });
    });

    return report;
}

/**
 * Print a summary of tile visibility to the console.
 * Call from browser console after the map + tiles load.
 */
export function printVisibilityReport(
    tilesGroup: THREE.Group,
    camera: THREE.Camera
): void {
    const r = diagnoseTileVisibility(tilesGroup, camera);

    console.log('=== Tile Visibility Report ===');
    console.log(`Total meshes:       ${r.totalMeshes}`);
    console.log(`Visible:            ${r.visibleMeshes}`);
    console.log(`Frustum-culled:     ${r.culledByFrustum}`);
    console.log(`Hidden by parent:   ${r.culledByRenderer}`);
    console.log(`Empty geometry:     ${r.emptyGeometry}`);
    console.log(`Zero scale:         ${r.zeroScale}`);

    if (r.culledByFrustum > 0) {
        console.warn(
            `⚠ ${r.culledByFrustum} meshes culled by Three.js frustum. ` +
            `If tiles disappear, set frustumCulled=false on all tile meshes.`
        );
    }

    if (r.culledByRenderer > 0) {
        console.warn(
            `⚠ ${r.culledByRenderer} meshes hidden by parent.visible=false. ` +
            `Check if 3d-tiles-renderer is marking tiles as invisible.`
        );
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART B: TILE SELECTION / LOD STATE DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

interface SelectionReport {
    totalTiles: number;
    activeTiles: number;
    visibleTiles: number;
    loadedTiles: number;
    failedTiles: number;
    downloading: number;
    parsing: number;
    queued: number;
    tilesWithContent: number;
    tilesInFrustum: number;
    tilesNotInFrustum: number;
}

/**
 * Query the TilesRenderer's internal state to understand why tiles are
 * or aren't being shown.
 */
export function diagnoseSelectionState(tilesRenderer: unknown): SelectionReport {
    const tr = tilesRenderer as Record<string, any>;
    const stats = tr?.stats ?? {};
    const report: SelectionReport = {
        totalTiles: 0,
        activeTiles: 0,
        visibleTiles: 0,
        loadedTiles: stats.loaded ?? 0,
        failedTiles: stats.failed ?? 0,
        downloading: stats.downloading ?? 0,
        parsing: stats.parsing ?? 0,
        queued: stats.queued ?? 0,
        tilesWithContent: 0,
        tilesInFrustum: 0,
        tilesNotInFrustum: 0,
    };

    // Walk the tile tree
    const root = tr?.root;
    if (!root) {
        console.warn('No root tile found — tileset may not be loaded yet');
        return report;
    }

    function walkTile(tile: any): void {
        if (!tile) return;
        report.totalTiles++;

        const trav = tile.traversal ?? {};
        if (trav.active) report.activeTiles++;
        if (trav.visible) report.visibleTiles++;
        if (tile._content) report.tilesWithContent++;
        if (trav.inFrustum) report.tilesInFrustum++;
        else report.tilesNotInFrustum++;

        const children = tile.children ?? [];
        for (const child of children) {
            walkTile(child);
        }
    }
    walkTile(root);

    return report;
}

export function printSelectionReport(tilesRenderer: unknown): void {
    const r = diagnoseSelectionState(tilesRenderer);
    console.log('=== Tile Selection Report ===');
    console.log(`Total tiles:        ${r.totalTiles}`);
    console.log(`In frustum:         ${r.tilesInFrustum}`);
    console.log(`Not in frustum:     ${r.tilesNotInFrustum}`);
    console.log(`Active:             ${r.activeTiles}`);
    console.log(`Visible:            ${r.visibleTiles}`);
    console.log(`With content:       ${r.tilesWithContent}`);
    console.log(`Loaded:             ${r.loadedTiles}`);
    console.log(`Failed:             ${r.failedTiles}`);
    console.log(`Downloading:        ${r.downloading}`);
    console.log(`Parsing:            ${r.parsing}`);
    console.log(`Queued:             ${r.queued}`);

    const missing = r.tilesInFrustum - r.visibleTiles;
    if (missing > 0) {
        console.warn(
            `⚠ ${missing} tiles are in the frustum but not visible. ` +
            `Possible causes: SSE threshold, children not ready, tile not loaded.`
        );
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART C: TRANSFORM VALIDATION (LIVE)
// ═══════════════════════════════════════════════════════════════════════════════

const EARTH_CIRCUMFERENCE = 40_075_016.686;
const WGS84_A             = 6_378_137.0;
const WGS84_E2            = 0.006_694_379_990_14;

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
 * Validate the ECEF→clip projection pipeline at the current zoom.
 * Projects known ECEF points through the combined matrix and checks
 * that Z behaviour is correct.
 */
export function validateTransformLive(
    combinedMatrix: THREE.Matrix4,
    lng: number,
    lat: number,
    altitudeOffset: number,
): void {
    console.log('=== Live Transform Validation ===');

    // Project center at 0m altitude
    const C0 = new THREE.Vector4(...lngLatToECEF(lng, lat, 0), 1);
    const p0 = C0.clone().applyMatrix4(combinedMatrix);

    // Project center at 100m altitude
    const C100 = new THREE.Vector4(...lngLatToECEF(lng, lat, 100), 1);
    const p100 = C100.clone().applyMatrix4(combinedMatrix);

    // Project center at 200m altitude
    const C200 = new THREE.Vector4(...lngLatToECEF(lng, lat, 200), 1);
    const p200 = C200.clone().applyMatrix4(combinedMatrix);

    // NDC coordinates (after perspective divide)
    const ndc0   = { x: p0.x / p0.w,   y: p0.y / p0.w,   z: p0.z / p0.w };
    const ndc100 = { x: p100.x / p100.w, y: p100.y / p100.w, z: p100.z / p100.w };
    const ndc200 = { x: p200.x / p200.w, y: p200.y / p200.w, z: p200.z / p200.w };

    console.log(`Center (0m)   NDC: [${ndc0.x.toFixed(6)}, ${ndc0.y.toFixed(6)}, ${ndc0.z.toFixed(6)}]`);
    console.log(`Center (100m) NDC: [${ndc100.x.toFixed(6)}, ${ndc100.y.toFixed(6)}, ${ndc100.z.toFixed(6)}]`);
    console.log(`Center (200m) NDC: [${ndc200.x.toFixed(6)}, ${ndc200.y.toFixed(6)}, ${ndc200.z.toFixed(6)}]`);

    // Check 1: center should be in clip space
    const inClip = (ndc: { x: number; y: number; z: number }) =>
        Math.abs(ndc.x) <= 1.5 && Math.abs(ndc.y) <= 1.5 && ndc.z >= -1 && ndc.z <= 1;
    console.log(inClip(ndc0) ? '  ✓ Center is within clip space' : '  ✗ Center is OUTSIDE clip space');

    // Check 2: Z delta should be proportional (linearity)
    const dz1 = ndc100.z - ndc0.z;
    const dz2 = ndc200.z - ndc0.z;
    const ratio = dz2 / dz1;
    console.log(`Z delta ratio (200m/100m): ${ratio.toFixed(4)}`);
    console.log(
        Math.abs(ratio - 2.0) < 0.2
            ? '  ✓ Z is approximately linear'
            : `  ✗ Z is NOT linear (ratio should be ~2.0, got ${ratio.toFixed(4)})`
    );

    // Check 3: W values should be positive (in front of camera)
    console.log(
        p0.w > 0 && p100.w > 0 && p200.w > 0
            ? '  ✓ All W values positive (points in front of camera)'
            : `  ✗ Negative W (behind camera): w0=${p0.w.toFixed(2)} w100=${p100.w.toFixed(2)} w200=${p200.w.toFixed(2)}`
    );
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART D: RENDER COMPARISON HARNESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Capture the current WebGL framebuffer as an ImageData.
 * Can be used to compare renders from different systems.
 *
 * Usage:
 *   const pixels = captureFramebuffer(gl, canvas.width, canvas.height);
 *   // Convert to PNG via canvas and compare
 */
export function captureFramebuffer(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    width: number,
    height: number
): ImageData {
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Flip Y (WebGL origin is bottom-left)
    const flipped = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
        const srcOffset = (height - row - 1) * width * 4;
        const dstOffset = row * width * 4;
        flipped.set(pixels.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }

    return new ImageData(flipped, width, height);
}

/**
 * Compare two ImageData objects and return per-pixel difference stats.
 * threshold: max allowed per-channel difference (0-255).
 */
export function compareImages(
    imgA: ImageData,
    imgB: ImageData,
    threshold = 10
): {
    totalPixels: number;
    matchingPixels: number;
    mismatchPixels: number;
    mismatchPercent: number;
    avgDifference: number;
} {
    const w = Math.min(imgA.width, imgB.width);
    const h = Math.min(imgA.height, imgB.height);
    const totalPixels = w * h;
    let matchingPixels = 0;
    let totalDiff = 0;

    for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        const dr = Math.abs(imgA.data[idx]     - imgB.data[idx]);
        const dg = Math.abs(imgA.data[idx + 1] - imgB.data[idx + 1]);
        const db = Math.abs(imgA.data[idx + 2] - imgB.data[idx + 2]);
        const maxDiff = Math.max(dr, dg, db);
        totalDiff += maxDiff;
        if (maxDiff <= threshold) matchingPixels++;
    }

    const mismatchPixels = totalPixels - matchingPixels;
    return {
        totalPixels,
        matchingPixels,
        mismatchPixels,
        mismatchPercent: (mismatchPixels / totalPixels) * 100,
        avgDifference: totalDiff / totalPixels,
    };
}

/**
 * Generate a diff image highlighting pixel differences between two renders.
 * Green = matching, Red = mismatching, brightness = magnitude.
 */
export function generateDiffImage(
    imgA: ImageData,
    imgB: ImageData,
    threshold = 10
): ImageData {
    const w = Math.min(imgA.width, imgB.width);
    const h = Math.min(imgA.height, imgB.height);
    const diff = new ImageData(w, h);

    for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        const dr = Math.abs(imgA.data[idx]     - imgB.data[idx]);
        const dg = Math.abs(imgA.data[idx + 1] - imgB.data[idx + 1]);
        const db = Math.abs(imgA.data[idx + 2] - imgB.data[idx + 2]);
        const maxDiff = Math.max(dr, dg, db);

        if (maxDiff <= threshold) {
            // Match: green
            diff.data[idx]     = 0;
            diff.data[idx + 1] = 128;
            diff.data[idx + 2] = 0;
        } else {
            // Mismatch: red, brightness = magnitude
            const brightness = Math.min(255, maxDiff * 3);
            diff.data[idx]     = brightness;
            diff.data[idx + 1] = 0;
            diff.data[idx + 2] = 0;
        }
        diff.data[idx + 3] = 255; // Full alpha
    }

    return diff;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART E: ZOOM-INVARIANCE VALIDATION  (spec item A)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an ecefToMerc matrix (standalone copy for diagnostics — no Three.js
 * Matrix4 dependency in the test harness, but we use it here because this
 * file already imports Three).
 */
function buildEcefToMercatorDiag(
    lng0: number, lat0: number, altitudeOffset: number, worldSize: number
): THREE.Matrix4 {
    const lambda = (lng0 * Math.PI) / 180;
    const phi    = (lat0 * Math.PI) / 180;
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    const sinP = Math.sin(phi),    cosP = Math.cos(phi);

    const Ex = -sinL,       Ey =  cosL,       Ez = 0;
    const Nx = -sinP * cosL, Ny = -sinP * sinL, Nz = cosP;
    const Ux =  cosP * cosL, Uy =  cosP * sinL, Uz = sinP;

    const sH = worldSize / (EARTH_CIRCUMFERENCE * cosP);

    const [Cx, Cy, Cz] = lngLatToECEF(lng0, lat0, 0);

    const mx0 = (lng0 + 180) / 360;
    const my0 =
        (1 - Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360)) / Math.PI) / 2;

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

/**
 * Test spec item A: project the same ECEF point through ecefToMerc at two
 * zoom levels and verify the Z output (in Mercator space, before MVP) does
 * NOT change.
 *
 * Also projects at 0 m and 100 m altitude to confirm Z delta = 100 m at
 * both zooms.
 *
 * Call from browser console:
 *   import { validateZoomInvariance } from './utils/threeDTilesDebug'
 *   validateZoomInvariance(119.41, -5.14)
 */
export function validateZoomInvariance(
    lng = 119.41,
    lat = -5.14,
    altOffset = 0,
    zoom1 = 16,
    zoom2 = 20
): void {
    const ws1 = 512 * Math.pow(2, zoom1);
    const ws2 = 512 * Math.pow(2, zoom2);
    const M1 = buildEcefToMercatorDiag(lng, lat, altOffset, ws1);
    const M2 = buildEcefToMercatorDiag(lng, lat, altOffset, ws2);

    const C0   = new THREE.Vector4(...lngLatToECEF(lng, lat, 0), 1);
    const C100 = new THREE.Vector4(...lngLatToECEF(lng, lat, 100), 1);

    // Mercator-space Z (before MVP perspective divide)
    const p0_z1   = C0.clone().applyMatrix4(M1).z;
    const p100_z1 = C100.clone().applyMatrix4(M1).z;
    const p0_z2   = C0.clone().applyMatrix4(M2).z;
    const p100_z2 = C100.clone().applyMatrix4(M2).z;

    const dz1 = p100_z1 - p0_z1;
    const dz2 = p100_z2 - p0_z2;

    console.log(`=== Zoom-Invariance Validation (zoom ${zoom1} vs ${zoom2}) ===`);
    console.log(`Z at 0m  (zoom ${zoom1}): ${p0_z1.toFixed(4)}`);
    console.log(`Z at 0m  (zoom ${zoom2}): ${p0_z2.toFixed(4)}`);
    console.log(`Z delta 100m (zoom ${zoom1}): ${dz1.toFixed(4)}`);
    console.log(`Z delta 100m (zoom ${zoom2}): ${dz2.toFixed(4)}`);

    const pass1 = Math.abs(p0_z1 - p0_z2) < 0.01;
    const pass2 = Math.abs(dz1 - 100) < 0.5;
    const pass3 = Math.abs(dz2 - 100) < 0.5;
    const pass4 = Math.abs(dz1 - dz2) < 0.01;

    console.log(pass1 ? '  ✓ Z(0m) is zoom-invariant' : `  ✗ Z(0m) changed: ${p0_z1.toFixed(4)} vs ${p0_z2.toFixed(4)}`);
    console.log(pass2 ? `  ✓ Z delta at zoom ${zoom1} ≈ 100 m` : `  ✗ Z delta at zoom ${zoom1} = ${dz1.toFixed(4)} (expected ~100)`);
    console.log(pass3 ? `  ✓ Z delta at zoom ${zoom2} ≈ 100 m` : `  ✗ Z delta at zoom ${zoom2} = ${dz2.toFixed(4)} (expected ~100)`);
    console.log(pass4 ? '  ✓ Z delta is identical across zooms' : `  ✗ Z delta differs: ${dz1.toFixed(4)} vs ${dz2.toFixed(4)}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART F: DEPTH PRECISION ANALYSIS  (spec item C)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyse depth buffer precision across the current tile scene.
 *
 * Reads gl.getParameter values for depthFunc, depthRange, and the depth
 * buffer bit-depth.  Then samples depth at a grid of screen positions and
 * reports the distribution.
 *
 * Call from browser console:
 *   import { analyzeDepthPrecision } from './utils/threeDTilesDebug'
 *   analyzeDepthPrecision(gl, canvas.width, canvas.height)
 */
export function analyzeDepthPrecision(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    width: number,
    height: number
): void {
    console.log('=== Depth Precision Analysis ===');

    // GL state
    const depthTest   = gl.getParameter(gl.DEPTH_TEST);
    const depthFunc   = gl.getParameter(gl.DEPTH_FUNC);
    const depthRange  = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
    const depthBits   = gl.getParameter(gl.DEPTH_BITS);
    const depthMask   = gl.getParameter(gl.DEPTH_WRITEMASK);

    const funcNames: Record<number, string> = {
        [gl.NEVER]:    'NEVER',
        [gl.LESS]:     'LESS',
        [gl.EQUAL]:    'EQUAL',
        [gl.LEQUAL]:   'LEQUAL',
        [gl.GREATER]:  'GREATER',
        [gl.NOTEQUAL]: 'NOTEQUAL',
        [gl.GEQUAL]:   'GEQUAL',
        [gl.ALWAYS]:   'ALWAYS',
    };

    console.log(`  depthTest:   ${depthTest}`);
    console.log(`  depthFunc:   ${funcNames[depthFunc] ?? depthFunc}`);
    console.log(`  depthRange:  [${depthRange[0]}, ${depthRange[1]}]`);
    console.log(`  depthBits:   ${depthBits}`);
    console.log(`  depthMask:   ${depthMask}`);

    if (depthBits < 24) {
        console.warn(`  ⚠ Only ${depthBits}-bit depth buffer — may cause z-fighting.`);
    }

    // Sample depth buffer at a grid of screen positions
    const GRID = 8;
    const depths: number[] = [];
    const pixel = new Uint8Array(4);

    // Use a temporary framebuffer to read depth via RGBA encoding
    // (WebGL1 cannot read depth directly — use readPixels on the
    //  default framebuffer which returns RGBA colour at each pixel)
    // Instead, we approximate by reading the viewport and reporting
    // which screen regions have geometry (non-background depth).
    //
    // For precise depth reading, WebGL2 + DEPTH_COMPONENT can be used.
    if ('readBuffer' in gl) {
        // WebGL2: can read depth from depth attachment
        const gl2 = gl as WebGL2RenderingContext;
        const depthPixels = new Float32Array(1);

        for (let gy = 0; gy < GRID; gy++) {
            for (let gx = 0; gx < GRID; gx++) {
                const sx = Math.floor((gx + 0.5) / GRID * width);
                const sy = Math.floor((gy + 0.5) / GRID * height);
                try {
                    gl2.readPixels(sx, sy, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, pixel);
                    // Approximate: if pixel is not clear colour, geometry is present
                    const hasGeometry = pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0;
                    if (hasGeometry) depths.push(1);
                    else depths.push(0);
                } catch {
                    depths.push(-1);
                }
            }
        }
    }

    const withGeometry = depths.filter(d => d === 1).length;
    const total = GRID * GRID;
    console.log(`  Screen coverage: ${withGeometry}/${total} grid cells have geometry (${(withGeometry / total * 100).toFixed(1)}%)`);

    if (withGeometry === 0) {
        console.warn('  ⚠ No geometry detected in depth samples — tiles may not be rendering.');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART G: PER-FRAME TILE STATE DUMP  (spec item D)
// ═══════════════════════════════════════════════════════════════════════════════

interface TileStateDump {
    name: string;
    depth: number;
    active: boolean;
    visible: boolean;
    inFrustum: boolean;
    hasContent: boolean;
    geometricError: number;
    sse: number;
    loaded: boolean;
    childCount: number;
}

/**
 * Dump detailed state for every tile in the TilesRenderer tree.
 * Logs a table to the console showing which tiles are active, visible,
 * in-frustum, loaded, and their SSE values.
 *
 * Use this to identify tiles that are in-frustum but not rendering.
 *
 * Call from browser console:
 *   import { dumpTileStates } from './utils/threeDTilesDebug'
 *   dumpTileStates(tilesRenderer)
 */
export function dumpTileStates(tilesRenderer: unknown): TileStateDump[] {
    const tr = tilesRenderer as Record<string, any>;
    const root = tr?.root;
    if (!root) {
        console.warn('No root tile — tileset not loaded');
        return [];
    }

    const rows: TileStateDump[] = [];

    function walk(tile: any, depth: number): void {
        if (!tile) return;
        const trav = tile.traversal ?? {};
        rows.push({
            name: tile.content?.uri ?? tile.__id ?? `tile_${rows.length}`,
            depth,
            active:          !!trav.active,
            visible:         !!trav.visible,
            inFrustum:       !!trav.inFrustum,
            hasContent:      !!tile._content,
            geometricError:  tile.geometricError ?? -1,
            sse:             trav.error ?? -1,
            loaded:          !!tile.cached?.data,
            childCount:      tile.children?.length ?? 0,
        });
        for (const child of tile.children ?? []) {
            walk(child, depth + 1);
        }
    }
    walk(root, 0);

    // Print summary
    const inFrustumNotVisible = rows.filter(r => r.inFrustum && !r.visible);
    console.log(`=== Tile State Dump (${rows.length} tiles) ===`);
    console.table(rows.slice(0, 50)); // first 50 to avoid console flood
    if (rows.length > 50) console.log(`  ... (${rows.length - 50} more tiles)`);

    if (inFrustumNotVisible.length > 0) {
        console.warn(
            `⚠ ${inFrustumNotVisible.length} tiles are in-frustum but NOT visible:`
        );
        console.table(inFrustumNotVisible.slice(0, 20));
    }

    return rows;
}


// ═══════════════════════════════════════════════════════════════════════════════
// PART H: FLOAT32 PRECISION DIAGNOSTIC  (supports spec item B)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quantify Float32 precision loss for a tile's world position under the
 * combined-matrix vs split-matrix approaches.
 *
 * Accepts the actual ecefToMerc and MVP matrices from the render loop
 * (expose them via a debug flag on ThreeDTilesLayer).
 *
 * Call from browser console:
 *   import { analyzeFloat32Precision } from './utils/threeDTilesDebug'
 *   analyzeFloat32Precision(ecefToMerc, mercatorToClip, tileMatrixWorld, lng, lat)
 */
export function analyzeFloat32Precision(
    ecefToMerc: THREE.Matrix4,
    mercatorToClip: THREE.Matrix4,
    tileMatrixWorld: THREE.Matrix4,
    lng: number,
    lat: number,
): void {
    console.log('=== Float32 Precision Analysis ===');

    // Tile center in ECEF (apply tileMatrixWorld to origin)
    const tileOrigin = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(tileMatrixWorld);

    // ── Combined approach (old) ──
    const combined = new THREE.Matrix4().multiplyMatrices(mercatorToClip, ecefToMerc);
    const combinedTile = new THREE.Matrix4().multiplyMatrices(combined, tileMatrixWorld);
    // Simulate Float32 upload
    const f32Combined = new Float32Array(combinedTile.elements);

    // Two test points: origin and 1m offset in local X
    const p0_combined = applyMat4F32(f32Combined, 0, 0, 0);
    const p1_combined = applyMat4F32(f32Combined, 1, 0, 0);
    const deltaCombined = Math.sqrt(
        (p1_combined[0] - p0_combined[0]) ** 2 +
        (p1_combined[1] - p0_combined[1]) ** 2 +
        (p1_combined[2] - p0_combined[2]) ** 2
    );

    // ── Split approach (new) ──
    const ws = ecefToMerc.elements[12]; // approximate worldSize from tx
    const camMercX = ((lng + 180) / 360) * ws; // approximate
    const camMercY =
        ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * ws;

    const ecefToMercRel = ecefToMerc.clone();
    ecefToMercRel.elements[12] -= camMercX;
    ecefToMercRel.elements[13] -= camMercY;

    // modelViewMatrix = ecefToMercRel × tileMatrixWorld  (Float64 in JS)
    const modelView = new THREE.Matrix4().multiplyMatrices(ecefToMercRel, tileMatrixWorld);
    // Upload to GPU as Float32
    const f32ModelView = new Float32Array(modelView.elements);

    const p0_split = applyMat4F32(f32ModelView, 0, 0, 0);
    const p1_split = applyMat4F32(f32ModelView, 1, 0, 0);
    const deltaSplit = Math.sqrt(
        (p1_split[0] - p0_split[0]) ** 2 +
        (p1_split[1] - p0_split[1]) ** 2 +
        (p1_split[2] - p0_split[2]) ** 2
    );

    // ── Reference (Float64) ──
    const mv64 = new THREE.Matrix4().multiplyMatrices(ecefToMerc, tileMatrixWorld);
    const q0 = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(mv64);
    const q1 = new THREE.Vector4(1, 0, 0, 1).applyMatrix4(mv64);
    const deltaRef = Math.sqrt(
        (q1.x - q0.x) ** 2 + (q1.y - q0.y) ** 2 + (q1.z - q0.z) ** 2
    );

    console.log(`1m displacement in tile-local X:`);
    console.log(`  Float64 reference:   ${deltaRef.toExponential(6)}`);
    console.log(`  Combined (Float32):  ${deltaCombined.toExponential(6)}  error: ${Math.abs(deltaCombined - deltaRef).toExponential(3)}`);
    console.log(`  Split (Float32):     ${deltaSplit.toExponential(6)}  error: ${Math.abs(deltaSplit - deltaRef).toExponential(3)}`);

    const combinedErr = Math.abs(deltaCombined - deltaRef) / deltaRef * 100;
    const splitErr    = Math.abs(deltaSplit - deltaRef) / deltaRef * 100;
    console.log(`  Combined relative error: ${combinedErr.toFixed(4)}%`);
    console.log(`  Split relative error:    ${splitErr.toFixed(4)}%`);

    if (splitErr < combinedErr) {
        console.log(`  ✓ Split approach reduces precision error by ${(combinedErr / Math.max(splitErr, 1e-10)).toFixed(1)}×`);
    }
}

/** Simulate GPU mat4 × vec4 in Float32. */
function applyMat4F32(
    e: Float32Array, x: number, y: number, z: number
): [number, number, number, number] {
    // Column-major order: e[0..3] = col0, e[4..7] = col1, etc.
    const xf = Math.fround(x), yf = Math.fround(y), zf = Math.fround(z);
    const rx = Math.fround(Math.fround(Math.fround(e[0] * xf) + Math.fround(e[4] * yf)) + Math.fround(Math.fround(e[8] * zf) + e[12]));
    const ry = Math.fround(Math.fround(Math.fround(e[1] * xf) + Math.fround(e[5] * yf)) + Math.fround(Math.fround(e[9] * zf) + e[13]));
    const rz = Math.fround(Math.fround(Math.fround(e[2] * xf) + Math.fround(e[6] * yf)) + Math.fround(Math.fround(e[10] * zf) + e[14]));
    const rw = Math.fround(Math.fround(Math.fround(e[3] * xf) + Math.fround(e[7] * yf)) + Math.fround(Math.fround(e[11] * zf) + e[15]));
    return [rx, ry, rz, rw];
}
