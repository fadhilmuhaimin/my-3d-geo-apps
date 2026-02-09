import * as shapefile from 'shapefile';
import type { FeatureCollection, Geometry, Position } from 'geojson';
import proj4 from 'proj4';

export interface LoadedShapefile {
    featureCollection: FeatureCollection;
    bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
    fields: string[];
}

export async function loadShapefile(folder: string, basename: string, sourceProjection?: string): Promise<LoadedShapefile> {
    // Ensure properly encoded URLs to handle spaces and special chars
    const encodedFolder = folder.split('/').map(encodeURIComponent).join('/'); // carefully encode path segments if needed, but here usually folder is safe path.
    // Actually, folder path usually starts with / so split might create empty first element.
    // Safer:
    const safeBasename = encodeURIComponent(basename);
    const shpUrl = `${folder}/${safeBasename}.shp`;
    const dbfUrl = `${folder}/${safeBasename}.dbf`;

    try {
        const [shpRes, dbfRes] = await Promise.all([
            fetch(shpUrl),
            fetch(dbfUrl),
        ]);

        if (!shpRes.ok || !dbfRes.ok) {
            throw new Error(`Failed to fetch shapefile components for ${basename}`);
        }

        const shpBuffer = await shpRes.arrayBuffer();
        const dbfBuffer = await dbfRes.arrayBuffer();

        // Parse shapefile
        const geojson = await shapefile.read(shpBuffer, dbfBuffer) as FeatureCollection;

        // Reproject if sourceProjection is provided
        if (sourceProjection) {
            geojson.features.forEach(feature => {
                if (feature.geometry) {
                    reprojectGeometry(feature.geometry, sourceProjection);
                }
            });
        }

        // Calculate bbox and fields
        let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
        const fields = new Set<string>();

        geojson.features.forEach(feature => {
            // BBox calculation
            if (feature.geometry) {
                updateBBox(feature.geometry, (lng, lat) => {
                    if (lng < minLng) minLng = lng;
                    if (lng > maxLng) maxLng = lng;
                    if (lat < minLat) minLat = lat;
                    if (lat > maxLat) maxLat = lat;
                });
            }

            // Collect fields
            if (feature.properties) {
                Object.keys(feature.properties).forEach(key => fields.add(key));
            }
        });

        // Handle case where no geometry exists
        if (minLng > maxLng) {
            minLng = 0; maxLng = 0; minLat = 0; maxLat = 0;
        }

        return {
            featureCollection: geojson,
            bbox: [minLng, minLat, maxLng, maxLat],
            fields: Array.from(fields),
        };
    } catch (err) {
        console.error(`Error loading shapefile ${basename}:`, err);
        throw err;
    }
}

function reprojectGeometry(geometry: Geometry, sourceProjection: string) {
    const transform = (coords: Position): Position => {
        // proj4(from, to, coords)
        const [x, y] = coords;
        const [lng, lat] = proj4(sourceProjection, 'EPSG:4326', [x, y]);
        return [lng, lat];
    };

    if (geometry.type === 'Point') {
        geometry.coordinates = transform(geometry.coordinates);
    } else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
        geometry.coordinates = geometry.coordinates.map(transform);
    } else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
        geometry.coordinates = geometry.coordinates.map(ring => ring.map(transform));
    } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates = geometry.coordinates.map(poly => poly.map(ring => ring.map(transform)));
    }
}

function updateBBox(geometry: Geometry, callback: (lng: number, lat: number) => void) {
    if (geometry.type === 'Point') {
        callback(geometry.coordinates[0], geometry.coordinates[1]);
    } else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
        geometry.coordinates.forEach(coord => callback(coord[0], coord[1]));
    } else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
        geometry.coordinates.forEach(ring => ring.forEach(coord => callback(coord[0], coord[1])));
    } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(coord => callback(coord[0], coord[1]))));
    }
}
