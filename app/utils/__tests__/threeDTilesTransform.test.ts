/**
 * Transform math unit tests for ThreeDTilesLayer.
 *
 * These tests verify the ECEF→Mercator matrix WITHOUT WebGL by
 * reimplementing the pure math functions (lngLatToECEF, buildEcefToMercatorMatrix)
 * using a minimal Matrix4 shim, since Three.js requires a DOM/WebGL context.
 *
 * Run:  bunx vitest run app/utils/__tests__/threeDTilesTransform.test.ts
 */
import { describe, it, expect } from 'vitest';

// ── WGS84 constants (must match threeDTilesLayer.ts) ─────────────────────────

const EARTH_CIRCUMFERENCE = 40_075_016.686;
const WGS84_A             = 6_378_137.0;
const WGS84_E2            = 0.006_694_379_990_14;

// ── Pure math reimplementations (no Three.js dependency) ─────────────────────

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

/** Minimal row-major 4×4 matrix for testing (no Three.js). */
type Mat4 = number[]; // 16 elements, row-major

function mat4Set(
    n11: number, n12: number, n13: number, n14: number,
    n21: number, n22: number, n23: number, n24: number,
    n31: number, n32: number, n33: number, n34: number,
    n41: number, n42: number, n43: number, n44: number,
): Mat4 {
    // Store in row-major order for readability
    return [
        n11, n12, n13, n14,
        n21, n22, n23, n24,
        n31, n32, n33, n34,
        n41, n42, n43, n44,
    ];
}

/** Multiply 4×4 row-major matrix by [x,y,z,1], return [x,y,z]. */
function mat4MulPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const w = m[12] * x + m[13] * y + m[14] * z + m[15];
    return [
        (m[0]  * x + m[1]  * y + m[2]  * z + m[3])  / w,
        (m[4]  * x + m[5]  * y + m[6]  * z + m[7])  / w,
        (m[8]  * x + m[9]  * y + m[10] * z + m[11]) / w,
    ];
}

function buildEcefToMercatorMatrix(
    lng0: number,
    lat0: number,
    altitudeOffset: number,
    worldSize: number,
): Mat4 {
    const λ    = (lng0 * Math.PI) / 180;
    const φ    = (lat0 * Math.PI) / 180;
    const sinλ = Math.sin(λ), cosλ = Math.cos(λ);
    const sinφ = Math.sin(φ), cosφ = Math.cos(φ);

    const Ex = -sinλ,        Ey =  cosλ,        Ez = 0;
    const Nx = -sinφ * cosλ, Ny = -sinφ * sinλ, Nz = cosφ;
    const Ux =  cosφ * cosλ, Uy =  cosφ * sinλ, Uz = sinφ;

    const sH = worldSize / (EARTH_CIRCUMFERENCE * cosφ);

    const [Cx, Cy, Cz] = lngLatToECEF(lng0, lat0, 0);

    const mx0 = (lng0 + 180) / 360;
    const my0 =
        (1 - Math.log(Math.tan(Math.PI / 4 + (lat0 * Math.PI) / 360)) / Math.PI) / 2;

    const tx =  mx0 * worldSize - sH * (Ex * Cx + Ey * Cy + Ez * Cz);
    const ty =  my0 * worldSize + sH * (Nx * Cx + Ny * Cy + Nz * Cz);
    const tz = -(Ux * Cx + Uy * Cy + Uz * Cz) + altitudeOffset;

    return mat4Set(
         sH * Ex,  sH * Ey,  sH * Ez,  tx,
        -sH * Nx, -sH * Ny, -sH * Nz,  ty,
              Ux,       Uy,       Uz,   tz,
              0,        0,        0,    1,
    );
}

// ── Test constants ───────────────────────────────────────────────────────────

const LNG = 119.41;
const LAT = -5.14;
const ZOOM_16_WS = 512 * Math.pow(2, 16); // 33_554_432
const ZOOM_20_WS = 512 * Math.pow(2, 20); // 536_870_912

const MX0 = (LNG + 180) / 360;
const MY0 =
    (1 - Math.log(Math.tan(Math.PI / 4 + (LAT * Math.PI) / 360)) / Math.PI) / 2;

