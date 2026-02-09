export function applyAnisotropyToTile(content: any, gl: WebGL2RenderingContext, maxAnisotropyCap: number = 16) {
    if (!content || !content.gltf || !content.gltf.textures) return;

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (!ext) return;

    const maxTextureAnisotropy = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    const maxAnisotropy = Math.min(maxAnisotropyCap, maxTextureAnisotropy);

    content.gltf.textures.forEach((texture: any) => {
        // Access the underlying WebGL texture from the GLTF texture object
        // The exact property depends on loaders.gl version, usually it's `texture.texture` or similar
        // But deck.gl handles GLTF loading internally. When using Tile3DLayer onTileLoad, 
        // the `tile.content` often has the processed GLTF.
        // However, usually we need to traverse materials or textures array.

        // Deck.gl's loaded GLTF structure often has `images` or `textures`
        // For luma.gl / deck.gl integration, we often need to hook into the texture creation
        // or modify the parameters after load if accessible.

        // A common pattern in deck.gl for 3d tiles is that the content is a `Tile3D` object
        // which has `content.gltf` which is the result of GLTFLoader.

        // Let's try to access the source object's texture sampler if possible
        // or the luma.gl Texture2D instance.

        // In many loaders.gl versions, the texture object itself might have a `sampler` property
        // or we might need to look at `content.gltf.json.samplers`.

        // HOWEVER, a more direct way with deck.gl/luma.gl is often:
        if (texture.texture) {
            texture.texture.setParameters({
                [ext.TEXTURE_MAX_ANISOTROPY_EXT]: maxAnisotropy
            });
        }
        // If we are dealing with raw WebGL textures (unlikely with deck.gl high level API but possible):
        // gl.bindTexture(gl.TEXTURE_2D, webglTexture);
        // gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, maxAnisotropy);
    });

    // Alternative: Traverse materials -> pbrMetallicRoughness -> baseColorTexture -> texture
    if (content.gltf.materials) {
        content.gltf.materials.forEach((material: any) => {
            if (material.pbrMetallicRoughness && material.pbrMetallicRoughness.baseColorTexture) {
                const tex = material.pbrMetallicRoughness.baseColorTexture.texture;
                if (tex && tex.texture) {
                    // luma.gl Texture2D
                    tex.texture.setParameters({
                        [ext.TEXTURE_MAX_ANISOTROPY_EXT]: maxAnisotropy
                    });
                }
            }
        });
    }
}
