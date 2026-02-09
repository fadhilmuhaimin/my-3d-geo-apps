import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { execSync } from 'child_process';

// Configuration
const INPUT_DIR = 'public/terra_b3dms';
const OUTPUT_DIR = 'public/terra_optimized';

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log(`🚀 Starting optimization: ${INPUT_DIR} -> ${OUTPUT_DIR}`);

// Helper to process directory recursively
function processDirectory(currentPath: string, relativePath: string = '') {
    const files = readdirSync(currentPath);

    for (const file of files) {
        const fullPath = join(currentPath, file);
        const fileRelativePath = join(relativePath, file);
        const outputPath = join(OUTPUT_DIR, fileRelativePath);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
            if (!existsSync(outputPath)) {
                mkdirSync(outputPath, { recursive: true });
            }
            processDirectory(fullPath, fileRelativePath);
        } else {
            processFile(fullPath, outputPath);
        }
    }
}

function processFile(inputPath: string, outputPath: string) {
    const ext = extname(inputPath).toLowerCase();

    // Copy non-b3dm files directly
    if (ext !== '.b3dm') {
        copyFileSync(inputPath, outputPath);
        return;
    }

    // Process B3DM
    console.log(`📦 Optimizing: ${basename(inputPath)}`);

    // Temp paths
    const tempGlb = inputPath + '.temp.glb';
    const tempOptGlb = inputPath + '.opt.glb';

    try {
        // 1. Convert B3DM -> GLB
        // Using 3d-tiles-tools CLI
        execSync(`bunx 3d-tiles-tools b3dmToGlb -i "${inputPath}" -o "${tempGlb}" --force`, { stdio: 'pipe' });

        // 2. Optimize GLB (Draco + Texture Compress)
        // Using gltf-transform CLI
        // --compress draco --texture-compress webp (or jpeg/sharp)
        // Note: Draco is lossy, make sure not to verify too aggressive
        execSync(`bunx gltf-transform optimize "${tempGlb}" "${tempOptGlb}" --compress draco --texture-compress webp --simplify false`, { stdio: 'pipe' });

        // 3. Convert GLB -> B3DM
        execSync(`bunx 3d-tiles-tools glbToB3dm -i "${tempOptGlb}" -o "${outputPath}" --force`, { stdio: 'pipe' });

        console.log(`   ✅ Done`);

    } catch (e) {
        console.error(`   ❌ Failed to optimize ${inputPath}, copying original.`);
        copyFileSync(inputPath, outputPath);
    } finally {
        // Cleanup
        try {
            if (existsSync(tempGlb)) execSync(`rm "${tempGlb}"`);
            if (existsSync(tempOptGlb)) execSync(`rm "${tempOptGlb}"`);
        } catch (e) { }
    }
}

// Start processing
try {
    processDirectory(INPUT_DIR);
    console.log('\n✨ Optimization complete!');
    console.log(`👉 Point your MapViewer to: ${OUTPUT_DIR}/tileset.json`);
} catch (error) {
    console.error('Fatal error:', error);
}
