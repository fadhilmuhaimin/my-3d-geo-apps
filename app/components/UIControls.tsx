'use client';

import React from 'react';
import styles from './UIControls.module.css';

export type ViewMode = 'tiles' | 'obj';

interface UIControlsProps {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    onResetView: () => void;
    lightIntensity: number;
    onLightIntensityChange: (intensity: number) => void;
    isLoading: boolean;
}

/**
 * Control panel for the 3D viewer
 * Provides toggle between 3D Tiles and OBJ views, reset button, and lighting controls
 */
export default function UIControls({
    viewMode,
    onViewModeChange,
    onResetView,
    lightIntensity,
    onLightIntensityChange,
    isLoading,
}: UIControlsProps) {
    return (
        <div className={styles.container}>
            <div className={styles.panel}>
                {/* Header */}
                <div className={styles.header}>
                    <h2 className={styles.title}>🏙️ Makassar 3D</h2>
                    <span className={styles.subtitle}>Building Visualization</span>
                </div>

                {/* View mode toggle */}
                <div className={styles.section}>
                    <label className={styles.label}>View Mode</label>
                    <div className={styles.toggleGroup}>
                        <button
                            className={`${styles.toggleBtn} ${viewMode === 'tiles' ? styles.active : ''}`}
                            onClick={() => onViewModeChange('tiles')}
                            disabled={isLoading}
                        >
                            <span className={styles.icon}>🧊</span>
                            3D Tiles
                        </button>
                        <button
                            className={`${styles.toggleBtn} ${viewMode === 'obj' ? styles.active : ''}`}
                            onClick={() => onViewModeChange('obj')}
                            disabled={isLoading}
                        >
                            <span className={styles.icon}>📦</span>
                            OBJ Model
                        </button>
                    </div>
                </div>

                {/* Lighting control */}
                <div className={styles.section}>
                    <label className={styles.label}>
                        Lighting Intensity
                        <span className={styles.value}>{Math.round(lightIntensity * 100)}%</span>
                    </label>
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

                {/* Reset view button */}
                <button
                    className={styles.resetBtn}
                    onClick={onResetView}
                    disabled={isLoading}
                >
                    <span className={styles.icon}>🔄</span>
                    Reset View
                </button>

                {/* Info section */}
                <div className={styles.info}>
                    <p>📍 Location: Makassar, Indonesia</p>
                    <p>🛸 Data: DJI Drone Scan</p>
                </div>
            </div>
        </div>
    );
}