// ══════════════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('lngLatToECEF', () => {
    it('produces coordinates with correct magnitude for WGS84', () => {
        const [x, y, z] = lngLatToECEF(LNG, LAT, 0);
        const r = Math.sqrt(x * x + y * y + z * z);
        // WGS84 radius is ~6378137 equatorial, ~6356752 polar
        expect(r).toBeGreaterThan(6_350_000);
        expect(r).toBeLessThan(6_400_000);
    });

    it('altitude shifts the radius linearly', () => {
        const [x0, y0, z0] = lngLatToECEF(LNG, LAT, 0);
        const [x1, y1, z1] = lngLatToECEF(LNG, LAT, 100);
        const r0 = Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0);
        const r1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
        expect(r1 - r0).toBeCloseTo(100, 0);
    });

    it('equator zero-meridian produces (a, 0, 0)', () => {
        const [x, y, z] = lngLatToECEF(0, 0, 0);
        expect(x).toBeCloseTo(WGS84_A, -1);
        expect(y).toBeCloseTo(0, 1);
        expect(z).toBeCloseTo(0, 1);
    });
});

describe('buildEcefToMercatorMatrix — center mapping', () => {
    it('maps ECEF center to (mx0*ws, my0*ws, 0) at zoom 16', () => {
        const M = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const [ox, oy, oz] = mat4MulPoint(M, Cx, Cy, Cz);

        expect(ox).toBeCloseTo(MX0 * ZOOM_16_WS, 0);
        expect(oy).toBeCloseTo(MY0 * ZOOM_16_WS, 0);
        expect(oz).toBeCloseTo(0, 1);
    });

    it('maps ECEF center to (mx0*ws, my0*ws, offset) when altitudeOffset=50', () => {
        const M = buildEcefToMercatorMatrix(LNG, LAT, 50, ZOOM_16_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const [, , oz] = mat4MulPoint(M, Cx, Cy, Cz);

        expect(oz).toBeCloseTo(50, 1);
    });
});

describe('buildEcefToMercatorMatrix — Z linearity', () => {
    it('100m altitude above center → Z delta = 100 metres', () => {
        const M = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const [Hx, Hy, Hz] = lngLatToECEF(LNG, LAT, 100);

        const [, , z0] = mat4MulPoint(M, Cx, Cy, Cz);
        const [, , z1] = mat4MulPoint(M, Hx, Hy, Hz);

        expect(z1 - z0).toBeCloseTo(100, 0);
    });

    it('Z delta scales linearly: 200m = 2 × 100m', () => {
        const M = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const [Hx1, Hy1, Hz1] = lngLatToECEF(LNG, LAT, 100);
        const [Hx2, Hy2, Hz2] = lngLatToECEF(LNG, LAT, 200);

        const [, , z0] = mat4MulPoint(M, Cx, Cy, Cz);
        const [, , z1] = mat4MulPoint(M, Hx1, Hy1, Hz1);
        const [, , z2] = mat4MulPoint(M, Hx2, Hy2, Hz2);

        const d1 = z1 - z0;
        const d2 = z2 - z0;
        expect(d2 / d1).toBeCloseTo(2.0, 2);
    });
});

describe('buildEcefToMercatorMatrix — Z zoom-independence', () => {
    it('Z delta for 100m altitude is identical at zoom 16 and zoom 20', () => {
        const M16 = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const M20 = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_20_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const [Hx, Hy, Hz] = lngLatToECEF(LNG, LAT, 100);

        const dz16 = mat4MulPoint(M16, Hx, Hy, Hz)[2] -
                     mat4MulPoint(M16, Cx, Cy, Cz)[2];
        const dz20 = mat4MulPoint(M20, Hx, Hy, Hz)[2] -
                     mat4MulPoint(M20, Cx, Cy, Cz)[2];

        expect(dz16).toBeCloseTo(100, 0);
        expect(dz20).toBeCloseTo(100, 0);
        expect(Math.abs(dz16 - dz20)).toBeLessThan(0.01);
    });

    it('X delta for 100m altitude DOES scale with worldSize (horizontal)', () => {
        // This confirms sH is proportional to worldSize — correct behavior
        const M16 = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const M20 = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_20_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);

        const φ = (LAT * Math.PI) / 180;
        // Approximate: 100m east
        const dLng = 100 / (111320 * Math.cos(φ));
        const [Ex, Ey, Ez] = lngLatToECEF(LNG + dLng, LAT, 0);

        const dx16 = mat4MulPoint(M16, Ex, Ey, Ez)[0] -
                     mat4MulPoint(M16, Cx, Cy, Cz)[0];
        const dx20 = mat4MulPoint(M20, Ex, Ey, Ez)[0] -
                     mat4MulPoint(M20, Cx, Cy, Cz)[0];

        // X should scale by worldSize ratio = 2^(20-16) = 16
        expect(dx20 / dx16).toBeCloseTo(16, 1);
    });
});

