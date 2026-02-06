import proj4 from 'proj4';

// Define UTM Zone 50S projection (EPSG:32750)
proj4.defs('EPSG:32750', '+proj=utm +zone=50 +south +datum=WGS84 +units=m');

// Makassar OBJ model origin in UTM coordinates
export const OBJ_ORIGIN_UTM = {
  easting: 766627.93120060361,
  northing: 9430692.3957045767,
  elevation: 90.982521756022535
};

/**
 * Convert UTM Zone 50S coordinates to WGS84 (lng, lat)
 */
export function utmToWgs84(easting: number, northing: number): [number, number] {
  const [lng, lat] = proj4('EPSG:32750', 'WGS84', [easting, northing]);
  return [lng, lat];
}

/**
 * Get the center coordinates for the OBJ model in WGS84
 */
export function getObjCenterWgs84(): { lng: number; lat: number; elevation: number } {
  const [lng, lat] = utmToWgs84(OBJ_ORIGIN_UTM.easting, OBJ_ORIGIN_UTM.northing);
  return { lng, lat, elevation: OBJ_ORIGIN_UTM.elevation };
}

// Pre-calculated center for Makassar model
export const MAKASSAR_CENTER = getObjCenterWgs84();

/**
 * Web Mercator constants for coordinate conversion
 */
const EARTH_CIRCUMFERENCE = 40075016.686; // meters at equator
const HALF_EARTH = EARTH_CIRCUMFERENCE / 2;

/**
 * Convert longitude/latitude to Web Mercator meters
 */
export function lngLatToMercator(lng: number, lat: number): { x: number; y: number } {
  const x = (lng / 180) * HALF_EARTH;
  const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * (HALF_EARTH / Math.PI);
  return { x, y };
}

/**
 * Calculate the scale factor for a given latitude
 * The Mercator projection stretches distances as latitude increases
 */
export function getMercatorScale(lat: number): number {
  return 1 / Math.cos((lat * Math.PI) / 180);
}

/**
 * Convert meters at a given latitude to Mercator units
 */
export function metersToMercatorUnits(meters: number, lat: number): number {
  return meters * getMercatorScale(lat);
}
