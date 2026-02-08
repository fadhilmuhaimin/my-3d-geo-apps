import React from 'react';
import { Feature } from 'geojson';
import styles from './FeatureDetailPanel.module.css';

interface FeatureDetailPanelProps {
    feature: Feature | null;
    onClose: () => void;
    onZoomToFeature?: (feature: Feature) => void;
}

export default function FeatureDetailPanel({
    feature,
    onClose,
    onZoomToFeature,
}: FeatureDetailPanelProps) {
    if (!feature) return null;

    const properties = feature.properties || {};

    return (
        <div className="fixed top-20 right-4 w-80 bg-white shadow-lg rounded-lg overflow-hidden z-50 flex flex-col max-h-[80vh]">
            <div className="bg-gray-100 p-3 border-b flex justify-between items-center">
                <h3 className="font-semibold text-gray-800">Feature Details</h3>
                <button
                    onClick={onClose}
                    className="text-gray-500 hover:text-gray-700 focus:outline-none"
                >
                    ✕
                </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
                <div className="space-y-2">
                    {Object.entries(properties).map(([key, value]) => (
                        <div key={key} className="border-b border-gray-100 pb-1 last:border-0">
                            <span className="block text-xs font-medium text-gray-500 uppercase">{key}</span>
                            <span className="block text-sm text-gray-800 break-words">
                                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                            </span>
                        </div>
                    ))}
                    {Object.keys(properties).length === 0 && (
                        <div className="text-gray-500 italic">No properties available</div>
                    )}
                </div>
            </div>

            <div className="bg-gray-50 p-3 border-t flex gap-2">
                {onZoomToFeature && (
                    <button
                        onClick={() => onZoomToFeature(feature)}
                        className="flex-1 bg-blue-600 text-white text-xs py-2 px-3 rounded hover:bg-blue-700 transition-colors"
                    >
                        Zoom to Feature
                    </button>
                )}
                <button
                    onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(feature, null, 2));
                        alert('Feature JSON copied to clipboard');
                    }}
                    className="flex-1 bg-gray-200 text-gray-800 text-xs py-2 px-3 rounded hover:bg-gray-300 transition-colors"
                >
                    Copy JSON
                </button>
            </div>
        </div>
    );
}
