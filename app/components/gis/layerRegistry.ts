export interface ShapefileLayerConfig {
    id: string;
    name: string; // Display name
    folder: string; // path relative to public, e.g., '/data/shp/delineasi'
    basename: string; // filename without extension
    geometryType: 'polygon' | 'line' | 'point';
    defaultVisible: boolean;
    defaultOpacity: number;
    color: [number, number, number, number]; // [r, g, b, a]
}

export const SHAPEFILE_LAYERS: ShapefileLayerConfig[] = [
    {
        id: 'delineasi',
        name: 'Delineasi',
        folder: '/data/shp/delineasi',
        basename: 'Delineasi',
        geometryType: 'polygon',
        defaultVisible: true,
        defaultOpacity: 0.5,
        color: [255, 0, 0, 128],
    },
    {
        id: 'pola-ruang-makassar',
        name: 'Pola Ruang Makassar',
        folder: '/data/shp/pola-ruang-makassar',
        basename: 'Pola Ruang Makassar',
        geometryType: 'polygon',
        defaultVisible: false,
        defaultOpacity: 0.6,
        color: [0, 255, 0, 150],
    },
    {
        id: 'sistem-jaringan-jalan',
        name: 'Sistem Jaringan Jalan',
        folder: '/data/shp/sistem-jaringan-jalan',
        basename: 'Sistem Jaringan Jalan',
        geometryType: 'line',
        defaultVisible: false,
        defaultOpacity: 1.0,
        color: [0, 0, 255, 255],
    },
    {
        id: 'rencana-jaringan-jalan',
        name: 'Rencana Jaringan Jalan',
        folder: '/data/shp/rencana-jaringan-jalan',
        basename: 'Rencana Jaringan Jalan',
        geometryType: 'line',
        defaultVisible: false,
        defaultOpacity: 1.0,
        color: [255, 165, 0, 255],
    },
];
