import { useState, useCallback } from 'react';
import { SHAPEFILE_LAYERS, ShapefileLayerConfig } from './layerRegistry';
import { loadShapefile, LoadedShapefile } from './shapefileLoader';

export interface LayerState {
    config: ShapefileLayerConfig;
    visible: boolean;
    opacity: number;
    loading: boolean;
    loaded: boolean;
    error: string | null;
    data: LoadedShapefile | null;
}

export function useShapefileLayers() {
    const [layers, setLayers] = useState<Record<string, LayerState>>(() => {
        const initial: Record<string, LayerState> = {};
        SHAPEFILE_LAYERS.forEach(config => {
            initial[config.id] = {
                config,
                visible: config.defaultVisible,
                opacity: config.defaultOpacity,
                loading: false,
                loaded: false,
                error: null,
                data: null,
            };
        });
        return initial;
    });

    const toggleLayer = useCallback(async (layerId: string) => {
        setLayers(prev => {
            const layer = prev[layerId];
            if (!layer) return prev;

            const nextVisible = !layer.visible;
            const newState = { ...prev, [layerId]: { ...layer, visible: nextVisible } };

            // If turning on and not loaded or loading, trigger load
            if (nextVisible && !layer.loaded && !layer.loading) {
                // Trigger load side effect (we need to be careful with state updates in async)
                // We'll return the state change first, then load
                loadLayerData(layerId);
            }

            return newState;
        });
    }, []); // layer loading function is separate to avoid strict deps issues

    const loadLayerData = async (layerId: string) => {
        // Set loading true
        setLayers(prev => ({
            ...prev,
            [layerId]: { ...prev[layerId], loading: true, error: null }
        }));

        const layerConfig = SHAPEFILE_LAYERS.find(l => l.id === layerId);
        if (!layerConfig) return;

        try {
            const data = await loadShapefile(layerConfig.folder, layerConfig.basename);

            setLayers(prev => ({
                ...prev,
                [layerId]: {
                    ...prev[layerId],
                    loading: false,
                    loaded: true,
                    data
                }
            }));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            setLayers(prev => ({
                ...prev,
                [layerId]: {
                    ...prev[layerId],
                    loading: false,
                    error: errorMessage
                }
            }));
        }
    };

    const setLayerOpacity = useCallback((layerId: string, opacity: number) => {
        setLayers(prev => ({
            ...prev,
            [layerId]: { ...prev[layerId], opacity }
        }));
    }, []);

    return {
        layers,
        toggleLayer,
        setLayerOpacity,
    };
}
