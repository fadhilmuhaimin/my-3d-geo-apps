'use client';

import { useRef, useCallback, useEffect } from 'react';
import * as THREE from 'three';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { lngLatToMercator, MAKASSAR_CENTER } from '../utils/geoUtils';

interface UseMaplibreThreeOptions {
    map: MaplibreMap | null;
}

interface MaplibreThreeResult {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer | null;
    initializeRenderer: (canvas: HTMLCanvasElement, gl: WebGLRenderingContext) => void;
    updateCamera: () => void;
}

/**
 * Custom hook for synchronizing Three.js camera with MapLibre map
 * This enables 3D content to be rendered on top of the map with proper positioning
 */
export function useMaplibreThree({ map }: UseMaplibreThreeOptions): MaplibreThreeResult {
    const sceneRef = useRef<THREE.Scene>(new THREE.Scene());
    const cameraRef = useRef<THREE.PerspectiveCamera>(
        new THREE.PerspectiveCamera(75, 1, 0.1, 1e9)
    );
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

    // Initialize the WebGL renderer with MapLibre's canvas
    const initializeRenderer = useCallback(
        (canvas: HTMLCanvasElement, gl: WebGLRenderingContext) => {
            const renderer = new THREE.WebGLRenderer({
                canvas,
                context: gl,
                antialias: true,
                alpha: true,
            });
            renderer.autoClear = false;
            renderer.setPixelRatio(window.devicePixelRatio);
            rendererRef.current = renderer;
        },
        []
    );

    // Update Three.js camera to match MapLibre's view
    const updateCamera = useCallback(() => {
        if (!map) return;

        const camera = cameraRef.current;
        const canvas = map.getCanvas();

        // Update camera aspect ratio
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
        camera.updateProjectionMatrix();

        // Get map center in Mercator coordinates
        const center = map.getCenter();
        const mercatorCenter = lngLatToMercator(center.lng, center.lat);

        // Get the model center in Mercator coordinates
        const modelCenter = lngLatToMercator(MAKASSAR_CENTER.lng, MAKASSAR_CENTER.lat);

        // Calculate camera position based on map state
        const zoom = map.getZoom();
        const pitch = map.getPitch();
        const bearing = map.getBearing();

        // Scale factor based on zoom level
        // At zoom 0, the entire world fits in 512 pixels
        const scale = Math.pow(2, zoom);
        const worldSize = 512 * scale;
        const pixelsPerMeter = worldSize / 40075016.686; // Earth circumference

        // Calculate the offset from model center to camera center
        const offsetX = (mercatorCenter.x - modelCenter.x) * pixelsPerMeter;
        const offsetY = (modelCenter.y - mercatorCenter.y) * pixelsPerMeter;

        // Camera distance based on zoom and pitch
        const altitude = 1.5 / pixelsPerMeter;
        const pitchRad = (pitch * Math.PI) / 180;
        const bearingRad = (-bearing * Math.PI) / 180;

        // Calculate camera position
        const distance = altitude / Math.cos(pitchRad);
        const cameraX = offsetX + distance * Math.sin(pitchRad) * Math.sin(bearingRad);
        const cameraY = distance * Math.cos(pitchRad);
        const cameraZ = offsetY + distance * Math.sin(pitchRad) * Math.cos(bearingRad);

        camera.position.set(cameraX, cameraY, cameraZ);
        camera.lookAt(offsetX, 0, offsetY);

        // Apply bearing rotation
        camera.rotateZ(bearingRad);
    }, [map]);

    // Add lighting to the scene
    useEffect(() => {
        const scene = sceneRef.current;

        // Ambient light for overall illumination
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        // Directional light for shadows and depth
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(100, 200, 100);
        directionalLight.name = 'directionalLight';
        scene.add(directionalLight);

        // Hemisphere light for natural outdoor lighting
        const hemisphereLight = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.4);
        scene.add(hemisphereLight);

        return () => {
            scene.remove(ambientLight);
            scene.remove(directionalLight);
            scene.remove(hemisphereLight);
        };
    }, []);

    return {
        scene: sceneRef.current,
        camera: cameraRef.current,
        renderer: rendererRef.current,
        initializeRenderer,
        updateCamera,
    };
}
