import * as shapefile from 'shapefile';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export interface LoadedShapefile {
    featureCollection: FeatureCollection;
    bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
    fields: string[];
}

export async function loadShapefile(folder: string, basename: string): Promise<LoadedShapefile> {
    const shpUrl = `${folder}/${basename}.shp`;
    const dbfUrl = `${folder}/${basename}.dbf`;

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

        // Calculate bbox and fields
        let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
        const fields = new Set<string>();

        geojson.features.forEach(feature => {
            // BBox calculation (simplified for points/lines/polygons)
            // Note: A more robust implementation would use a library like @turf/bbox, 
            // but we'll do a simple coordinate scan here to avoid extra heavy deps if not needed.
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
