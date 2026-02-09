export type DeviceProfile = 'low' | 'mid' | 'high';

export interface QualitySettings {
    maximumScreenSpaceError: number;
    maximumMemoryUsage: number;
    geometricErrorMultiplier: number;
    anisotropyLevel: number;
}

export const DEVICE_PROFILES: Record<DeviceProfile, QualitySettings> = {
    low: {
        maximumScreenSpaceError: 4,
        maximumMemoryUsage: 512, // 512MB
        geometricErrorMultiplier: 8, // Aggressive downsampling
        anisotropyLevel: 1, // Off
    },
    mid: {
        maximumScreenSpaceError: 2,
        maximumMemoryUsage: 1024, // 1GB
        geometricErrorMultiplier: 4,
        anisotropyLevel: 4,
    },
    high: {
        maximumScreenSpaceError: 1, // High detail
        maximumMemoryUsage: 2048, // 2GB
        geometricErrorMultiplier: 1, // Native quality
        anisotropyLevel: 16, // Max
    }
};

export function getDeviceProfile(): DeviceProfile {
    // Simple heuristic based on logical cores or user agent
    // In a real app, use @react-three/drei useDetectGPU or similar
    const concurrency = navigator.hardwareConcurrency || 4;

    if (concurrency >= 8) return 'high';
    if (concurrency >= 4) return 'mid';
    return 'low';
}
