'use client';

import dynamic from 'next/dynamic';

// Dynamic import to prevent SSR issues with MapLibre and Three.js
const MapViewer = dynamic(() => import('./components/MapViewer'), {
  ssr: false,
  loading: () => (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      color: '#e0e0e0',
      fontFamily: 'system-ui, sans-serif'
    }}>
      Loading 3D Viewer...
    </div>
  ),
});

export default function Home() {
  return <MapViewer />;
}
