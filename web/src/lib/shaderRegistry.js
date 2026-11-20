/**
 * shaderRegistry.js
 *
 * Discovers and caches shader/deck.gl extension specs from extensions.
 * Extensions declare ShaderSpec objects with GLSL source or JS module references
 * that can be applied to deck.gl layers.
 */

const _shaderCache = new Map(); // key: `${extName}/${shaderName}` -> { spec, source }

/**
 * Fetch all shader specs for an extension and cache them.
 *
 * @param {string} extName
 * @returns {Promise<object[]>} array of ShaderSpec objects
 */
export async function loadExtensionShaders(extName) {
  const response = await fetch(`/api/extensions/${encodeURIComponent(extName)}/shaders`, {
    credentials: 'include',
  });
  if (!response.ok) return [];
  const specs = await response.json();
  for (const spec of specs) {
    _shaderCache.set(`${extName}/${spec.name}`, { spec, source: null });
  }
  return specs;
}

/**
 * Fetch the GLSL source for a specific shader.
 *
 * @param {string} extName
 * @param {string} shaderName
 * @returns {Promise<string|null>} GLSL source code
 */
export async function fetchShaderSource(extName, shaderName) {
  const key = `${extName}/${shaderName}`;
  const cached = _shaderCache.get(key);
  if (cached?.source) return cached.source;

  const response = await fetch(
    `/api/extensions/${encodeURIComponent(extName)}/shaders/${encodeURIComponent(shaderName)}`,
    { credentials: 'include' },
  );
  if (!response.ok) return null;

  const source = await response.text();
  if (cached) cached.source = source;
  return source;
}

/**
 * Get all cached shader specs across all loaded extensions.
 *
 * @returns {Array<{ extName: string, spec: object }>}
 */
export function getAllShaderSpecs() {
  const result = [];
  for (const [key, { spec }] of _shaderCache) {
    const [extName] = key.split('/');
    result.push({ extName, spec });
  }
  return result;
}

/**
 * Get a cached shader spec by extension and name.
 *
 * @param {string} extName
 * @param {string} shaderName
 * @returns {{ spec: object, source: string|null }|null}
 */
export function getShaderSpec(extName, shaderName) {
  return _shaderCache.get(`${extName}/${shaderName}`) || null;
}

/**
 * Clear the shader cache.
 */
export function clearShaderCache() {
  _shaderCache.clear();
}
