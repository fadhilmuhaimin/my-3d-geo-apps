'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import maplibregl, { Map as MaplibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';
import { DracoLoader } from '@loaders.gl/draco';
import { applyAnisotropyToTile } from '../utils/anisotropy';
import { DEVICE_PROFILES, getDeviceProfile } from '../utils/deviceProfile';
import { Feature } from 'geojson';

import LoadingIndicator from './LoadingIndicator';
import LeftPanel, { ViewMode } from './panels/LeftPanel';
import FeatureDetailPanel from './panels/FeatureDetailPanel';
import DataTableDrawer from './panels/DataTableDrawer';
import { useShapefileLayers, LayerState } from './gis/useShapefileLayers';
import { SHAPEFILE_LAYERS } from './gis/layerRegistry';
import { MAKASSAR_CENTER } from '../utils/geoUtils';
import styles from './MapViewer.module.css';

// Initial map view settings for Makassar
const INITIAL_VIEW = {
    center: [MAKASSAR_CENTER.lng, MAKASSAR_CENTER.lat] as [number, number],
    zoom: 16,
    pitch: 45,
    bearing: 0,
};

export default function MapViewer() {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MaplibreMap | null>(null);
    const deckOverlayRef = useRef<MapboxOverlay | null>(null);

    // App State
    const [viewMode, setViewMode] = useState<ViewMode>('3d');
    const [enable3DTiles, setEnable3DTiles] = useState(true);
    const [isLoading, setIsLoading] = useState(true);
    const [loadingProgress, setLoadingProgress] = useState(0);
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

    // Initial Map Setup
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
            // Initialize DeckGL overlay for 3D Tiles
            const deckOverlay = new MapboxOverlay({
                interleaved: true,
                layers: [], // Initially empty, controlled by effect
            });
            map.addControl(deckOverlay as unknown as maplibregl.IControl);
            deckOverlayRef.current = deckOverlay;

            setIsLoading(false);
            setLoadingMessage('');
        });

        // Map Click Handler for Features
        map.on('click', (e) => {
            // Only query if in shapefile mode or if we want to allow picking in 3D mode too?
            // Assuming simplified experience: picking works for visible vector layers.
            const visibleLayerIds = SHAPEFILE_LAYERS
                .map(l => l.id)
                .filter(id => map.getLayer(id)); // only if layer exists on map

            if (visibleLayerIds.length === 0) {
                setSelectedFeature(null);
                return;
            }

            const features = map.queryRenderedFeatures(e.point, { layers: visibleLayerIds });
            if (features.length > 0) {
                const feature = features[0];
                setSelectedFeature(feature);
                // Also set active layer to the one selected for context
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
            if (deckOverlayRef.current) {
                map.removeControl(deckOverlayRef.current as unknown as maplibregl.IControl);
            }
            map.remove();
        };
    }, []);

    // Mobile/Desktop tuning
    const deviceProfile = useMemo(() => DEVICE_PROFILES[getDeviceProfile()], []);

    // Manage 3D Tiles Logic
    const loadOptions = useMemo(() => ({
        tileset: {
            maximumScreenSpaceError: 0.75,   // lebih kecil = lebih detail
            viewDistanceScale: 0.25,         // lebih kecil = terasa lebih dekat
            geometricErrorMultiplier: 50,    // NAIKKAN besar (ini yang sering jadi kunci)
            refinementStrategy: 'best-available',

            // percepat refine
            throttleRequests: false,         // MATIKAN dulu untuk test
            maxRequests: 48,                 // naikin biar child tiles keburu masuk
            debounceTime: 0,

            maximumMemoryUsage: 3072,        // kalau desktop sanggup
            updateTransforms: false,
        },
        draco: { decoderType: 'js' },
    }), []);

    const subLayerProps = useMemo(() => ({
        scenegraph: {
            _lighting: 'flat', // Unlit mode for baked textures
            textureParameters: {
                // GL.TEXTURE_MIN_FILTER: GL.LINEAR_MIPMAP_LINEAR
                10241: 9987,
                // GL.TEXTURE_MAG_FILTER: GL.LINEAR
                10240: 9729,
                // GL.TEXTURE_WRAP_S: GL.CLAMP_TO_EDGE
                10242: 33071,
                // GL.TEXTURE_WRAP_T: GL.CLAMP_TO_EDGE
                10243: 33071,
            },
        },
    }), []);

    useEffect(() => {
        if (!deckOverlayRef.current) return;

        const layers = [];
        if (enable3DTiles) {
            const tile3DLayer = new Tile3DLayer({
                id: 'tile-3d-layer',
                data: `${window.location.origin}/terra_b3dms/tileset.json`,
                loaders: [Tiles3DLoader, DracoLoader],
                loadOptions: loadOptions,
                _subLayerProps: subLayerProps,
                onTileLoad: (tileHeader) => {
                    const content = tileHeader.content;
                    if (content && deckOverlayRef.current) {
                        const deck = (deckOverlayRef.current as any)._deck;
                        if (deck && deck.gl) {
                            applyAnisotropyToTile(content, deck.gl, deviceProfile.anisotropyLevel);
                        }
                    }
                    // Progressive loading feedback
                    setLoadingMessage(prev => {
                        const count = parseInt(prev.match(/\d+/)?.[0] || '0') + 1;
                        return `Loading 3D Tiles... (${count})`;
                    });
                },
                onTilesetLoad: () => {
                    // Only show loading if we are just enabling it or starting up
                    if (loadingProgress < 100) {
                        setLoadingProgress(100);
                        setLoadingMessage('3D Tiles loaded');
                        setTimeout(() => setLoadingMessage(''), 2000);
                    }
                },
                pointSize: 2,
                opacity: 1,
            });
            layers.push(tile3DLayer);
        }

        deckOverlayRef.current.setProps({ layers });
    }, [enable3DTiles, loadOptions, subLayerProps, loadingProgress, deviceProfile]); // Re-run when toggle changes

    // Manage Shapefile Layers on MapLibre
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
                    // Add Layer
                    if (config.geometryType === 'polygon') {
                        map.addLayer({
                            id: layerId,
                            type: 'fill',
                            source: sourceId,
                            paint: {
                                'fill-color': `rgba(${config.color[0]}, ${config.color[1]}, ${config.color[2]}, 1)`,
                                'fill-opacity': opacity,
                                'fill-outline-color': '#ffffff'
                            },
                        });
                        // Add Outline layer for better visibility
                        map.addLayer({
                            id: `${layerId}-outline`,
                            type: 'line',
                            source: sourceId,
                            paint: {
                                'line-color': '#ffffff',
                                'line-width': 1,
                                'line-opacity': opacity
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
                                'circle-stroke-color': '#ffffff'
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
    }, [layers]); // re-run when layer state changes

    const activeLayerFeatures = useMemo(() => {
        if (!activeLayerId || !layers[activeLayerId]?.data) return [];
        return layers[activeLayerId].data!.featureCollection.features;
    }, [activeLayerId, layers]);

    const handleZoomToFeature = (feature: Feature) => {
        if (!mapRef.current) return;

        // If feature has bbox (GeoJSON spec optional), use it
        if (feature.bbox) {
            mapRef.current.fitBounds(feature.bbox as [number, number, number, number], { padding: 50 });
            return;
        }

        // Fallback: Compute simplified bbox similar to loader or just fly to first coord
        // Use a simple centroid strategy for MVP
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

    return (
        <div className={styles.container}>
            <div ref={mapContainerRef} className={styles.map} />

            <LoadingIndicator
                isLoading={isLoading || Object.values(layers).some(l => l.loading)}
                progress={loadingProgress}
                message={
                    Object.values(layers).find(l => l.loading)
                        ? `Loading ${Object.values(layers).find(l => l.loading)?.config.name}...`
                        : loadingMessage
                }
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
