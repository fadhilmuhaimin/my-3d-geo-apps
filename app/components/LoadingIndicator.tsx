'use client';

import React from 'react';
import styles from './LoadingIndicator.module.css';

interface LoadingIndicatorProps {
    isLoading: boolean;
    progress?: number; // 0-100
    message?: string;
}

/**
 * Full-screen loading overlay with progress bar and status message
 * Used during map initialization and 3D model loading
 */
export default function LoadingIndicator({
    isLoading,
    progress = 0,
    message = 'Loading...',
}: LoadingIndicatorProps) {
    if (!isLoading) return null;

    return (
        <div className={styles.overlay}>
            <div className={styles.container}>
                {/* Animated spinner */}
                <div className={styles.spinner}>
                    <div className={styles.ring}></div>
                    <div className={styles.ring}></div>
                    <div className={styles.ring}></div>
                </div>

                {/* Status message */}
                <p className={styles.message}>{message}</p>

                {/* Progress bar */}
                {progress > 0 && (
                    <div className={styles.progressContainer}>
                        <div
                            className={styles.progressBar}
                            style={{ width: `${Math.min(100, progress)}%` }}
                        />
                        <span className={styles.progressText}>{Math.round(progress)}%</span>
                    </div>
                )}
            </div>
        </div>
    );
}
