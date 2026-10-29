/**
 * Live artifact preview entry point.
 *
 * This module re-exports the public API from the focused submodules:
 * - artifact_constants.js: language sets, security allow-lists, bridge script
 * - artifact_sanitize.js: markup classification and sanitization, srcdoc builder
 * - artifact_renderer.js: mermaid/graphviz rendering and DOM enhancement
 *
 * Consumers and tests should keep importing from './artifacts.js' so the
 * internal split remains an implementation detail.
 */
export { getArtifactKind } from './artifact_sanitize.js';
export { sanitizeArtifactMarkup, buildArtifactSrcDoc } from './artifact_sanitize.js';
export {
    GRAPHVIZ_CACHE_LIMIT,
    createLiveArtifactPreview,
    cleanupLiveArtifacts,
    enhanceLiveArtifacts,
    setMermaidLoaderForTest,
    setGraphvizLoaderForTest,
} from './artifact_renderer.js';
