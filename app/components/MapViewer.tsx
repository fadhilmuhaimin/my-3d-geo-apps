'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import maplibregl, { Map as MaplibreMap, MercatorCoordinate } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { Tiles3DLoader } from '@loaders.gl/3d-tiles';
import { OBJLoader as OBJLoaderGL } from '@loaders.gl/obj';

import LoadingIndicator from './LoadingIndicator';
import UIControls, { ViewMode } from './UIControls';
import { MAKASSAR_CENTER } from '../utils/geoUtils';
import styles from './MapViewer.module.css';

// Initial map view settings for Makassar
const INITIAL_VIEW = {
    center: [MAKASSAR_CENTER.lng, MAKASSAR_CENTER.lat] as [number, number],
    zoom: 17,
    pitch: 60,
    bearing: -20,
};

// Model center location (where the 3D model should be placed)
const MODEL_CENTER = {
    lng: MAKASSAR_CENTER.lng,
    lat: MAKASSAR_CENTER.lat,
    altitude: 0,
};

/**
 * Main component that integrates MapLibre GL JS with deck.gl for 3D Tiles
 * and Three.js for OBJ model rendering
 */
export default function MapViewer() {
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MaplibreMap | null>(null);
    const deckOverlayRef = useRef<MapboxOverlay | null>(null);


    const [isLoading, setIsLoading] = useState(true);
    const [loadingProgress, setLoadingProgress] = useState(0);
    const [loadingMessage, setLoadingMessage] = useState('Initializing map...');
    const [viewMode, setViewMode] = useState<ViewMode>('tiles');
    const [lightIntensity, setLightIntensity] = useState(1);

    // Reset view to initial position
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

    // Update lighting intensity
    const handleLightIntensityChange = useCallback((intensity: number) => {
        setLightIntensity(intensity);
        // Note: Lighting for deck.gl ScenegraphLayer is handled via _lighting prop or LightingEffect
    }, []);

    // Toggle between 3D Tiles and OBJ view
    const handleViewModeChange = useCallback((mode: ViewMode) => {
        setViewMode(mode);

        if (deckOverlayRef.current) {
            const layers = [];

            if (mode === 'tiles') {
                const tile3DLayer = new Tile3DLayer({
                    id: 'tile-3d-layer',
                    data: `${window.location.origin}/terra_b3dms/tileset.json`,
                    loader: Tiles3DLoader,
                    loadOptions: {
                        tileset: {
                            maximumScreenSpaceError: 1,
                        },
                    },
                    onTilesetLoad: () => {
                        setLoadingProgress(100);
                        setLoadingMessage('3D Tiles loaded!');
                    },
                    pointSize: 2,
                    opacity: 1,
                });
                layers.push(tile3DLayer);
            } else if (mode === 'obj') {
                const simpleMeshLayer = new SimpleMeshLayer({
                    id: 'obj-layer',
                    data: [
                        {
                            position: [MODEL_CENTER.lng, MODEL_CENTER.lat],
                            size: 1,
                            angle: 0,
                        },
                    ],
                    getPosition: (d: any) => d.position,
                    getOrientation: [0, 0, 0],
                    sizeScale: 1,
                    mesh: `${window.location.origin}/terra_obj/Block0/Block0.obj`,
                    loaders: [OBJLoaderGL],
                    texture: `${window.location.origin}/terra_obj/Block0/Block0_0_0.jpg`,
                    _lighting: 'pbr',
                    onDataLoad: () => {
                        setLoadingProgress(100);
                        setLoadingMessage('OBJ Model Loaded');
                    }
                });
                layers.push(simpleMeshLayer);
            }

            deckOverlayRef.current.setProps({ layers });
        }

        if (mapRef.current) {
            mapRef.current.triggerRepaint();
        }
    }, []);

    // Initialize map
    useEffect(() => {
        if (!mapContainerRef.current) return;



        // Create MapLibre map
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
                        maxzoom: 19, // Server limit
                    },
                },
                layers: [
                    {
                        id: 'background',
                        type: 'background',
                        paint: {
                            'background-color': '#f0f0f0',
                        },
                    },
                    {
                        id: 'osm',
                        type: 'raster',
                        source: 'osm',
                        minzoom: 0,
                        maxzoom: 24, // Allow overzoom beyond 19
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
            setLoadingMessage('Setting up 3D renderer...');
            setLoadingProgress(20);

            // Create deck.gl overlay for 3D Tiles
            const tile3DLayer = new Tile3DLayer({
                id: 'tile-3d-layer',
                data: `${window.location.origin}/terra_b3dms/tileset.json`,
                loader: Tiles3DLoader,
                loadOptions: {
                    tileset: {
                        maximumScreenSpaceError: 1,
                    },
                },
                onTilesetLoad: (tileset) => {
                    console.log('Tileset loaded:', tileset);
                    console.log('Tileset cartographicCenter:', tileset.cartographicCenter);
                    console.log('Tileset boundingVolume:', tileset.boundingVolume);

                    setLoadingProgress(100);
                    setLoadingMessage('3D Tiles loaded!');
                    setTimeout(() => setIsLoading(false), 500);
                },
                onTileLoad: (tile) => {
                    console.log('Tile loaded:', tile.id);
                },
                onTileError: (tile, url, error) => {
                    console.error('Tile error:', url, error);
                },
                pointSize: 2,
                opacity: 1,
            });

            const deckOverlay = new MapboxOverlay({
                interleaved: true,
                layers: [tile3DLayer],
            });

            map.addControl(deckOverlay as unknown as maplibregl.IControl);
            deckOverlayRef.current = deckOverlay;
        });

        map.addControl(new maplibregl.NavigationControl(), 'top-right');

        return () => {
            if (deckOverlayRef.current) {
                map.removeControl(deckOverlayRef.current as unknown as maplibregl.IControl);
            }
            map.remove();
        };
    }, []);

    return (
        <div className={styles.container}>
            <div ref={mapContainerRef} className={styles.map} />

            <LoadingIndicator
                isLoading={isLoading}
                progress={loadingProgress}
                message={loadingMessage}
            />

            <UIControls
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
                onResetView={handleResetView}
                lightIntensity={lightIntensity}
                onLightIntensityChange={handleLightIntensityChange}
                isLoading={isLoading}
            />
        </div>
    );
}
