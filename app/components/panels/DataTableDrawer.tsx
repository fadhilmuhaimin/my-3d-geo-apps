import React, { useState, useMemo } from 'react';
import { Feature } from 'geojson';
import { SHAPEFILE_LAYERS } from '../gis/layerRegistry';

interface DataTableDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    activeLayerId: string | null;
    features: Feature[];
    onRowClick: (feature: Feature) => void;
}

const ITEMS_PER_PAGE = 50;

export default function DataTableDrawer({
    isOpen,
    onClose,
    activeLayerId,
    features,
    onRowClick,
}: DataTableDrawerProps) {
    const [currentPage, setCurrentPage] = useState(1);
    const [filterText, setFilterText] = useState('');

    // Reset pagination when layer changes
    React.useEffect(() => {
        setCurrentPage(1);
        setFilterText('');
    }, [activeLayerId]);

    const layerName = useMemo(() => {
        return SHAPEFILE_LAYERS.find(l => l.id === activeLayerId)?.name || 'Unknown Layer';
    }, [activeLayerId]);

    // Derive columns from the first few features
    const columns = useMemo(() => {
        if (!features.length) return [];
        const allKeys = new Set<string>();
        // Check first 10 features to get a representable set of keys
        features.slice(0, 10).forEach(f => {
            if (f.properties) {
                Object.keys(f.properties).forEach(k => allKeys.add(k));
            }
        });
        return Array.from(allKeys);
    }, [features]);

    // Filter features
    const filteredFeatures = useMemo(() => {
        if (!filterText) return features;
        const lowerFilter = filterText.toLowerCase();
        return features.filter(f => {
            if (!f.properties) return false;
            return Object.values(f.properties).some(val =>
                String(val).toLowerCase().includes(lowerFilter)
            );
        });
    }, [features, filterText]);

    // Pagination
    const totalPages = Math.ceil(filteredFeatures.length / ITEMS_PER_PAGE);
    const paginatedFeatures = useMemo(() => {
        const start = (currentPage - 1) * ITEMS_PER_PAGE;
        return filteredFeatures.slice(start, start + ITEMS_PER_PAGE);
    }, [filteredFeatures, currentPage]);

    if (!isOpen) return null;

    return (
        <div className="fixed bottom-0 left-0 right-0 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-40 flex flex-col h-[40vh] transition-transform duration-300 ease-in-out transform border-t border-gray-200">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-4">
                    <h3 className="font-bold text-gray-700">{layerName}</h3>
                    <span className="text-sm text-gray-500">
                        {filteredFeatures.length.toLocaleString()} features
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        placeholder="Search all fields..."
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                        className="px-3 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-gray-200 rounded text-gray-500"
                    >
                        Close ✕
                    </button>
                </div>
            </div>

            {/* Table Content */}
            <div className="flex-1 overflow-auto">
                <table className="min-w-full text-sm text-left text-gray-600">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-50 sticky top-0">
                        <tr>
                            {columns.map(col => (
                                <th key={col} className="px-4 py-2 border-b whitespace-nowrap">
                                    {col}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {paginatedFeatures.map((feature, idx) => (
                            <tr
                                key={idx}
                                onClick={() => onRowClick(feature)}
                                className="bg-white border-b hover:bg-blue-50 cursor-pointer transition-colors"
                            >
                                {columns.map(col => (
                                    <td key={col} className="px-4 py-2 border-b max-w-xs truncate" title={String(feature.properties?.[col])}>
                                        {String(feature.properties?.[col] ?? '')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                        {paginatedFeatures.length === 0 && (
                            <tr>
                                <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">
                                    No features found
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination Footer */}
            <div className="p-2 border-t border-gray-200 bg-gray-50 flex justify-between items-center text-sm">
                <div className="text-gray-500">
                    Page {currentPage} of {totalPages || 1}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="px-3 py-1 border rounded disabled:opacity-50 hover:bg-gray-100"
                    >
                        Previous
                    </button>
                    <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage >= totalPages}
                        className="px-3 py-1 border rounded disabled:opacity-50 hover:bg-gray-100"
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
}
