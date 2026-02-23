'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import maplibregl, { Map as MaplibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Feature } from 'geojson';

import LoadingIndicator from './LoadingIndicator';
import LeftPanel, { ViewMode } from './panels/LeftPanel';
import FeatureDetailPanel from './panels/FeatureDetailPanel';
import DataTableDrawer from './panels/DataTableDrawer';
import { useShapefileLayers, LayerState } from './gis/useShapefileLayers';
import { SHAPEFILE_LAYERS } from './gis/layerRegistry';
import { MAKASSAR_CENTER } from '../utils/geoUtils';
import { ThreeDTilesLayer } from '../utils/threeDTilesLayer';
import styles from './MapViewer.module.css';

// Initial map view settings for Makassar
const INITIAL_VIEW = {
    center: [MAKASSAR_CENTER.lng, MAKASSAR_CENTER.lat] as [number, number],
    zoom: 16,
    pitch: 45,
    bearing: 0,
};

const TILES_LAYER_ID = 'three-d-tiles-layer';

export default function MapViewer() {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MaplibreMap | null>(null);
    const tilesLayerRef = useRef<ThreeDTilesLayer | null>(null);

    // App State
    const [viewMode, setViewMode] = useState<ViewMode>('3d');
    const [enable3DTiles, setEnable3DTiles] = useState(true);
    const [isLoading, setIsLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState('Initializing map...');
    const [lightIntensity, setLightIntensity] = useState(1);

    // GIS State
    const { layers, toggleLayer, setLayerOpacity } = useShapefileLayers();
    const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
    const [selectedFeature, setSelectedFeature] = useState<Feature | null>(null);
    const [isDataTableOpen, setIsDataTableOpen] = useState(false);

    // Reset view
    const handleResetView = useCallback(() => {
        if (mapRef.current) {
            mapRef.current.flyTo({
                center: INITIAL_VIEW.center,
                zoom: INITIAL_VIEW.zoom,
                pitch: INITIAL_VIEW.pitch,
                bearing: INITIAL_VIEW.bearing,
                duration: 1500,
            });
        }
    }, []);

    // ── Initial Map Setup ──────────────────────────────────────────────────────
    useEffect(() => {
        if (!mapContainerRef.current) return;

        const map = new maplibregl.Map({
            container: mapContainerRef.current,
            style: {
                version: 8,
                sources: {
                    osm: {
                        type: 'raster',
                        tiles: [
                            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
                            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
                            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                        ],
                        tileSize: 256,
                        attribution: '© OpenStreetMap contributors',
                        maxzoom: 19,
                    },
                },
                layers: [
                    {
                        id: 'background',
                        type: 'background',
                        paint: { 'background-color': '#f0f0f0' },
                    },
                    {
                        id: 'osm',
                        type: 'raster',
                        source: 'osm',
                        minzoom: 0,
                        maxzoom: 24,
                    },
                ],
            },
            center: INITIAL_VIEW.center,
            zoom: INITIAL_VIEW.zoom,
            pitch: INITIAL_VIEW.pitch,
            bearing: INITIAL_VIEW.bearing,
        });

        mapRef.current = map;

        map.on('load', () => {
            // ── Add 3D Tiles as a MapLibre Custom Layer ────────────────────────
            // ThreeDTilesLayer uses 3d-tiles-renderer (NASA/JPL) + Three.js,
            // sharing MapLibre's existing WebGL context.  errorTarget = 0 forces
            // the finest available LOD tiles to load progressively, and each
            // loaded tile triggers triggerRepaint() so the canvas updates without
            // any user interaction.
            const tilesetUrl = `${window.location.origin}/terra_b3dms/tileset.json`;
            // altitudeOffset (metres): raise the model above MSL if tiles appear
            // underground.  Increase in 10–50 m steps until visible, then tune.
            const tilesLayer = new ThreeDTilesLayer(
                TILES_LAYER_ID,
                tilesetUrl,
                MAKASSAR_CENTER.lng,
                MAKASSAR_CENTER.lat,
                0   // ← altitudeOffset in metres; increase if model underground
            );
            tilesLayerRef.current = tilesLayer;
            map.addLayer(tilesLayer as unknown as maplibregl.CustomLayerInterface);

            setIsLoading(false);
            setLoadingMessage('');
        });

        // Map Click Handler for Features
        map.on('click', (e) => {
            const visibleLayerIds = SHAPEFILE_LAYERS
                .map(l => l.id)
                .filter(id => map.getLayer(id));

            if (visibleLayerIds.length === 0) {
                setSelectedFeature(null);
                return;
            }

            const features = map.queryRenderedFeatures(e.point, { layers: visibleLayerIds });
            if (features.length > 0) {
                const feature = features[0];
                setSelectedFeature(feature);
                const layerId = feature.layer.id;
                setActiveLayerId(layerId);
            } else {
                setSelectedFeature(null);
            }
        });

        // Add cursor pointer for features
        map.on('mousemove', (e) => {
            const visibleLayerIds = SHAPEFILE_LAYERS
                .map(l => l.id)
                .filter(id => map.getLayer(id));

            if (visibleLayerIds.length > 0) {
                const features = map.queryRenderedFeatures(e.point, { layers: visibleLayerIds });
                map.getCanvas().style.cursor = features.length ? 'pointer' : '';
            }
        });

        map.addControl(new maplibregl.NavigationControl(), 'top-right');

        return () => {
            tilesLayerRef.current = null;
            map.remove();
        };
    }, []);

    // ── Toggle 3D Tiles visibility ─────────────────────────────────────────────
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;
        if (!map.getLayer(TILES_LAYER_ID)) return;

        map.setLayoutProperty(
            TILES_LAYER_ID,
            'visibility',
            enable3DTiles ? 'visible' : 'none'
        );
    }, [enable3DTiles]);

    // ── Manage Shapefile Layers on MapLibre ────────────────────────────────────
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !map.isStyleLoaded()) return;

        Object.values(layers).forEach((layerState: LayerState) => {
            const { config, visible, loaded, data, opacity } = layerState;
            const sourceId = `source-${config.id}`;
            const layerId = config.id;

            // 1. Add Source if loaded and missing
            if (loaded && data && !map.getSource(sourceId)) {
                map.addSource(sourceId, {
                    type: 'geojson',
                    data: data.featureCollection,
                });
            }

            // 2. Add/Update Layer
            const layerExists = !!map.getLayer(layerId);

            if (visible && loaded && data) {
                if (!layerExists) {
                    if (config.geometryType === 'polygon') {
                        map.addLayer({
                            id: layerId,
                            type: 'fill',
                            source: sourceId,
                            paint: {
                                'fill-color': `rgba(${config.color[0]}, ${config.color[1]}, ${config.color[2]}, 1)`,
                                'fill-opacity': opacity,
                                'fill-outline-color': '#ffffff',
                            },
                        });
                        map.addLayer({
                            id: `${layerId}-outline`,
                            type: 'line',
                            source: sourceId,
                            paint: {
                                'line-color': '#ffffff',
                                'line-width': 1,
                                'line-opacity': opacity,
                            },
                        });
                    } else if (config.geometryType === 'line') {
                        map.addLayer({
                            id: layerId,
                            type: 'line',
                            source: sourceId,
                            paint: {
                                'line-color': `rgba(${config.color[0]}, ${config.color[1]}, ${config.color[2]}, 1)`,
                                'line-width': 2,
                                'line-opacity': opacity,
                            },
                        });
                    } else if (config.geometryType === 'point') {
                        map.addLayer({
                            id: layerId,
                            type: 'circle',
                            source: sourceId,
                            paint: {
                                'circle-color': `rgba(${config.color[0]}, ${config.color[1]}, ${config.color[2]}, 1)`,
                                'circle-radius': 5,
                                'circle-opacity': opacity,
                                'circle-stroke-width': 1,
                                'circle-stroke-color': '#ffffff',
                            },
                        });
                    }
                } else {
                    // Update Paint Properties
                    if (config.geometryType === 'polygon') {
                        map.setPaintProperty(layerId, 'fill-opacity', opacity);
                        if (map.getLayer(`${layerId}-outline`)) {
                            map.setPaintProperty(`${layerId}-outline`, 'line-opacity', opacity);
                        }
                    } else if (config.geometryType === 'line') {
                        map.setPaintProperty(layerId, 'line-opacity', opacity);
                    } else if (config.geometryType === 'point') {
                        map.setPaintProperty(layerId, 'circle-opacity', opacity);
                        map.setPaintProperty(layerId, 'circle-stroke-opacity', opacity);
                    }
                }
            } else if (!visible && layerExists) {
                map.removeLayer(layerId);
                if (map.getLayer(`${layerId}-outline`)) map.removeLayer(`${layerId}-outline`);
            }
        });
    }, [layers]);

    const activeLayerFeatures = useMemo(() => {
        if (!activeLayerId || !layers[activeLayerId]?.data) return [];
        return layers[activeLayerId].data!.featureCollection.features;
    }, [activeLayerId, layers]);

    const handleZoomToFeature = (feature: Feature) => {
        if (!mapRef.current) return;

        if (feature.bbox) {
            mapRef.current.fitBounds(feature.bbox as [number, number, number, number], { padding: 50 });
            return;
        }

        let center: [number, number] | null = null;

        if (feature.geometry.type === 'Point') {
            center = feature.geometry.coordinates as [number, number];
        } else if (feature.geometry.type === 'Polygon') {
            center = feature.geometry.coordinates[0][0] as [number, number];
        } else if (feature.geometry.type === 'MultiPolygon') {
            center = feature.geometry.coordinates[0][0][0] as [number, number];
        } else if (feature.geometry.type === 'LineString') {
            center = feature.geometry.coordinates[0] as [number, number];
        }

        if (center) {
            mapRef.current.flyTo({ center, zoom: 18 });
        }
    };

    const handleRowClick = (feature: Feature) => {
        setSelectedFeature(feature);
        handleZoomToFeature(feature);
    };

    // ── Derive loading indicator state ─────────────────────────────────────────
    const shapefileLoading = Object.values(layers).find(l => l.loading);
    const showLoading = isLoading || !!shapefileLoading;
    const displayMessage = shapefileLoading
        ? `Loading ${shapefileLoading.config.name}...`
        : loadingMessage;

    return (
        <div className={styles.container}>
            <div ref={mapContainerRef} className={styles.map} />

            <LoadingIndicator
                isLoading={showLoading}
                progress={0}
                message={displayMessage}
            />

            <LeftPanel
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                enable3DTiles={enable3DTiles}
                onEnable3DTilesChange={setEnable3DTiles}
                layers={layers}
                onToggleLayer={toggleLayer}
                onLayerOpacityChange={setLayerOpacity}
                activeLayerId={activeLayerId}
                onSetActiveLayer={setActiveLayerId}
                onOpenDataTable={() => setIsDataTableOpen(true)}
                onResetView={handleResetView}
                lightIntensity={lightIntensity}
                onLightIntensityChange={setLightIntensity}
            />

            <FeatureDetailPanel
                feature={selectedFeature}
                onClose={() => setSelectedFeature(null)}
                onZoomToFeature={handleZoomToFeature}
            />

            <DataTableDrawer
                isOpen={isDataTableOpen}
                onClose={() => setIsDataTableOpen(false)}
                activeLayerId={activeLayerId}
                features={activeLayerFeatures}
                onRowClick={handleRowClick}
            />
        </div>
    );
}
