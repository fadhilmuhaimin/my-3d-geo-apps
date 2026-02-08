import React, { useState } from 'react';
import { LayerState } from '../gis/useShapefileLayers';
import styles from './LeftPanel.module.css';

export type ViewMode = '3d' | 'shapefile';

interface LeftPanelProps {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    enable3DTiles: boolean;
    onEnable3DTilesChange: (enabled: boolean) => void;
    layers: Record<string, LayerState>;
    onToggleLayer: (layerId: string) => void;
    onLayerOpacityChange: (layerId: string, opacity: number) => void;
    activeLayerId: string | null;
    onSetActiveLayer: (layerId: string | null) => void;
    onOpenDataTable: () => void;
    onResetView: () => void;
    lightIntensity: number;
    onLightIntensityChange: (intensity: number) => void;
}

export default function LeftPanel({
    viewMode,
    onViewModeChange,
    enable3DTiles,
    onEnable3DTilesChange,
    layers,
    onToggleLayer,
    onLayerOpacityChange,
    activeLayerId,
    onSetActiveLayer,
    onOpenDataTable,
    onResetView,
    lightIntensity,
    onLightIntensityChange,
}: LeftPanelProps) {
    const [isCollapsed, setIsCollapsed] = useState(false);

    if (isCollapsed) {
        return (
            <div className={styles.container}>
                <button
                    onClick={() => setIsCollapsed(false)}
                    className={styles.expandBtn}
                    title="Expand Panel"
                >
                    ☰
                </button>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.panel}>

                {/* Header */}
                <div className={styles.header}>
                    <div>
                        <h2 className={styles.title}>Makassar Geo</h2>
                        <span className={styles.subtitle}>Spatial Visualization System</span>
                    </div>
                    <button
                        onClick={() => setIsCollapsed(true)}
                        className={styles.collapseBtn}
                        title="Collapse"
                    >
                        ◀
                    </button>
                </div>

                {/* Scrollable Content */}
                <div className={styles.scrollContent}>

                    {/* Mode Toggles */}
                    <div className={styles.section}>
                        <label className={styles.label}>View Mode</label>
                        <div className={styles.toggleGroup}>
                            <button
                                className={`${styles.modeBtn} ${viewMode === '3d' ? styles.active : ''}`}
                                onClick={() => onViewModeChange('3d')}
                            >
                                3D View
                            </button>
                            <button
                                className={`${styles.modeBtn} ${viewMode === 'shapefile' ? styles.active : ''}`}
                                onClick={() => onViewModeChange('shapefile')}
                            >
                                Shapefiles
                            </button>
                        </div>
                    </div>

                    {/* Global 3D Tiles Toggle */}
                    <div className={styles.section}>
                        <div className={styles.toggleSwitch}>
                            <span className={styles.switchLabel}>Enable 3D Tiles</span>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={enable3DTiles}
                                    onChange={(e) => onEnable3DTilesChange(e.target.checked)}
                                    className="sr-only peer"
                                />
                                <div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-500"></div>
                            </label>
                        </div>
                    </div>

                    {/* Mode Specific Controls */}
                    {viewMode === 'shapefile' && (
                        <div className={styles.section}>
                            <label className={styles.label}>Layers</label>
                            <div className="space-y-2">
                                {Object.values(layers).map((layer) => (
                                    <div key={layer.config.id} className={styles.layerItem}>

                                        {/* Layer Header */}
                                        <div className={styles.layerHeader}>
                                            <label className={styles.layerCheckbox}>
                                                <input
                                                    type="checkbox"
                                                    checked={layer.visible}
                                                    onChange={() => onToggleLayer(layer.config.id)}
                                                    className={styles.checkboxInput}
                                                />
                                                <span className={`${styles.layerName} ${!layer.visible ? styles.inactive : ''}`}>
                                                    {layer.config.name}
                                                </span>
                                            </label>
                                            {layer.loading && <span className={styles.loadingText}>Loading...</span>}
                                            {layer.error && <span className={styles.errorText}>Error</span>}
                                        </div>

                                        {/* Layer Controls (only if visible) */}
                                        {layer.visible && (
                                            <div className={styles.layerControls}>
                                                {/* Opacity Slider */}
                                                <div className={styles.opacityControl}>
                                                    <span className={styles.opacityLabel}>Op</span>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max="1"
                                                        step="0.1"
                                                        value={layer.opacity}
                                                        onChange={(e) => onLayerOpacityChange(layer.config.id, parseFloat(e.target.value))}
                                                        className={styles.slider}
                                                    />
                                                </div>

                                                {/* Data Table Button */}
                                                <button
                                                    onClick={() => {
                                                        onSetActiveLayer(layer.config.id);
                                                        if (layer.loaded) onOpenDataTable();
                                                    }}
                                                    disabled={!layer.loaded}
                                                    className={`${styles.dataTableBtn} ${activeLayerId === layer.config.id ? styles.active : ''}`}
                                                >
                                                    Data Table
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {viewMode === '3d' && (
                        <div className={styles.section}>
                            <label className={styles.label}>Environment</label>
                            <div className="space-y-4">
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <span className="text-xs text-slate-400">Light Intensity</span>
                                        <span className={styles.value}>{Math.round(lightIntensity * 100)}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0"
                                        max="2"
                                        step="0.1"
                                        value={lightIntensity}
                                        onChange={(e) => onLightIntensityChange(parseFloat(e.target.value))}
                                        className={styles.slider}
                                    />
                                </div>
                                <button
                                    onClick={onResetView}
                                    className={styles.resetBtn}
                                >
                                    <span>🔄</span> Reset Camera View
                                </button>
                            </div>
                        </div>
                    )}

                </div>

                {/* Footer */}
                <div className={styles.footer}>
                    v2.0 • Shapefile Support
                </div>
            </div>
        </div>
    );
}