describe('buildEcefToMercatorMatrix — horizontal conformality', () => {
    it('100m east and 100m north produce equal-magnitude displacements', () => {
        const M = buildEcefToMercatorMatrix(LNG, LAT, 0, ZOOM_16_WS);
        const [Cx, Cy, Cz] = lngLatToECEF(LNG, LAT, 0);
        const φ = (LAT * Math.PI) / 180;

        // 100m east
        const dLng = 100 / (111320 * Math.cos(φ));
        const [Ex, Ey, Ez] = lngLatToECEF(LNG + dLng, LAT, 0);
        const pe = mat4MulPoint(M, Ex, Ey, Ez);
        const pc = mat4MulPoint(M, Cx, Cy, Cz);
        const dEast = Math.sqrt(
            (pe[0] - pc[0]) ** 2 + (pe[1] - pc[1]) ** 2
        );

        // ~100m north
        const dLat = 100 / 111320;
        const [Nx, Ny, Nz] = lngLatToECEF(LNG, LAT + dLat, 0);
        const pn = mat4MulPoint(M, Nx, Ny, Nz);
        const dNorth = Math.sqrt(
            (pn[0] - pc[0]) ** 2 + (pn[1] - pc[1]) ** 2
        );

        // Mercator is conformal: east and north scales should be equal
        expect(dEast / dNorth).toBeCloseTo(1.0, 1);
    });
});

describe('buildEcefToMercatorMatrix — ENU basis orthogonality', () => {
    it('E, N, U vectors are orthonormal', () => {
        const λ = (LNG * Math.PI) / 180;
        const φ = (LAT * Math.PI) / 180;
        const sinλ = Math.sin(λ), cosλ = Math.cos(λ);
        const sinφ = Math.sin(φ), cosφ = Math.cos(φ);

        const E = [-sinλ, cosλ, 0];
        const N = [-sinφ * cosλ, -sinφ * sinλ, cosφ];
        const U = [cosφ * cosλ, cosφ * sinλ, sinφ];

        const dot = (a: number[], b: number[]) =>
            a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const len = (a: number[]) => Math.sqrt(dot(a, a));

        expect(dot(E, N)).toBeCloseTo(0, 10);
        expect(dot(E, U)).toBeCloseTo(0, 10);
        expect(dot(N, U)).toBeCloseTo(0, 10);
        expect(len(E)).toBeCloseTo(1, 10);
        expect(len(N)).toBeCloseTo(1, 10);
        expect(len(U)).toBeCloseTo(1, 10);
    });
});

describe('buildEcefToMercatorMatrix — Mercator position formulas', () => {
    it('Mercator X for known longitudes', () => {
        expect((0 + 180) / 360).toBeCloseTo(0.5, 10);     // Greenwich
        expect((180 + 180) / 360).toBeCloseTo(1.0, 10);   // Dateline +
        expect((-180 + 180) / 360).toBeCloseTo(0.0, 10);  // Dateline -
    });

    it('Mercator Y for equator is 0.5', () => {
        const my0 = (1 - Math.log(Math.tan(Math.PI / 4 + 0)) / Math.PI) / 2;
        expect(my0).toBeCloseTo(0.5, 10);
    });
});

describe('buildEcefToMercatorMatrix — matrix row semantics', () => {
    it('Row 2 (Z) has no worldSize dependency', () => {
        // Verify the Z row coefficients don't contain worldSize
        const M1 = buildEcefToMercatorMatrix(LNG, LAT, 0, 1000);
        const M2 = buildEcefToMercatorMatrix(LNG, LAT, 0, 2000);

        // Row 2 elements: indices 8,9,10 (direction), 11 (translation Z)
        // Direction coefficients must be worldSize-independent
        expect(M1[8]).toBeCloseTo(M2[8], 10);   // Ux
        expect(M1[9]).toBeCloseTo(M2[9], 10);   // Uy
        expect(M1[10]).toBeCloseTo(M2[10], 10); // Uz

        // Translation also worldSize-independent (only depends on ECEF center + offset)
        expect(M1[11]).toBeCloseTo(M2[11], 5);
    });

    it('Rows 0,1 (X,Y) scale linearly with worldSize', () => {
        const M1 = buildEcefToMercatorMatrix(LNG, LAT, 0, 1000);
        const M2 = buildEcefToMercatorMatrix(LNG, LAT, 0, 2000);

        // Row 0,1 direction elements should scale 2×
        expect(M2[0] / M1[0]).toBeCloseTo(2.0, 5);  // sH * Ex
        expect(M2[4] / M1[4]).toBeCloseTo(2.0, 5);  // -sH * Nx
    });
});
